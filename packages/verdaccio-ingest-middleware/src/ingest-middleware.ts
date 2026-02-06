import { Router, Express, Request, Response, json } from 'express';
import { pluginUtils } from '@verdaccio/core';
import { Config, Logger } from '@verdaccio/types';
import { StorageScanner } from './storage-scanner';
import { PackageDownloader } from './package-downloader';
import { DependencyResolver } from './dependency-resolver';
import { DifferentialScanner } from './differential-scanner';
import { DifferentialPacker } from './differential-packer';
import { getWebUIHTML } from './web-ui';
import {
  IngestConfig,
  IngestRequest,
  SyncRequest,
  PlatformDownloadRequest,
  SyncResult,
  CacheStatus,
  TaskStatus,
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
  ExportProgress
} from './types';

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
  // 差分导出相关
  private diffScanner!: DifferentialScanner;
  private diffPacker!: DifferentialPacker;

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
  }

  /**
   * 注册中间件路由
   */
  register_middlewares(app: Express, auth: any, storage: any): void {
    // 初始化扫描器和下载器
    this.scanner = new StorageScanner(this.config as IngestConfig, this.storagePath, this.logger);
    this.downloader = new PackageDownloader(this.config as IngestConfig, this.storagePath, this.logger);
    // 初始化差分导出相关
    this.diffScanner = new DifferentialScanner(this.storagePath, this.logger);
    this.diffPacker = new DifferentialPacker(this.storagePath, this.logger);

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
      for (const meta of refreshed) {
        try {
          const packument = await this.downloader.downloadPackument(meta.name);
          await this.downloader.savePackument(meta.name, packument);
        } catch (error: any) {
          this.logger.warn(
            { name: meta.name, error: error.message },
            'Failed to save packument for @{name}: @{error}'
          );
        }
      }

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
      updateToLatest: true,
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

      // 2. 刷新所有缓存包的元数据
      this.updateTask(taskId, { message: 'Refreshing metadata...' });
      const refreshedMetadata = await this.resolver.refreshMetadata(cachedPackages);
      this.updateTask(taskId, { progress: 30 });

      // 3. 分析依赖关系，找出缺失的包
      this.updateTask(taskId, { message: 'Analyzing dependencies...' });
      const missingPackages = await this.resolver.analyzeMissingDependencies(
        cachedPackages,
        refreshedMetadata,
        options
      );
      this.updateTask(taskId, { progress: 50 });

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
      this.updateTask(taskId, { progress: 70 });

      // 5. 下载多平台二进制包
      this.updateTask(taskId, { message: 'Downloading platform binaries...' });
      for (const pkg of cachedPackages) {
        const isBinary = await this.downloader.detectBinaryPackage(
          pkg.name,
          pkg.latestVersion || pkg.versions[0]
        );

        if (isBinary) {
          await this.downloader.downloadForPlatforms(
            pkg.name,
            pkg.latestVersion || pkg.versions[0],
            platforms
          );
        }
      }
      this.updateTask(taskId, { progress: 90 });

      // 6. 保存元数据
      this.updateTask(taskId, { message: 'Saving metadata...' });
      for (const meta of refreshedMetadata) {
        try {
          const packument = await this.downloader.downloadPackument(meta.name);
          await this.downloader.savePackument(meta.name, packument);
        } catch {
          // 忽略保存失败
        }
      }

      const result: SyncResult = {
        success: true,
        scanned: cachedPackages.length,
        refreshed: refreshedMetadata.length,
        downloaded: downloadResults.length,
        platforms: platforms.map((p) => `${p.os}-${p.arch}`)
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
      updateToLatest: true,
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

      // 2. 刷新所有缓存包的元数据（带进度回调）
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

      const refreshedMetadata = await this.resolver.refreshMetadata(
        cachedPackages,
        (progress: AnalysisProgress) => {
          this.updateTask(taskId, {
            progress: 5 + Math.round(progress.phaseProgress * 0.25), // 5-30%
            message: progress.phaseDescription,
            detailedProgress: {
              ...progress,
              totalProgress: 5 + Math.round(progress.phaseProgress * 0.25)
            }
          });
        }
      );

      // 3. 分析依赖关系（带进度回调）
      this.updateTask(taskId, {
        message: '分析依赖关系...',
        progress: 30,
        detailedProgress: {
          phase: 'analyzing',
          phaseProgress: 0,
          totalProgress: 30,
          processed: 0,
          total: cachedPackages.length,
          startTime,
          phaseDescription: '分析依赖关系...'
        }
      });

      const missingPackages = await this.resolver.analyzeMissingDependencies(
        cachedPackages,
        refreshedMetadata,
        syncOptions,
        (progress: AnalysisProgress) => {
          this.updateTask(taskId, {
            progress: 30 + Math.round(progress.phaseProgress * 0.5), // 30-80%
            message: progress.phaseDescription,
            detailedProgress: {
              ...progress,
              totalProgress: 30 + Math.round(progress.phaseProgress * 0.5)
            }
          });
        },
        startTime
      );

      // 4. 分析平台二进制包
      this.updateTask(taskId, {
        message: '检测平台二进制包...',
        progress: 80,
        detailedProgress: {
          phase: 'detecting-binaries',
          phaseProgress: 0,
          totalProgress: 80,
          processed: 0,
          total: cachedPackages.length,
          startTime,
          phaseDescription: '检测平台二进制包...'
        }
      });

      const platformPackages: PackageToDownload[] = [];
      let binaryChecked = 0;

      for (const pkg of cachedPackages) {
        binaryChecked++;
        const isBinary = await this.downloader.detectBinaryPackage(
          pkg.name,
          pkg.latestVersion || pkg.versions[0]
        );

        if (isBinary) {
          const platformDeps = await this.downloader.getPlatformDependencies(
            pkg.name,
            pkg.latestVersion || pkg.versions[0],
            targetPlatforms
          );
          for (const dep of platformDeps) {
            platformPackages.push({
              name: dep.name,
              version: dep.version,
              reason: 'platform-binary',
              requiredBy: `${pkg.name}@${pkg.latestVersion || pkg.versions[0]}`
            });
          }
        }

        // 更新进度
        const binaryProgress = Math.round((binaryChecked / cachedPackages.length) * 100);
        this.updateTask(taskId, {
          progress: 80 + Math.round(binaryProgress * 0.15), // 80-95%
          detailedProgress: {
            phase: 'detecting-binaries',
            phaseProgress: binaryProgress,
            totalProgress: 80 + Math.round(binaryProgress * 0.15),
            currentPackage: pkg.name,
            processed: binaryChecked,
            total: cachedPackages.length,
            startTime,
            phaseDescription: `检测二进制包: ${pkg.name}`
          }
        });
      }

      // 合并并去重
      const allPackages = [...missingPackages, ...platformPackages];
      const uniquePackages = this.deduplicatePackages(allPackages);

      // 生成分析ID并缓存结果
      const analysisId = `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const analysisResult: AnalysisResult = {
        analysisId,
        scanned: cachedPackages.length,
        refreshed: refreshedMetadata.length,
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

    const results: PackageDownloadStatus[] = [];
    const failedPackages: PackageToDownload[] = [];
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

            // 保存元数据
            try {
              const packument = await this.downloader.downloadPackument(pkg.name);
              await this.downloader.savePackument(pkg.name, packument);
            } catch {
              // 忽略元数据保存失败
            }
          } catch (error: any) {
            status.status = 'failed';
            status.error = error.message;
            failedPackages.push(pkg);
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

      const batchResult: DownloadBatchResult = {
        success: failedPackages.length === 0,
        total: packages.length,
        succeeded: packages.length - failedPackages.length,
        failed: failedPackages.length,
        results,
        failedPackages
      };

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
  private async handleCacheStatus(req: Request, res: Response): Promise<void> {
    try {
      const packages = await this.scanner.scanAllPackages();

      const status: CacheStatus = {
        totalPackages: packages.length,
        totalVersions: packages.reduce((sum, p) => sum + p.versions.length, 0),
        packages: packages.map((p) => ({
          name: p.name,
          versions: p.versions,
          latestCached: p.latestVersion || p.versions[p.versions.length - 1]
        }))
      };

      res.json(status);
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Cache status failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 处理重建索引请求（内网元数据修复）
   * 扫描存储目录中的所有 .tgz 文件，重建 package.json 元数据
   */
  private async handleRebuildIndex(req: Request, res: Response): Promise<void> {
    try {
      this.logger.info('Starting index rebuild...');

      // 1. 扫描所有包
      const packages = await this.scanner.scanAllPackages();
      let healed = 0;
      let tagsUpdated = 0;

      // 2. 对每个包重建元数据
      for (const pkg of packages) {
        try {
          // 读取现有的 package.json（如果存在）
          const existingPackument = await this.scanner.readPackument(pkg.name);

          // 检查是否有缺失的版本
          const existingVersions = existingPackument
            ? Object.keys(existingPackument.versions || {})
            : [];
          const missingVersions = pkg.versions.filter(
            (v) => !existingVersions.includes(v)
          );

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
                if (versionMeta && existingPackument) {
                  existingPackument.versions[version] = versionMeta;
                  healed++;
                }
              } catch (err: any) {
                this.logger.warn(
                  { name: pkg.name, version, error: err.message },
                  'Failed to extract version @{version} for @{name}: @{error}'
                );
              }
            }

            // 更新 dist-tags.latest
            if (existingPackument && pkg.versions.length > 0) {
              const sortedVersions = [...pkg.versions].sort((a, b) => {
                const semver = require('semver');
                return semver.compare(b, a);
              });
              const stableVersions = sortedVersions.filter((v) => {
                const semver = require('semver');
                return !semver.prerelease(v);
              });
              const latest = stableVersions[0] || sortedVersions[0];

              if (latest && existingPackument['dist-tags']?.latest !== latest) {
                existingPackument['dist-tags'] = existingPackument['dist-tags'] || {};
                existingPackument['dist-tags'].latest = latest;
                tagsUpdated++;
              }
            }

            // 保存更新后的 packument
            if (existingPackument) {
              await this.downloader.savePackument(pkg.name, existingPackument);
            }
          }
        } catch (err: any) {
          this.logger.warn(
            { name: pkg.name, error: err.message },
            'Failed to rebuild index for @{name}: @{error}'
          );
        }
      }

      this.logger.info(
        { scanned: packages.length, healed, tagsUpdated },
        'Index rebuild completed: scanned @{scanned}, healed @{healed}, tags updated @{tagsUpdated}'
      );

      res.json({
        success: true,
        scanned: packages.length,
        healed,
        tagsUpdated
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Index rebuild failed: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
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
