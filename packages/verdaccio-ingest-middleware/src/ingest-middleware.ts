import { Router, Express, Request, Response, json } from 'express';
import { pluginUtils } from '@verdaccio/core';
import { Config, Logger } from '@verdaccio/types';
import { readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import semver from 'semver';
import { StorageScanner } from './storage-scanner';
import { PackageDownloader } from './package-downloader';
import { DependencyResolver } from './dependency-resolver';
import { DifferentialScanner } from './differential-scanner';
import { DifferentialPacker } from './differential-packer';
import { collectRangesFromPackument, selectRepairVersions } from './repair-planner';
import { getWebUIHTML } from './web-ui';
import {
  IngestConfig,
  IngestRequest,
  SyncRequest,
  PlatformDownloadRequest,
  SyncResult,
  CacheStatus,
  TaskStatus,
  CachedPackage,
  RefreshedMetadata,
  ResolvedPackage,
  PLATFORM_PRESETS,
  AnalysisResult,
  DownloadRequest,
  PackageToDownload,
  PackageDownloadStatus,
  DownloadBatchResult,
  AnalysisProgress,
  ExportPreviewRequest,
  ExportCreateRequest,
  ExportProgress,
  RepairScanRequest,
  RepairScanResult,
  RepairPlanEntry,
  RepairRequest,
  RepairResult,
  UnrepairablePackage
} from './types';

interface PackageOperationFailure {
  packageName: string;
  error: unknown;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PackageOperationBatchError extends Error {
  readonly failures: PackageOperationFailure[];

  constructor(operation: string, failures: PackageOperationFailure[]) {
    const details = failures
      .map(({ packageName, error }) => `${packageName}: ${getErrorMessage(error)}`)
      .join('; ');
    super(`${operation} failed for ${failures.length} package(s): ${details}`);
    this.name = 'PackageOperationBatchError';
    this.failures = failures;
  }
}

function throwIfPackageOperationFailed(
  operation: string,
  failures: PackageOperationFailure[]
): void {
  if (failures.length > 0) {
    throw new PackageOperationBatchError(operation, failures);
  }
}

/**
 * Verdaccio 摄取中间件插件
 * 用于外网环境下递归下载 npm 包及其依赖
 */
export default class IngestMiddleware extends pluginUtils.Plugin<IngestConfig> {
  private logger: Logger;
  private scanner!: StorageScanner;
  private downloader!: PackageDownloader;
  private resolver: DependencyResolver;
  private storagePath: string;
  private tasks: Map<string, TaskStatus>;
  // 分析结果缓存（用于分析-确认-下载工作流）
  private analysisCache: Map<string, AnalysisResult>;
  // 完整性扫描结果缓存（用于扫描-确认-修复工作流）
  private repairScanCache: Map<string, RepairScanResult>;
  // 差分导出相关
  private diffScanner!: DifferentialScanner;
  private diffPacker!: DifferentialPacker;
  // 缓存状态（/ingest/cache）扫描结果缓存：内存 + 磁盘快照，
  // 避免每次打开 UI 都对存储目录做全量扫描。
  // 注意：单测通过 Object.create(prototype) 复用实例，这些字段不做构造函数初始化，
  // 读取时一律按"可能为 undefined"做惰性兜底。
  private scanCache: { status: CacheStatus; builtAt: number } | null = null;
  private scanCacheDirty = true;
  private scanCacheSnapshotLoaded = false;
  private scanCacheRebuild: Promise<boolean> | null = null;

  constructor(config: IngestConfig, options: pluginUtils.PluginOptions) {
    super(config, options);
    this.logger = options.logger;
    this.storagePath = (options.config as Config).storage || './storage';

    // 如果未配置 upstreamRegistry，从 uplinks 中获取第一个 uplink 的 URL
    // 注意：需要同时修改 config 和 this.config，确保所有组件使用相同的 registry
    if (!config.upstreamRegistry) {
      const verdaccioConfig = options.config as Config;
      const uplinks = verdaccioConfig.uplinks;
      if (uplinks) {
        const firstUplinkKey = Object.keys(uplinks)[0];
        if (firstUplinkKey && uplinks[firstUplinkKey]?.url) {
          const upstreamUrl = uplinks[firstUplinkKey].url;
          config.upstreamRegistry = upstreamUrl;
          // 同时更新 this.config（可能是不同的引用）
          (this.config as IngestConfig).upstreamRegistry = upstreamUrl;
          this.logger.info(
            { uplink: firstUplinkKey, url: upstreamUrl },
            'Using uplink "@{uplink}" as upstream registry: @{url}'
          );
        }
      }
    }

    this.resolver = new DependencyResolver(this.config as IngestConfig, this.logger);
    this.tasks = new Map();
    this.analysisCache = new Map();
    this.repairScanCache = new Map();
  }

  /**
   * 注册中间件路由
   */
  register_middlewares(app: Express, auth: any, storage: any): void {
    // 初始化扫描器和下载器
    this.scanner = new StorageScanner(this.config as IngestConfig, this.storagePath, this.logger);
    this.downloader = new PackageDownloader(
      this.config as IngestConfig,
      this.storagePath,
      this.logger,
      storage
    );
    // 初始化差分导出相关
    const concurrency = (this.config as IngestConfig).concurrency || 5;
    this.diffScanner = new DifferentialScanner(this.storagePath, this.logger, concurrency);
    this.diffPacker = new DifferentialPacker(this.storagePath, this.logger, concurrency);

    const router = Router();

    // 添加 JSON body 解析中间件
    router.use(json());

    // 刷新已缓存包的元数据
    router.post('/ingest/refresh', this.handleRefresh.bind(this));

    // 基于缓存同步缺失依赖
    router.post('/ingest/sync', this.handleSync.bind(this));

    // 分析依赖（仅分析，不下载）
    router.post('/ingest/analyze', this.handleAnalyze.bind(this));

    // 获取分析结果
    router.get('/ingest/analysis/:analysisId', this.handleGetAnalysis.bind(this));

    // 执行下载（基于分析结果）
    router.post('/ingest/download', this.handleDownload.bind(this));

    // 重试失败的下载
    router.post('/ingest/retry', this.handleRetry.bind(this));

    // 下载指定包的多平台版本
    router.post('/ingest/platform', this.handlePlatformDownload.bind(this));

    // 查询任务状态
    router.get('/ingest/status/:taskId', this.handleStatus.bind(this));

    // 查看本地缓存状态
    router.get('/ingest/cache', this.handleCacheStatus.bind(this));

    // 重建本地索引（内网元数据修复）
    router.post('/ingest/rebuild-index', this.handleRebuildIndex.bind(this));

    // 完整性扫描（找出"有元数据但零 tarball"的残缺包）
    router.post('/ingest/repair/scan', this.handleRepairScan.bind(this));

    // 获取完整性扫描结果
    router.get('/ingest/repair/scan/:scanId', this.handleGetRepairScan.bind(this));

    // 执行修复（下载智能选取的版本）
    router.post('/ingest/repair', this.handleRepair.bind(this));

    // Web UI 管理界面
    router.get('/ingest/ui', this.handleWebUI.bind(this));

    // ==================== 差分导出相关路由 ====================
    // 获取导出历史
    router.get('/ingest/export/history', this.handleExportHistory.bind(this));

    // 预览待导出文件
    router.post('/ingest/export/preview', this.handleExportPreview.bind(this));

    // 创建导出包
    router.post('/ingest/export/create', this.handleExportCreate.bind(this));

    // 下载导出包
    router.get('/ingest/export/download/:exportId', this.handleExportDownload.bind(this));

    app.use('/_', router);

    this.logger.info('Ingest middleware registered');
  }

  /**
   * 处理刷新请求
   */
  private async handleRefresh(req: Request, res: Response): Promise<void> {
    const { packages, all } = req.body as IngestRequest;

    try {
      this.markScanCacheDirty();
      let cachedPackages = await this.scanner.scanAllPackages();

      // 如果指定了包名，只刷新指定的包
      if (packages && packages.length > 0 && !all) {
        cachedPackages = cachedPackages.filter((p) =>
          packages.includes(p.name)
        );
      }

      // 刷新元数据
      const refreshed = await this.resolver.refreshMetadata(cachedPackages);

      // 保存更新后的元数据
      await this.savePackumentsForPackages(refreshed.map((meta) => meta.name));

      res.json({
        success: true,
        refreshed: refreshed.length,
        packages: refreshed.map((m) => ({
          name: m.name,
          latest: m.distTags.latest,
          versions: m.versions.length
        }))
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Refresh failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    } finally {
      this.resolver.clearCache();
      this.downloader.clearRequestCache();
    }
  }

  /**
   * 处理同步请求
   */
  private async handleSync(req: Request, res: Response): Promise<void> {
    const { platforms, options } = req.body as SyncRequest;
    const config = this.config as IngestConfig;

    // 使用请求中的平台配置或默认配置
    const targetPlatforms = platforms || config.platforms || [
      PLATFORM_PRESETS['linux-x64'],
      PLATFORM_PRESETS['win32-x64']
    ];

    // 合并选项
    const syncOptions = {
      refreshAllMetadataBeforeAnalyze: false,
      updateToLatest: false,
      completeSiblingVersions: false,
      includeDev: false,
      includePeer: true,
      includeOptional: true,
      maxDepth: 10,
      ...config.sync,
      ...options
    };

    // 创建任务
    const taskId = this.createTask();

    // 异步执行同步
    this.executeSync(taskId, targetPlatforms, syncOptions).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      message: 'Sync task started'
    });
  }

  /**
   * 执行同步任务
   */
  private async executeSync(
    taskId: string,
    platforms: any[],
    options: any
  ): Promise<SyncResult> {
    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      // 1. 扫描本地已缓存的包
      this.updateTask(taskId, { message: 'Scanning local cache...' });
      const cachedPackages = await this.scanner.scanAllPackages();
      this.updateTask(taskId, { progress: 10 });

      // 2. 元数据准备：默认本地优先，按开关决定是否全量刷新
      const requiresGlobalMetadataRefresh = Boolean(options.refreshAllMetadataBeforeAnalyze);

      let analysisMetadata: RefreshedMetadata[] = [];
      if (requiresGlobalMetadataRefresh) {
        this.updateTask(taskId, { message: 'Refreshing metadata...' });
        analysisMetadata = await this.resolver.refreshMetadata(cachedPackages);
      } else {
        this.updateTask(taskId, { message: 'Preparing local metadata...' });
        analysisMetadata = await this.prepareLocalMetadataForAnalysis(cachedPackages);
      }
      this.updateTask(taskId, { progress: 30 });

      // 3. 分析依赖关系，找出缺失的包
      this.updateTask(taskId, { message: 'Analyzing dependencies...' });
      const missingPackages = await this.resolver.analyzeMissingDependencies(
        cachedPackages,
        analysisMetadata,
        options
      );
      this.updateTask(taskId, { progress: 50 });

      // 依赖分析完成后立即释放 packument 缓存，回收大量内存
      this.resolver.clearCache();

      // 4. 下载缺失的包
      this.updateTask(taskId, { message: 'Downloading missing packages...' });
      const packagesToDownload: ResolvedPackage[] = missingPackages.map((p) => ({
        name: p.name,
        version: p.version,
        dist: { shasum: '', tarball: '' },
        dependencies: {}
      }));

      const downloadResults = await this.downloader.downloadAll(
        packagesToDownload,
        (this.config as IngestConfig).concurrency || 5
      );
      const downloadedPackageNames = new Set<string>(
        downloadResults.map((result) => result.package.name)
      );
      this.updateTask(taskId, { progress: 70 });

      // 5. 下载多平台二进制包
      this.updateTask(taskId, { message: 'Downloading platform binaries...' });
      const binaryLimit = pLimit(this.getConcurrency());
      const binaryCandidates = this.collectPlatformCandidates(cachedPackages, missingPackages);
      let binaryProcessed = 0;
      const binaryTotal = Math.max(1, binaryCandidates.length);

      await Promise.all(
        binaryCandidates.map((candidate) =>
          binaryLimit(async () => {
            const isBinary = await this.downloader.detectBinaryPackage(
              candidate.name,
              candidate.version
            );

            if (isBinary) {
              const platformResults = await this.downloader.downloadForPlatforms(
                candidate.name,
                candidate.version,
                platforms
              );
              for (const result of platformResults) {
                downloadedPackageNames.add(result.package.name);
              }
            }

            binaryProcessed++;
            this.updateTask(taskId, {
              progress: 70 + Math.round((binaryProcessed / binaryTotal) * 20),
              message: `Downloading platform binaries (${binaryProcessed}/${binaryTotal})`
            });
          })
        )
      );
      this.updateTask(taskId, { progress: 90 });

      // 6. 保存元数据
      this.updateTask(taskId, { message: 'Saving metadata...' });
      const metadataTargets = requiresGlobalMetadataRefresh
        ? [...analysisMetadata.map((meta) => meta.name), ...Array.from(downloadedPackageNames)]
        : Array.from(downloadedPackageNames);
      const refreshedCount = await this.savePackumentsForPackages(
        metadataTargets,
        (completed, total, packageName) => {
          this.updateTask(taskId, {
            progress: 90 + Math.round((completed / Math.max(1, total)) * 10),
            message: `Saving metadata (${completed}/${total}): ${packageName}`
          });
        }
      );

      // downloadAll 内部 allSettled 会吞掉单个失败，这里通过差集还原失败列表
      const requestedSpecs = packagesToDownload.map((p) => `${p.name}@${p.version}`);
      const succeededSpecs = new Set(
        downloadResults.map((r) => `${r.package.name}@${r.package.version}`)
      );
      const downloadErrors = requestedSpecs
        .filter((spec) => !succeededSpecs.has(spec))
        .map((spec) => `download failed: ${spec}`);

      const result: SyncResult = {
        success: downloadErrors.length === 0,
        scanned: cachedPackages.length,
        refreshed: refreshedCount,
        downloaded: downloadResults.length,
        platforms: platforms.map((p) => `${p.os}-${p.arch}`),
        ...(downloadErrors.length > 0 ? { errors: downloadErrors } : {})
      };

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        result
      });

      return result;
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    } finally {
      this.resolver.clearCache();
      this.downloader.clearRequestCache();
    }
  }

  /**
   * 处理分析请求（异步任务模式，支持详细进度）
   */
  private async handleAnalyze(req: Request, res: Response): Promise<void> {
    const { platforms, options } = req.body as SyncRequest;
    const config = this.config as IngestConfig;

    const targetPlatforms = platforms || config.platforms || [
      PLATFORM_PRESETS['linux-x64'],
      PLATFORM_PRESETS['win32-x64']
    ];

    const syncOptions = {
      refreshAllMetadataBeforeAnalyze: false,
      updateToLatest: false,
      completeSiblingVersions: false,
      includeDev: false,
      includePeer: true,
      includeOptional: true,
      maxDepth: 10,
      ...config.sync,
      ...options
    };

    // 创建任务
    const taskId = this.createTask();

    // 异步执行分析
    this.executeAnalysis(taskId, targetPlatforms, syncOptions).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      message: 'Analysis task started'
    });
  }

  /**
   * 执行分析任务（带详细进度）
   */
  private async executeAnalysis(
    taskId: string,
    targetPlatforms: any[],
    syncOptions: any
  ): Promise<AnalysisResult> {
    const startTime = Date.now();

    this.updateTask(taskId, {
      status: 'running',
      progress: 0,
      detailedProgress: {
        phase: 'scanning',
        phaseProgress: 0,
        totalProgress: 0,
        processed: 0,
        total: 0,
        startTime,
        phaseDescription: '扫描本地缓存...'
      }
    });

    try {
      // 1. 扫描本地已缓存的包
      this.updateTask(taskId, {
        message: '扫描本地缓存...',
        detailedProgress: {
          phase: 'scanning',
          phaseProgress: 0,
          totalProgress: 0,
          processed: 0,
          total: 0,
          startTime,
          phaseDescription: '扫描本地缓存...'
        }
      });

      const cachedPackages = await this.scanner.scanAllPackages();

      this.updateTask(taskId, {
        progress: 5,
        detailedProgress: {
          phase: 'scanning',
          phaseProgress: 100,
          totalProgress: 5,
          processed: cachedPackages.length,
          total: cachedPackages.length,
          startTime,
          phaseDescription: `扫描完成: ${cachedPackages.length} 个包`
        }
      });

      // 2. 元数据准备：默认本地优先，按开关决定是否全量刷新
      const requiresGlobalMetadataRefresh = Boolean(syncOptions.refreshAllMetadataBeforeAnalyze);
      let analysisMetadata: RefreshedMetadata[] = [];

      if (requiresGlobalMetadataRefresh) {
        this.updateTask(taskId, {
          message: '刷新元数据...',
          detailedProgress: {
            phase: 'refreshing',
            phaseProgress: 0,
            totalProgress: 5,
            processed: 0,
            total: cachedPackages.length,
            startTime,
            phaseDescription: '刷新元数据...'
          }
        });

        analysisMetadata = await this.resolver.refreshMetadata(
          cachedPackages,
          (progress: AnalysisProgress) => {
            this.updateTask(taskId, {
              progress: 5 + Math.round(progress.phaseProgress * 0.2), // 5-25%
              message: progress.phaseDescription,
              detailedProgress: {
                ...progress,
                totalProgress: 5 + Math.round(progress.phaseProgress * 0.2)
              }
            });
          }
        );
      } else {
        this.updateTask(taskId, {
          message: '加载本地元数据...',
          detailedProgress: {
            phase: 'refreshing',
            phaseProgress: 0,
            totalProgress: 5,
            processed: 0,
            total: cachedPackages.length,
            startTime,
            phaseDescription: '加载本地元数据...'
          }
        });

        analysisMetadata = await this.prepareLocalMetadataForAnalysis(
          cachedPackages,
          (progress: AnalysisProgress) => {
            this.updateTask(taskId, {
              progress: 5 + Math.round(progress.phaseProgress * 0.2), // 5-25%
              message: progress.phaseDescription,
              detailedProgress: {
                ...progress,
                totalProgress: 5 + Math.round(progress.phaseProgress * 0.2)
              }
            });
          },
          startTime
        );
      }

      // 3. 分析依赖关系（带进度回调）
      this.updateTask(taskId, {
        message: '分析依赖关系...',
        progress: 25,
        detailedProgress: {
          phase: 'analyzing',
          phaseProgress: 0,
          totalProgress: 25,
          processed: 0,
          total: cachedPackages.length,
          startTime,
          phaseDescription: '分析依赖关系...'
        }
      });

      const missingPackages = await this.resolver.analyzeMissingDependencies(
        cachedPackages,
        analysisMetadata,
        syncOptions,
        (progress: AnalysisProgress) => {
          this.updateTask(taskId, {
            progress: 25 + Math.round(progress.phaseProgress * 0.5), // 25-75%
            message: progress.phaseDescription,
            detailedProgress: {
              ...progress,
              totalProgress: 25 + Math.round(progress.phaseProgress * 0.5)
            }
          });
        },
        startTime
      );

      let refreshedCount = 0;
      if (requiresGlobalMetadataRefresh) {
        refreshedCount = analysisMetadata.length;
      } else {
        const metadataTargets = Array.from(new Set(missingPackages.map((pkg) => pkg.name)));
        this.updateTask(taskId, {
          message: '定向更新缺口依赖元数据...',
          progress: 75,
          detailedProgress: {
            phase: 'refreshing',
            phaseProgress: 0,
            totalProgress: 75,
            processed: 0,
            total: metadataTargets.length,
            startTime,
            phaseDescription: '定向更新缺口依赖元数据...'
          }
        });

        refreshedCount = await this.savePackumentsFromResolverCache(
          metadataTargets,
          (completed, total, packageName) => {
            const ratio = total <= 0 ? 1 : completed / total;
            this.updateTask(taskId, {
              progress: 75 + Math.round(ratio * 10), // 75-85%
              message: `定向同步元数据 (${completed}/${total}): ${packageName}`,
              detailedProgress: {
                phase: 'refreshing',
                phaseProgress: Math.round(ratio * 100),
                totalProgress: 75 + Math.round(ratio * 10),
                currentPackage: packageName,
                processed: completed,
                total,
                startTime,
                phaseDescription: `定向同步元数据: ${packageName}`
              }
            });
          }
        );
      }

      // 依赖分析阶段使用的 packument 缓存在这里释放，回收内存
      this.resolver.clearCache();

      // 4. 分析平台二进制包
      this.updateTask(taskId, {
        message: '检测平台二进制包...',
        progress: 85,
        detailedProgress: {
          phase: 'detecting-binaries',
          phaseProgress: 0,
          totalProgress: 85,
          processed: 0,
          total: cachedPackages.length,
          startTime,
          phaseDescription: '检测平台二进制包...'
        }
      });

      const platformPackages: PackageToDownload[] = [];
      const binaryCandidates = this.collectPlatformCandidates(cachedPackages, missingPackages);
      let binaryChecked = 0;
      const binaryTotal = Math.max(1, binaryCandidates.length);
      const binaryLimit = pLimit(this.getConcurrency());

      await Promise.all(
        binaryCandidates.map((candidate) =>
          binaryLimit(async () => {
            const isBinary = await this.downloader.detectBinaryPackage(
              candidate.name,
              candidate.version
            );

            if (isBinary) {
              const platformDeps = await this.downloader.getPlatformDependencies(
                candidate.name,
                candidate.version,
                targetPlatforms
              );
              for (const dep of platformDeps) {
                platformPackages.push({
                  name: dep.name,
                  version: dep.version,
                  reason: 'platform-binary',
                  requiredBy: `${candidate.name}@${candidate.version}`
                });
              }
            }

            binaryChecked++;
            const binaryProgress = Math.round((binaryChecked / binaryTotal) * 100);
            this.updateTask(taskId, {
              progress: 85 + Math.round(binaryProgress * 0.1), // 85-95%
              detailedProgress: {
                phase: 'detecting-binaries',
                phaseProgress: binaryProgress,
                totalProgress: 85 + Math.round(binaryProgress * 0.1),
                currentPackage: candidate.name,
                processed: binaryChecked,
                total: binaryCandidates.length,
                startTime,
                phaseDescription: `检测二进制包: ${candidate.name}`
              }
            });
          })
        )
      );

      // 合并并去重
      const allPackages = [...missingPackages, ...platformPackages];
      const uniquePackages = this.deduplicatePackages(allPackages);

      // 生成分析ID并缓存结果
      const analysisId = `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const analysisResult: AnalysisResult = {
        analysisId,
        scanned: cachedPackages.length,
        refreshed: refreshedCount,
        toDownload: uniquePackages,
        platforms: targetPlatforms.map((p: any) => `${p.os}-${p.arch}`),
        timestamp: Date.now()
      };

      // 缓存分析结果（1小时过期）
      this.analysisCache.set(analysisId, analysisResult);
      setTimeout(() => this.analysisCache.delete(analysisId), 3600000);

      this.logger.info(
        { analysisId, toDownload: uniquePackages.length },
        'Analysis complete: @{toDownload} packages to download'
      );

      // 完成
      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        message: `分析完成: ${uniquePackages.length} 个包待下载`,
        result: analysisResult,
        detailedProgress: {
          phase: 'completed',
          phaseProgress: 100,
          totalProgress: 100,
          processed: uniquePackages.length,
          total: uniquePackages.length,
          startTime,
          phaseDescription: `分析完成: ${uniquePackages.length} 个包待下载`
        }
      });

      return analysisResult;
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    } finally {
      // 出错时也要释放缓存，防止内存泄漏
      this.resolver.clearCache();
      this.downloader.clearRequestCache();
    }
  }

  /**
   * 获取分析结果
   */
  private handleGetAnalysis(req: Request, res: Response): void {
    const { analysisId } = req.params;
    const analysis = this.analysisCache.get(analysisId);

    if (!analysis) {
      res.status(404).json({ success: false, error: 'Analysis not found or expired' });
      return;
    }

    res.json({ success: true, ...analysis });
  }

  /**
   * 处理下载请求（基于分析结果）
   */
  private async handleDownload(req: Request, res: Response): Promise<void> {
    const { analysisId, packages } = req.body as DownloadRequest;

    let packagesToDownload: PackageToDownload[];

    if (analysisId) {
      const analysis = this.analysisCache.get(analysisId);
      if (!analysis) {
        res.status(404).json({ success: false, error: 'Analysis not found or expired' });
        return;
      }
      packagesToDownload = analysis.toDownload;
    } else if (packages && packages.length > 0) {
      packagesToDownload = packages;
    } else {
      res.status(400).json({ success: false, error: 'No packages to download' });
      return;
    }

    // 创建任务
    const taskId = this.createTask();

    // 异步执行下载
    this.executeDownload(taskId, packagesToDownload).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      total: packagesToDownload.length,
      message: 'Download task started'
    });
  }

  /**
   * 执行下载任务
   */
  private async executeDownload(
    taskId: string,
    packages: PackageToDownload[]
  ): Promise<DownloadBatchResult> {
    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      const batchResult = await this.runDownloadBatches(taskId, packages);

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        result: batchResult
      });

      return batchResult;
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 分批下载核心逻辑（executeDownload 与 executeRepair 共用）
   * 负责：分批并发下载、失败收集与残留清理、完成后按包刷新元数据（回填 _distfiles）
   */
  private async runDownloadBatches(
    taskId: string,
    packages: PackageToDownload[]
  ): Promise<DownloadBatchResult> {
    const results: PackageDownloadStatus[] = [];
    const failedPackages: PackageToDownload[] = [];
    const downloadedPackageNames = new Set<string>();
    const concurrency = (this.config as IngestConfig).concurrency || 5;
    let completed = 0;

    try {
      // 分批下载
      for (let i = 0; i < packages.length; i += concurrency) {
        const batch = packages.slice(i, i + concurrency);
        const batchPromises = batch.map(async (pkg) => {
          const status: PackageDownloadStatus = {
            name: pkg.name,
            version: pkg.version,
            status: 'downloading'
          };

          try {
            const result = await this.downloader.downloadPackage(pkg.name, pkg.version);
            status.status = 'success';
            status.size = result?.size;
            status.verified = result?.verified;
            downloadedPackageNames.add(pkg.name);
          } catch (error: any) {
            status.status = 'failed';
            status.error = error.message;
            failedPackages.push(pkg);
            // 清理可能残留的损坏 tarball
            await this.downloader.cleanupTarball(pkg.name, pkg.version);
          }

          return status;
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        completed += batch.length;
        const progress = Math.round((completed / packages.length) * 100);
        this.updateTask(taskId, {
          progress,
          message: `Downloaded ${completed}/${packages.length} packages`
        });
      }

      // 所有版本下载完成后，再按包维度刷新一次元数据，避免重复请求同一包
      if (downloadedPackageNames.size > 0) {
        this.updateTask(taskId, {
          message: `Refreshing metadata for ${downloadedPackageNames.size} packages`
        });
        await this.savePackumentsForPackages(Array.from(downloadedPackageNames));
      }

      return {
        success: failedPackages.length === 0,
        total: packages.length,
        succeeded: packages.length - failedPackages.length,
        failed: failedPackages.length,
        results,
        failedPackages
      };
    } finally {
      this.downloader.clearRequestCache();
    }
  }

  /**
   * 处理重试请求
   */
  private async handleRetry(req: Request, res: Response): Promise<void> {
    const { packages } = req.body as { packages: PackageToDownload[] };

    if (!packages || packages.length === 0) {
      res.status(400).json({ success: false, error: 'No packages to retry' });
      return;
    }

    // 创建任务
    const taskId = this.createTask();

    // 异步执行下载
    this.executeDownload(taskId, packages).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      total: packages.length,
      message: 'Retry task started'
    });
  }

  private getConcurrency(): number {
    const configured = Number((this.config as IngestConfig).concurrency);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 5;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }

  private async prepareLocalMetadataForAnalysis(
    cachedPackages: CachedPackage[],
    onProgress?: (progress: AnalysisProgress) => void,
    progressStartTime?: number
  ): Promise<RefreshedMetadata[]> {
    const metadata: RefreshedMetadata[] = [];
    const limit = pLimit(this.getConcurrency());
    const startTime = progressStartTime || Date.now();
    const total = cachedPackages.length;
    let completed = 0;

    await Promise.all(
      cachedPackages.map((pkg) =>
        limit(async () => {
          try {
            const packument = await this.buildLocalPackumentForAnalysis(pkg);
            this.resolver.seedPackument(pkg.name, packument);
            metadata.push({
              name: pkg.name,
              distTags: packument['dist-tags'] || {},
              versions: Object.keys(packument.versions || {}),
              latestManifest: null
            });
          } catch (error: any) {
            this.logger.warn(
              { name: pkg.name, error: error.message },
              'Failed to prepare local metadata for @{name}: @{error}'
            );
          } finally {
            completed++;
            if (onProgress) {
              const phaseProgress = total <= 0 ? 100 : Math.round((completed / total) * 100);
              onProgress({
                phase: 'refreshing',
                phaseProgress,
                totalProgress: phaseProgress,
                currentPackage: pkg.name,
                processed: completed,
                total,
                startTime,
                phaseDescription: `加载本地元数据: ${pkg.name}`
              });
            }
          }
        })
      )
    );

    return metadata;
  }

  private async buildLocalPackumentForAnalysis(pkg: CachedPackage): Promise<any> {
    const localPackument = await this.scanner.readPackument(pkg.name);
    const localVersions = new Set(pkg.versions);

    const packument: any = {
      name: pkg.name,
      versions: {},
      'dist-tags': {}
    };

    const existingVersions =
      localPackument && typeof localPackument.versions === 'object' && localPackument.versions
        ? (localPackument.versions as Record<string, any>)
        : {};

    for (const version of pkg.versions) {
      if (existingVersions[version] && typeof existingVersions[version] === 'object') {
        packument.versions[version] = existingVersions[version];
        continue;
      }

      const extracted = await this.scanner.extractVersionFromTarball(pkg.name, version);
      if (extracted) {
        packument.versions[version] = extracted;
      }
    }

    const existingDistTags =
      localPackument &&
      typeof localPackument['dist-tags'] === 'object' &&
      localPackument['dist-tags']
        ? (localPackument['dist-tags'] as Record<string, string>)
        : {};
    for (const [tag, version] of Object.entries(existingDistTags)) {
      if (localVersions.has(version)) {
        packument['dist-tags'][tag] = version;
      }
    }

    const localLatest = this.findLatestVersion(pkg.versions);
    if (localLatest) {
      packument['dist-tags'].latest = localLatest;
    }

    return packument;
  }

  private async savePackumentsFromResolverCache(
    packageNames: string[],
    onProgress?: (completed: number, total: number, packageName: string) => void
  ): Promise<number> {
    const uniqueNames = Array.from(new Set(packageNames));
    if (uniqueNames.length === 0) {
      return 0;
    }

    const limit = pLimit(this.getConcurrency());
    let completed = 0;
    let saved = 0;
    const total = uniqueNames.length;
    const failures: PackageOperationFailure[] = [];

    await Promise.all(
      uniqueNames.map((packageName) =>
        limit(async () => {
          try {
            const cachedPackument = this.resolver.getCachedPackument(packageName);
            const packument = cachedPackument || await this.downloader.downloadPackument(packageName);
            const backfilled = this.ensureDistfilesFromVersions(packument);
            await this.downloader.savePackument(packageName, packument);
            saved++;

            if (backfilled > 0) {
              this.logger.debug(
                { packageName, count: backfilled },
                'Backfilled @{count} _distfiles entries for @{packageName}'
              );
            }
          } catch (error: any) {
            failures.push({ packageName, error });
            this.logger.warn(
              { name: packageName, error: getErrorMessage(error) },
              'Failed to save targeted packument for @{name}: @{error}'
            );
          } finally {
            completed++;
            if (onProgress) {
              onProgress(completed, total, packageName);
            }
          }
        })
      )
    );

    throwIfPackageOperationFailed('Targeted packument persistence', failures);
    return saved;
  }

  private async savePackumentsForPackages(
    packageNames: string[],
    onProgress?: (completed: number, total: number, packageName: string) => void
  ): Promise<number> {
    const uniqueNames = Array.from(new Set(packageNames));
    if (uniqueNames.length === 0) {
      return 0;
    }

    const limit = pLimit(this.getConcurrency());
    let completed = 0;
    let saved = 0;
    const total = uniqueNames.length;
    const failures: PackageOperationFailure[] = [];

    await Promise.all(
      uniqueNames.map((packageName) =>
        limit(async () => {
          try {
            const packument = await this.downloader.downloadPackument(packageName);
            const backfilled = this.ensureDistfilesFromVersions(packument);
            await this.downloader.savePackument(packageName, packument);
            saved++;

            if (backfilled > 0) {
              this.logger.debug(
                { packageName, count: backfilled },
                'Backfilled @{count} _distfiles entries for @{packageName}'
              );
            }
          } catch (error: any) {
            failures.push({ packageName, error });
            this.logger.warn(
              { name: packageName, error: getErrorMessage(error) },
              'Failed to save packument for @{name}: @{error}'
            );
          } finally {
            completed++;
            if (onProgress) {
              onProgress(completed, total, packageName);
            }
          }
        })
      )
    );

    throwIfPackageOperationFailed('Packument persistence', failures);
    return saved;
  }

  private ensureDistfilesFromVersions(packument: any): number {
    if (!packument || typeof packument !== 'object') {
      return 0;
    }

    if (!packument.versions || typeof packument.versions !== 'object') {
      return 0;
    }

    if (!packument._distfiles || typeof packument._distfiles !== 'object') {
      packument._distfiles = {};
    }

    const distfiles = packument._distfiles as Record<string, any>;
    let backfilled = 0;

    for (const versionMeta of Object.values(packument.versions as Record<string, any>)) {
      const tarball = versionMeta?.dist?.tarball;
      if (typeof tarball !== 'string' || tarball.length === 0) {
        continue;
      }

      const filename = this.extractFilenameFromTarballUrl(tarball);
      if (!filename) {
        continue;
      }

      const shasum = versionMeta?.dist?.shasum;
      const current = distfiles[filename];
      if (!current || typeof current !== 'object') {
        distfiles[filename] = {
          url: tarball,
          ...(typeof shasum === 'string' && shasum.length > 0 ? { sha: shasum } : {})
        };
        backfilled++;
        continue;
      }

      if (typeof current.url !== 'string' || current.url.length === 0) {
        current.url = tarball;
      }
      if (
        (typeof current.sha !== 'string' || current.sha.length === 0) &&
        typeof shasum === 'string' &&
        shasum.length > 0
      ) {
        current.sha = shasum;
      }
    }

    return backfilled;
  }

  private extractFilenameFromTarballUrl(tarball: string): string | null {
    const clean = tarball.split('?')[0].split('#')[0];
    const lastSlash = clean.lastIndexOf('/');
    const filename = lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
    if (!filename || !filename.endsWith('.tgz')) {
      return null;
    }
    return filename;
  }

  /**
   * 去重包列表
   */
  private deduplicatePackages(packages: PackageToDownload[]): PackageToDownload[] {
    const seen = new Map<string, PackageToDownload>();
    for (const pkg of packages) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!seen.has(key)) {
        seen.set(key, pkg);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * 平台依赖必须同时检查当前本地版本和本轮即将下载的新版本。
   * 扫描阶段读取的 dist-tag 可能仍指向旧版本，因此本地候选以实际 tarball 为准。
   */
  private collectPlatformCandidates(
    cachedPackages: CachedPackage[],
    pendingPackages: PackageToDownload[] = []
  ): Array<{ name: string; version: string }> {
    const candidates = new Map<string, { name: string; version: string }>();
    const add = (name: string, version: string | undefined) => {
      if (!version) return;
      const key = `${name}@${version}`;
      if (!candidates.has(key)) {
        candidates.set(key, { name, version });
      }
    };

    for (const pkg of cachedPackages) {
      const localLatest = this.findLatestVersion(pkg.versions);
      const metadataLatestIsLocal = pkg.latestVersion && pkg.versions.includes(pkg.latestVersion);
      add(
        pkg.name,
        localLatest || (metadataLatestIsLocal ? pkg.latestVersion : undefined) || pkg.versions[0]
      );
    }

    for (const pkg of pendingPackages) {
      add(pkg.name, pkg.version);
    }

    return Array.from(candidates.values());
  }

  /**
   * 处理多平台下载请求
   */
  private async handlePlatformDownload(req: Request, res: Response): Promise<void> {
    const { packages, platforms } = req.body as PlatformDownloadRequest;

    if (!packages || packages.length === 0) {
      res.status(400).json({ success: false, error: 'No packages specified' });
      return;
    }

    try {
      const results = [];

      for (const pkg of packages) {
        const { name, version } = this.parsePackageSpec(pkg);
        const resolvedVersion = version || 'latest';

        // 获取具体版本
        const manifest = await this.downloader.downloadPackument(name);
        const targetVersion =
          resolvedVersion === 'latest'
            ? manifest['dist-tags']?.latest
            : resolvedVersion;

        if (!targetVersion) {
          this.logger.warn({ name }, 'No version found for @{name}');
          continue;
        }

        // 下载多平台版本
        const platformResults = await this.downloader.downloadForPlatforms(
          name,
          targetVersion,
          platforms
        );

        results.push({
          name,
          version: targetVersion,
          platforms: platformResults.length
        });
      }

      res.json({
        success: true,
        results
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Platform download failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    } finally {
      this.downloader.clearRequestCache();
    }
  }

  /**
   * 处理状态查询
   */
  private handleStatus(req: Request, res: Response): void {
    const { taskId } = req.params;
    const task = this.tasks.get(taskId);

    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    res.json(task);
  }

  /**
   * 处理缓存状态查询
   */
  /**
   * 处理缓存状态请求（stale-while-revalidate）
   *
   * 全量扫描在 9p/网络挂载上非常慢（实测约 1 分钟），因此：
   * - 优先返回内存缓存；没有内存缓存时尝试读取磁盘快照（跨容器重建保留）；
   * - 缓存过期/被标脏/?force=1 时后台重建并立即返回旧数据；
   * - 仅在完全没有任何数据（首次运行）时同步等待首次扫描。
   */
  private async handleCacheStatus(req: Request, res: Response): Promise<void> {
    try {
      if (!this.scanCache && this.scanCacheSnapshotLoaded !== true) {
        this.scanCacheSnapshotLoaded = true;
        await this.loadScanCacheSnapshot();
      }

      const cached = this.scanCache || null;
      const dirty = this.scanCacheDirty !== false;
      const fresh =
        !!cached && !dirty && Date.now() - cached.builtAt < this.getScanCacheTtlMs();
      const force = req.query?.force === '1' || req.query?.force === 'true';

      if (force || !fresh) {
        const rebuild = this.rebuildScanCache();
        if (!cached) {
          // 冷启动（无内存缓存也无磁盘快照）：没有可展示的数据，同步等待
          await rebuild;
        }
      }

      const current = this.scanCache || null;
      const rebuilding = this.scanCacheRebuild != null;
      if (!current) {
        res.json({
          success: true,
          totalPackages: 0,
          totalVersions: 0,
          packages: [],
          builtAt: null,
          stale: true,
          rebuilding
        });
        return;
      }

      const servedFresh =
        !rebuilding &&
        this.scanCacheDirty === false &&
        Date.now() - current.builtAt < this.getScanCacheTtlMs();

      res.json({
        success: true,
        ...current.status,
        builtAt: current.builtAt,
        stale: !servedFresh,
        rebuilding
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Cache status failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private getScanCacheTtlMs(): number {
    const configured = Number((this.config as IngestConfig).scanCacheTtlSeconds);
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : 600;
    return seconds * 1000;
  }

  private getScanCacheSnapshotPath(): string {
    return path.join(this.storagePath, '.ingest-scan-cache.json');
  }

  /**
   * 任何会改动存储内容的操作都应调用，使扫描缓存失效，
   * 下一次 /ingest/cache 请求将触发后台重建。
   */
  private markScanCacheDirty(): void {
    this.scanCacheDirty = true;
  }

  private async buildCacheStatus(): Promise<CacheStatus> {
    const packages = await this.scanner.scanAllPackages();

    return {
      totalPackages: packages.length,
      totalVersions: packages.reduce((sum, p) => sum + p.versions.length, 0),
      packages: packages.map((p) => ({
        name: p.name,
        versions: p.versions,
        latestCached: p.latestVersion || p.versions[p.versions.length - 1]
      }))
    };
  }

  /**
   * 单-flight 重建扫描缓存并持久化快照；并发调用共享同一次扫描。
   * 返回最终是否有可用缓存（重建失败时保留旧缓存）。
   */
  private rebuildScanCache(): Promise<boolean> {
    if (this.scanCacheRebuild) {
      return this.scanCacheRebuild;
    }

    // 在重建开始时清除脏标记：若重建期间再次标脏，下次请求会再触发一轮
    this.scanCacheDirty = false;

    const rebuild = (async () => {
      try {
        const status = await this.buildCacheStatus();
        this.scanCache = { status, builtAt: Date.now() };
        await this.persistScanCacheSnapshot();
        return true;
      } catch (error: any) {
        this.logger.warn(
          { error: error?.message },
          'Failed to rebuild scan cache: @{error}'
        );
        return this.scanCache != null;
      } finally {
        this.scanCacheRebuild = null;
      }
    })();

    this.scanCacheRebuild = rebuild;
    return rebuild;
  }

  private async persistScanCacheSnapshot(): Promise<void> {
    if (!this.scanCache) {
      return;
    }

    const snapshotPath = this.getScanCacheSnapshotPath();
    const tmpPath = `${snapshotPath}.tmp-${process.pid}`;
    try {
      await writeFile(tmpPath, JSON.stringify(this.scanCache));
      await rename(tmpPath, snapshotPath);
    } catch (error: any) {
      this.logger.warn(
        { error: error?.message },
        'Failed to persist scan cache snapshot: @{error}'
      );
    }
  }

  private async loadScanCacheSnapshot(): Promise<boolean> {
    try {
      const raw = await readFile(this.getScanCacheSnapshotPath(), 'utf-8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.builtAt === 'number' &&
        parsed.status &&
        Array.isArray(parsed.status.packages)
      ) {
        this.scanCache = parsed;
        // 快照本身就是一次已完成扫描的结果，不属于"待重建"状态；
        // 是否重建仅由 TTL 决定
        this.scanCacheDirty = false;
        return true;
      }
    } catch {
      // 快照不存在或损坏：按无快照处理
    }
    return false;
  }

  /**
   * 处理重建索引请求（内网元数据修复）
   * 扫描存储目录中的所有 .tgz 文件，重建 package.json 元数据
   */
  private async handleRebuildIndex(req: Request, res: Response): Promise<void> {
    try {
      this.markScanCacheDirty();
      this.logger.info('Starting index rebuild...');

      // 1. 扫描所有包
      const packages = await this.scanner.scanAllPackages();
      let healed = 0;
      let tagsUpdated = 0;
      let created = 0;
      let distfilesBackfilled = 0;
      const failures: PackageOperationFailure[] = [];

      // 2. 对每个包重建元数据
      for (const pkg of packages) {
        try {
          // 读取现有的 package.json（如果不存在则创建基础结构）
          const existingPackument = await this.scanner.readPackument(pkg.name);
          const packument: any = existingPackument || {
            name: pkg.name,
            versions: {},
            'dist-tags': {},
            _attachments: {},
            time: {}
          };
          if (!existingPackument) {
            created++;
          }

          const existingVersions = new Set(Object.keys(packument.versions || {}));
          const missingVersions = pkg.versions.filter((v) => !existingVersions.has(v));
          let changed = !existingPackument;

          if (missingVersions.length > 0) {
            this.logger.info(
              { name: pkg.name, missing: missingVersions.length },
              'Healing @{missing} missing versions for @{name}'
            );

            // 从 tarball 中提取元数据并添加到 packument
            for (const version of missingVersions) {
              try {
                const versionMeta = await this.scanner.extractVersionFromTarball(
                  pkg.name,
                  version
                );
                if (versionMeta) {
                  packument.versions = packument.versions || {};
                  packument.versions[version] = versionMeta;
                  healed++;
                  changed = true;
                }
              } catch (err: any) {
                this.logger.warn(
                  { name: pkg.name, version, error: err.message },
                  'Failed to extract version @{version} for @{name}: @{error}'
                );
              }
            }
          }

          // 无论是否有缺失版本，都修正 latest 为本地可用的最高版本
          const localLatest = this.findLatestVersion(pkg.versions);
          const currentLatest = packument['dist-tags']?.latest;
          if (localLatest && currentLatest !== localLatest) {
            packument['dist-tags'] = packument['dist-tags'] || {};
            packument['dist-tags'].latest = localLatest;
            tagsUpdated++;
            changed = true;
          }

          const backfilled = this.ensureDistfilesFromVersions(packument);
          if (backfilled > 0) {
            distfilesBackfilled += backfilled;
            changed = true;
          }

          if (changed) {
            packument.time = packument.time || {};
            packument.time.modified = new Date().toISOString();

            if (Object.keys(packument.versions || {}).length > 0) {
              await this.downloader.savePackument(pkg.name, packument);
            }
          }
        } catch (err: any) {
          failures.push({ packageName: pkg.name, error: err });
          this.logger.warn(
            { name: pkg.name, error: getErrorMessage(err) },
            'Failed to rebuild index for @{name}: @{error}'
          );
        }
      }

      throwIfPackageOperationFailed('Index rebuild', failures);

      this.logger.info(
        { scanned: packages.length, healed, tagsUpdated, created, distfilesBackfilled },
        'Index rebuild completed: scanned @{scanned}, healed @{healed}, tags updated @{tagsUpdated}, created @{created}, distfiles backfilled @{distfilesBackfilled}'
      );

      res.json({
        success: true,
        scanned: packages.length,
        healed,
        tagsUpdated,
        created,
        distfilesBackfilled
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Index rebuild failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private findLatestVersion(versions: string[]): string | undefined {
    const validVersions = versions.filter((version) => semver.valid(version));
    if (validVersions.length === 0) {
      return undefined;
    }

    const stableVersions = validVersions.filter((version) => !semver.prerelease(version));
    const candidates = stableVersions.length > 0 ? stableVersions : validVersions;
    return candidates.sort(semver.rcompare)[0];
  }

  /**
   * 处理完整性扫描请求
   */
  private async handleRepairScan(req: Request, res: Response): Promise<void> {
    const { options } = req.body as RepairScanRequest;

    const taskId = this.createTask();

    this.executeRepairScan(taskId, options || {}).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      message: 'Repair scan task started'
    });
  }

  /**
   * 执行完整性扫描：找出"有元数据但零 tarball"的残缺包，并智能选取待修复版本
   * 全程只读本地存储，不请求上游
   */
  private async executeRepairScan(
    taskId: string,
    options: {
      includeDependents?: boolean;
      includePrerelease?: boolean;
      versionScope?: 'smart' | 'latest';
    }
  ): Promise<RepairScanResult> {
    const startTime = Date.now();
    const versionScope = options.versionScope || 'latest';
    // latest 模式不需要依赖命中分析，跳过正常包的 packument 遍历（提速关键）
    const includeDependents =
      versionScope !== 'latest' && options.includeDependents !== false;

    this.updateTask(taskId, {
      status: 'running',
      progress: 0,
      detailedProgress: {
        phase: 'scanning',
        phaseProgress: 0,
        totalProgress: 0,
        processed: 0,
        total: 0,
        startTime,
        phaseDescription: '扫描存储完整性...'
      }
    });

    try {
      // 1. 目录级完整性探测（0-40%）
      const integrity = await this.scanner.scanAllPackageIntegrity(
        (processed, total, current) => {
          const phaseProgress = total <= 0 ? 100 : Math.round((processed / total) * 100);
          this.updateTask(taskId, {
            progress: Math.round(phaseProgress * 0.4),
            detailedProgress: {
              phase: 'scanning',
              phaseProgress,
              totalProgress: Math.round(phaseProgress * 0.4),
              currentPackage: current,
              processed,
              total,
              startTime,
              phaseDescription: `扫描存储完整性 (${processed}/${total}): ${current}`
            }
          });
        }
      );

      // 残缺 = 有元数据但零有效 tarball；无元数据的空目录单独报告
      const incomplete = integrity.filter(
        (info) => info.tarballVersions.length === 0 && info.hasMetadata
      );
      const unrepairable: UnrepairablePackage[] = integrity
        .filter((info) => info.tarballVersions.length === 0 && !info.hasMetadata)
        .map((info) => ({ name: info.name, reason: 'package.json 缺失或损坏' }));
      const incompleteNames = new Set(incomplete.map((info) => info.name));
      const incompleteCount = incomplete.length;
      const healthyCount = integrity.filter((info) => info.tarballVersions.length > 0).length;

      // 2. 遍历有元数据的包（40-90%）：
      //    残缺包保留 versions/dist-tags 供选版；
      //    smart 模式下正常包收集对残缺包的依赖范围（latest 模式跳过以提速）
      const dependentRanges = new Map<string, Set<string>>();
      const incompletePackuments = new Map<string, any>();
      const metadataHolders = includeDependents
        ? integrity.filter((info) => info.hasMetadata)
        : incomplete;
      const limit = pLimit(this.getConcurrency());
      let processed = 0;
      const total = metadataHolders.length;

      await Promise.all(
        metadataHolders.map((info) =>
          limit(async () => {
            try {
              const packument = await this.scanner.readPackument(info.name);
              if (packument) {
                if (incompleteNames.has(info.name)) {
                  incompletePackuments.set(info.name, {
                    versions: (packument as any).versions || {},
                    'dist-tags': (packument as any)['dist-tags'] || {}
                  });
                } else if (includeDependents) {
                  collectRangesFromPackument(packument, incompleteNames, dependentRanges);
                }
              }
            } catch (error: any) {
              this.logger.warn(
                { name: info.name, error: getErrorMessage(error) },
                'Failed to read packument for @{name} during repair scan: @{error}'
              );
            } finally {
              processed++;
              const phaseProgress = total <= 0 ? 100 : Math.round((processed / total) * 100);
              this.updateTask(taskId, {
                progress: 40 + Math.round(phaseProgress * 0.5),
                detailedProgress: {
                  phase: 'analyzing',
                  phaseProgress,
                  totalProgress: 40 + Math.round(phaseProgress * 0.5),
                  currentPackage: info.name,
                  processed,
                  total,
                  startTime,
                  phaseDescription: `分析依赖命中 (${processed}/${total}): ${info.name}`
                }
              });
            }
          })
        )
      );

      // 3. 智能选取待下载版本（90-100%）
      const plans: RepairPlanEntry[] = [];
      for (const info of incomplete) {
        const packument = incompletePackuments.get(info.name);
        if (!packument) {
          unrepairable.push({ name: info.name, reason: '无法读取本地元数据' });
          continue;
        }

        const selectedVersions = selectRepairVersions(
          packument,
          dependentRanges.get(info.name) || [],
          {
            includePrerelease: options.includePrerelease === true,
            versionScope
          }
        );

        if (selectedVersions.length === 0) {
          unrepairable.push({
            name: info.name,
            reason:
              versionScope === 'latest'
                ? '元数据中没有 dist-tags.latest 指向的有效版本'
                : '元数据中没有可选版本（可能全部为 prerelease）'
          });
          continue;
        }

        plans.push({
          name: info.name,
          metadataVersionCount: Object.keys(packument.versions).length,
          selectedVersions
        });
      }

      const totalVersionsToDownload = plans.reduce(
        (sum, plan) => sum + plan.selectedVersions.length,
        0
      );

      const result: RepairScanResult = {
        scanId: `repair-scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        scanned: integrity.length,
        healthy: healthyCount,
        incompleteCount,
        totalVersionsToDownload,
        plans,
        unrepairable,
        options: {
          includeDependents,
          includePrerelease: options.includePrerelease === true,
          versionScope
        },
        timestamp: Date.now()
      };

      // 缓存扫描结果（1小时过期，仿 analysisCache）
      this.repairScanCache.set(result.scanId, result);
      setTimeout(() => this.repairScanCache.delete(result.scanId), 3600000).unref();

      this.logger.info(
        { scanId: result.scanId, incomplete: incompleteCount, toDownload: totalVersionsToDownload },
        'Repair scan complete: @{incomplete} incomplete packages, @{toDownload} versions to download'
      );

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        message: `完整性扫描完成: ${incompleteCount} 个残缺包，待下载 ${totalVersionsToDownload} 个版本`,
        result,
        detailedProgress: {
          phase: 'completed',
          phaseProgress: 100,
          totalProgress: 100,
          processed: total,
          total,
          startTime,
          phaseDescription: `扫描完成: ${incompleteCount} 个残缺包，待下载 ${totalVersionsToDownload} 个版本`
        }
      });

      return result;
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 获取完整性扫描结果
   */
  private handleGetRepairScan(req: Request, res: Response): void {
    const { scanId } = req.params;
    const scan = this.repairScanCache.get(scanId);

    if (!scan) {
      res.status(404).json({ success: false, error: 'Repair scan not found or expired' });
      return;
    }

    res.json({ success: true, ...scan });
  }

  /**
   * 处理修复请求（基于扫描结果或显式包列表）
   */
  private async handleRepair(req: Request, res: Response): Promise<void> {
    const { scanId, packages } = req.body as RepairRequest;

    let packagesToRepair: PackageToDownload[];

    if (scanId) {
      const scan = this.repairScanCache.get(scanId);
      if (!scan) {
        res.status(404).json({ success: false, error: 'Repair scan not found or expired' });
        return;
      }
      packagesToRepair = scan.plans.flatMap((plan) =>
        plan.selectedVersions.map((selected) => ({
          name: plan.name,
          version: selected.version,
          reason: 'integrity-repair' as const
        }))
      );
    } else if (packages && packages.length > 0) {
      packagesToRepair = packages;
    } else {
      res.status(400).json({ success: false, error: 'No packages to repair' });
      return;
    }

    if (packagesToRepair.length === 0) {
      res.status(400).json({ success: false, error: 'No versions selected to repair' });
      return;
    }

    const taskId = this.createTask();

    this.executeRepair(taskId, packagesToRepair).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      total: packagesToRepair.length,
      message: 'Repair task started'
    });
  }

  /**
   * 执行修复任务：复用分批下载，404 类失败单独分类（上游已下架，重试无效）
   */
  private async executeRepair(
    taskId: string,
    packages: PackageToDownload[]
  ): Promise<RepairResult> {
    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      const batch = await this.runDownloadBatches(taskId, packages);

      for (const status of batch.results) {
        if (status.status === 'failed' && this.isUpstreamMissingError(status.error)) {
          status.upstreamMissing = true;
        }
      }

      const missingKeys = new Set(
        batch.results
          .filter((r) => r.upstreamMissing)
          .map((r) => `${r.name}@${r.version}`)
      );

      const result: RepairResult = {
        ...batch,
        repairedPackages: new Set(
          batch.results.filter((r) => r.status === 'success').map((r) => r.name)
        ).size,
        upstreamMissing: batch.failedPackages.filter((pkg) =>
          missingKeys.has(`${pkg.name}@${pkg.version}`)
        )
      };

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        result
      });

      return result;
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 判断下载失败是否为"上游不存在/已下架"（此类重试无效）
   */
  private isUpstreamMissingError(message?: string): boolean {
    return !!message && /404|no matching version|not found/i.test(message);
  }

  /**
   * 处理 Web UI 请求
   */
  private handleWebUI(req: Request, res: Response): void {
    const config = this.config as IngestConfig;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getWebUIHTML(config));
  }

  /**
   * 创建任务
   */
  private createTask(): string {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.tasks.set(taskId, {
      taskId,
      status: 'pending'
    });
    return taskId;
  }

  /**
   * 更新任务状态
   */
  private updateTask(taskId: string, updates: Partial<TaskStatus>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
      // 任务完成意味着存储内容可能已变化（下载/分析/修复/导出等），
      // 统一在这里使扫描缓存失效，由下一次 /ingest/cache 请求后台重建
      if (updates.status === 'completed') {
        this.markScanCacheDirty();
      }
    }
  }

  /**
   * 解析包规格
   */
  private parsePackageSpec(spec: string): { name: string; version?: string } {
    if (spec.startsWith('@')) {
      const lastAtIndex = spec.lastIndexOf('@');
      if (lastAtIndex > 0) {
        return {
          name: spec.substring(0, lastAtIndex),
          version: spec.substring(lastAtIndex + 1)
        };
      }
      return { name: spec };
    }

    const atIndex = spec.lastIndexOf('@');
    if (atIndex > 0) {
      return {
        name: spec.substring(0, atIndex),
        version: spec.substring(atIndex + 1)
      };
    }
    return { name: spec };
  }

  // ==================== 差分导出相关方法 ====================

  /**
   * 处理获取导出历史请求
   */
  private async handleExportHistory(req: Request, res: Response): Promise<void> {
    try {
      const history = await this.diffScanner.readExportHistory();
      const lastExport = history.exports.length > 0
        ? history.exports[history.exports.length - 1]
        : undefined;

      res.json({
        success: true,
        history: history.exports,
        lastExport
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to get export history: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 处理导出预览请求
   */
  private async handleExportPreview(req: Request, res: Response): Promise<void> {
    const { since, includeMetadata = true } = req.body as ExportPreviewRequest;

    try {
      let baseTimestamp: Date | undefined;

      if (since === 'last') {
        baseTimestamp = await this.diffScanner.getLastExportTimestamp() || undefined;
      } else if (since) {
        baseTimestamp = new Date(since);
      }

      const files = await this.diffScanner.scanModifiedFiles({
        since: baseTimestamp,
        includeMetadata
      });

      const stats = this.diffScanner.calculateStats(files);
      const entries = this.diffScanner.scannedFilesToEntries(files);

      res.json({
        success: true,
        baseTimestamp: baseTimestamp?.toISOString(),
        files: entries,
        stats
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to preview export: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 处理创建导出包请求
   */
  private async handleExportCreate(req: Request, res: Response): Promise<void> {
    const { since, includeMetadata = true, filenamePrefix } = req.body as ExportCreateRequest;

    try {
      let baseTimestamp: Date | undefined;

      if (since === 'last') {
        baseTimestamp = await this.diffScanner.getLastExportTimestamp() || undefined;
      } else if (since) {
        baseTimestamp = new Date(since);
      }

      // 创建任务
      const taskId = this.createTask();
      const exportId = `export-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // 异步执行导出
      this.executeExport(taskId, exportId, {
        baseTimestamp,
        includeMetadata,
        filenamePrefix
      }).catch((error) => {
        this.updateTask(taskId, {
          status: 'failed',
          error: error.message
        });
      });

      res.json({
        success: true,
        taskId,
        exportId,
        message: 'Export task started'
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to create export: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 执行导出任务
   */
  private async executeExport(
    taskId: string,
    exportId: string,
    options: {
      baseTimestamp?: Date;
      includeMetadata?: boolean;
      filenamePrefix?: string;
    }
  ): Promise<void> {
    const { baseTimestamp, includeMetadata = true, filenamePrefix } = options;

    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      // 扫描文件
      this.updateTask(taskId, {
        message: '扫描文件...',
        detailedProgress: {
          phase: 'scanning',
          phaseProgress: 0,
          totalProgress: 0,
          processed: 0,
          total: 0,
          startTime: Date.now(),
          phaseDescription: '扫描文件...'
        }
      });

      const files = await this.diffScanner.scanModifiedFiles({
        since: baseTimestamp,
        includeMetadata
      });

      if (files.length === 0) {
        this.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          message: '没有需要导出的文件',
          result: {
            exportId,
            filename: null,
            downloadUrl: null,
            fileSize: 0,
            stats: { totalFiles: 0, totalSize: 0, packages: 0, versions: 0 }
          }
        });
        return;
      }

      // 确保导出目录存在
      const outputDir = await this.diffScanner.ensureExportsDir();

      // 创建导出包
      const result = await this.diffPacker.createExportPackage(files, {
        exportId,
        baseTimestamp,
        outputDir,
        filenamePrefix,
        onProgress: (progress: ExportProgress) => {
          this.updateTask(taskId, {
            progress: progress.totalProgress,
            message: progress.phaseDescription,
            detailedProgress: progress
          });
        }
      });

      // 保存导出记录
      const record = this.diffPacker.createExportRecord(
        exportId,
        result.filename,
        result.checksum,
        result.manifest
      );
      await this.diffScanner.addExportRecord(record);

      // 完成
      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        message: `导出完成: ${result.filename}`,
        result: {
          exportId,
          filename: result.filename,
          downloadUrl: `/_/ingest/export/download/${exportId}`,
          fileSize: result.size,
          stats: result.manifest.stats
        }
      });

      this.logger.info(
        { exportId, filename: result.filename, files: files.length },
        'Export completed: @{filename} with @{files} files'
      );
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 处理下载导出包请求
   */
  private async handleExportDownload(req: Request, res: Response): Promise<void> {
    const { exportId } = req.params;

    try {
      const history = await this.diffScanner.readExportHistory();
      const record = history.exports.find(e => e.exportId === exportId);

      if (!record) {
        res.status(404).json({ success: false, error: 'Export not found' });
        return;
      }

      const filePath = require('path').join(
        this.diffScanner.getExportsDir(),
        record.filename
      );

      // 检查文件是否存在
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ success: false, error: 'Export file not found' });
        return;
      }

      // 设置响应头
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);

      // 流式发送文件
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to download export: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }
}
