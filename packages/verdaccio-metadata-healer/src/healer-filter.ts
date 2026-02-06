import express, { Router, Express, Request, Response } from 'express';
import { pluginUtils } from '@verdaccio/core';
import { Config, Logger, Manifest } from '@verdaccio/types';
import multer from 'multer';
import { rm, readdir, stat, access } from 'fs/promises';
import { join } from 'path';
import { StorageScanner } from './storage-scanner';
import { MetadataPatcher } from './metadata-patcher';
import { ShasumCache } from './shasum-cache';
import { ImportHandler } from './import-handler';
import { MetadataSyncer, SyncResult } from './metadata-syncer';
import { getImportUIHTML } from './import-ui';
import { HealerConfig, TarballInfo, ImportTaskStatus, ImportOptions, ImportProgress } from './types';

/**
 * 同步任务状态
 */
interface SyncTaskStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  current?: number;
  total?: number;
  currentPackage?: string;
  results?: SyncResult[];
  error?: string;
}

/**
 * Verdaccio 元数据自愈过滤器插件
 * 用于内网环境下动态修复缺失的包元数据
 */
export default class MetadataHealerFilter extends pluginUtils.Plugin<HealerConfig> {
  private logger: Logger;
  private scanner!: StorageScanner;
  private patcher: MetadataPatcher;
  private shasumCache: ShasumCache;
  private storagePath: string;
  private initialized: boolean = false;
  // Import middleware 相关
  private importHandler!: ImportHandler;
  private tasks: Map<string, ImportTaskStatus> = new Map();
  private upload!: multer.Multer;
  // 元数据同步相关
  private syncer!: MetadataSyncer;
  private syncTasks: Map<string, SyncTaskStatus> = new Map();
  private upstreamRegistry: string = 'https://registry.npmmirror.com';
  // Verdaccio 存储实例
  private verdaccioStorage: any;

  constructor(config: HealerConfig, options: pluginUtils.PluginOptions) {
    super(config, options);
    this.logger = options.logger;

    // 获取存储路径，优先使用插件配置，其次使用 Verdaccio 配置
    const verdaccioConfig = options.config as any;
    this.storagePath = config.storagePath || verdaccioConfig.storage || './storage';

    this.logger.info(
      {
        storagePath: this.storagePath,
        configStoragePath: config.storagePath,
        verdaccioStorage: verdaccioConfig.storage
      },
      'MetadataHealerFilter storage path: @{storagePath} (config: @{configStoragePath}, verdaccio: @{verdaccioStorage})'
    );

    this.patcher = new MetadataPatcher(config, this.logger);
    this.shasumCache = new ShasumCache(config, this.logger);

    // 从 Verdaccio 配置中获取 uplinks
    if (verdaccioConfig.uplinks) {
      const firstUplink = Object.values(verdaccioConfig.uplinks)[0] as any;
      if (firstUplink?.url) {
        this.upstreamRegistry = firstUplink.url;
      }
    }

    this.logger.info(
      { upstreamRegistry: this.upstreamRegistry },
      'MetadataHealerFilter initialized with upstream: @{upstreamRegistry}'
    );
  }

  /**
   * 延迟初始化扫描器和同步器
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      this.logger.info(
        { storagePath: this.storagePath },
        '[ensureInitialized] Initializing with storage path: @{storagePath}'
      );

      this.scanner = new StorageScanner(
        this.config as HealerConfig,
        this.storagePath,
        this.logger
      );
      this.syncer = new MetadataSyncer(
        this.config as HealerConfig,
        this.storagePath,
        this.logger,
        this.upstreamRegistry
      );
      this.initialized = true;
    }
  }

  /**
   * 过滤并修复元数据
   * 这是 Verdaccio Filter Plugin 的核心方法
   */
  async filter_metadata(manifest: Manifest): Promise<Manifest> {
    const config = this.config as HealerConfig;

    // 检查是否启用
    if (!config.enabled) {
      return manifest;
    }

    // 确保初始化
    this.ensureInitialized();

    const packageName = manifest.name;
    const incomingVersions = Object.keys(manifest.versions || {}).length;
    const incomingDistTags = manifest['dist-tags'] || {};

    // 记录传入的元数据信息
    this.logger.info(
      {
        packageName,
        versions: incomingVersions,
        latest: incomingDistTags.latest,
        tags: Object.keys(incomingDistTags).join(', ')
      },
      '[filter_metadata] Received metadata for @{packageName}: @{versions} versions, latest: @{latest}'
    );

    try {
      // 1. 扫描存储目录中的 .tgz 文件
      const tarballs = await this.scanner.scanPackageTarballs(packageName);

      if (tarballs.length === 0) {
        // 即使没有本地 tarball，也尝试保存远端元数据
        if (config.autoSaveMetadata !== false) {
          this.saveMetadataAsync(packageName, manifest);
        }
        return manifest;
      }

      // 2. 对比元数据中的 versions，找出缺失的版本
      const missingVersions = this.findMissingVersions(manifest, tarballs);

      if (missingVersions.length === 0) {
        this.logger.debug(
          { packageName },
          'No missing versions for @{packageName}'
        );

        // 即使没有缺失版本，也检查 dist-tags
        if (config.autoUpdateLatest !== false) {
          this.patcher.updateDistTags(manifest);
        }

        // 自动保存元数据到本地
        if (config.autoSaveMetadata !== false) {
          this.saveMetadataAsync(packageName, manifest);
        }

        return manifest;
      }

      this.logger.info(
        { packageName, count: missingVersions.length },
        'Found @{count} missing versions for @{packageName}'
      );

      // 3. 动态注入缺失的版本信息
      const patchedManifest = await this.patcher.patchManifest(
        manifest,
        missingVersions,
        this.shasumCache
      );

      // 4. 更新 dist-tags
      if (config.autoUpdateLatest !== false) {
        this.patcher.updateDistTags(patchedManifest);
      }

      // 5. 自动保存修复后的元数据到本地
      if (config.autoSaveMetadata !== false) {
        this.saveMetadataAsync(packageName, patchedManifest);
      }

      this.logger.info(
        { packageName },
        'Successfully healed metadata for @{packageName}'
      );

      return patchedManifest;
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message },
        'Failed to heal metadata for @{packageName}: @{error}'
      );

      // 出错时返回原始 manifest，保证服务可用
      return manifest;
    }
  }

  /**
   * 异步保存元数据到本地文件
   * 不阻塞 filter_metadata 的返回
   * 只有当远端数据比本地数据更新时才保存
   */
  private saveMetadataAsync(packageName: string, manifest: Manifest): void {
    // 异步执行，不阻塞返回
    setImmediate(async () => {
      try {
        // 读取本地元数据
        const localMetadata = await this.syncer.readLocalMetadata(packageName);

        const remoteDistTags = manifest['dist-tags'] || {};
        const localDistTags = localMetadata?.['dist-tags'] || {};
        const remoteVersions = Object.keys(manifest.versions || {}).length;
        const localVersions = Object.keys(localMetadata?.versions || {}).length;

        this.logger.info(
          {
            packageName,
            remoteLatest: remoteDistTags.latest,
            localLatest: localDistTags.latest,
            remoteVersions,
            localVersions
          },
          '[filter_metadata] Comparing metadata for @{packageName}: remote(latest=@{remoteLatest}, versions=@{remoteVersions}) vs local(latest=@{localLatest}, versions=@{localVersions})'
        );

        // 检查是否需要更新：远端版本数更多，或者 dist-tags 不同
        const shouldUpdate =
          remoteVersions > localVersions ||
          remoteDistTags.latest !== localDistTags.latest ||
          remoteDistTags.next !== localDistTags.next;

        if (!shouldUpdate) {
          this.logger.debug(
            { packageName },
            '[filter_metadata] Skipping save for @{packageName}: local metadata is up to date'
          );
          return;
        }

        await this.syncer.saveMetadata(packageName, manifest);
        this.logger.info(
          { packageName },
          '[filter_metadata] Auto-saved metadata for @{packageName}'
        );
      } catch (error: any) {
        this.logger.error(
          { packageName, error: error.message },
          '[filter_metadata] Failed to auto-save metadata for @{packageName}: @{error}'
        );
      }
    });
  }

  /**
   * 使用 Verdaccio 存储 API 保存元数据
   * 这个方法使用 Verdaccio 内部的存储机制，可以绕过文件权限问题
   */
  private async saveMetadataViaStorage(packageName: string, metadata: Manifest): Promise<void> {
    if (!this.verdaccioStorage) {
      this.logger.warn(
        { packageName },
        '[saveMetadataViaStorage] Verdaccio storage not available, falling back to direct file write'
      );
      await this.syncer.saveMetadata(packageName, metadata);
      return;
    }

    try {
      // 获取包的存储实例
      const packageStorage = this.verdaccioStorage.getPackageStorage(packageName);

      if (!packageStorage) {
        this.logger.warn(
          { packageName },
          '[saveMetadataViaStorage] Package storage not found for @{packageName}, falling back to direct file write'
        );
        await this.syncer.saveMetadata(packageName, metadata);
        return;
      }

      // 使用 Verdaccio 的 savePackage 方法保存元数据
      await new Promise<void>((resolve, reject) => {
        packageStorage.savePackage(packageName, metadata, (err: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      this.logger.info(
        { packageName },
        '[saveMetadataViaStorage] Saved metadata for @{packageName} via Verdaccio storage API'
      );
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message },
        '[saveMetadataViaStorage] Failed to save via storage API for @{packageName}: @{error}, falling back to direct file write'
      );
      // 回退到直接文件写入
      await this.syncer.saveMetadata(packageName, metadata);
    }
  }

  /**
   * 找出元数据中缺失的版本
   */
  private findMissingVersions(
    manifest: Manifest,
    tarballs: TarballInfo[]
  ): TarballInfo[] {
    const existingVersions = new Set(Object.keys(manifest.versions || {}));
    return tarballs.filter((t) => !existingVersions.has(t.version));
  }

  /**
   * 清除缓存
   */
  clearCache(packageName?: string): void {
    if (this.initialized) {
      this.scanner.clearCache(packageName);
    }
    this.shasumCache.clear(packageName);
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { shasum: { size: number; max: number } } {
    return {
      shasum: this.shasumCache.getStats()
    };
  }

  // ==================== Import Middleware 功能 ====================

  /**
   * 注册中间件路由（Verdaccio Middleware Plugin 接口）
   * 当在 middlewares 配置中启用时会被调用
   */
  register_middlewares(app: Express, auth: any, storage: any): void {
    const config = this.config as HealerConfig;

    // 保存 Verdaccio 存储实例，用于后续保存元数据
    this.verdaccioStorage = storage;
    this.logger.info('Verdaccio storage instance saved for metadata sync');

    // 检查是否启用导入功能
    if (!config.enableImportUI) {
      this.logger.debug('Import UI is disabled');
      return;
    }

    this.importHandler = new ImportHandler(this.storagePath, this.logger);

    // 配置文件上传
    const uploadDir = this.importHandler.getUploadDir();
    this.upload = multer({
      dest: uploadDir,
      limits: {
        fileSize: 1024 * 1024 * 1024 * 10 // 10GB 限制
      },
      fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
          cb(null, true);
        } else {
          cb(new Error('只支持 .tar.gz 或 .tgz 文件'));
        }
      }
    });

    const router = Router();

    // 导入相关路由
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.post('/healer/import/upload', this.upload.single('file') as any, this.handleUpload.bind(this));
    router.post('/healer/import/local', express.json(), this.handleLocalImport.bind(this));
    router.get('/healer/import/status/:taskId', this.handleStatus.bind(this));
    router.get('/healer/import/history', this.handleHistory.bind(this));
    router.get('/healer/ui', this.handleWebUI.bind(this));

    // 元数据同步相关路由
    router.post('/healer/sync/:scope/:name', this.handleSyncPackage.bind(this));
    router.post('/healer/sync/:name', this.handleSyncPackage.bind(this));
    router.post('/healer/sync-all', this.handleSyncAll.bind(this));
    router.get('/healer/sync/status/:taskId', this.handleSyncStatus.bind(this));
    router.get('/healer/packages', this.handleListPackages.bind(this));

    app.use('/_', router);

    this.logger.info('Import middleware registered at /_/healer/ui');
    this.logger.info('Sync API registered at /_/healer/sync/:packageName');
  }

  private async handleUpload(req: Request, res: Response): Promise<void> {
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, error: '未上传文件' });
      return;
    }

    const options: ImportOptions = {
      overwrite: req.body.overwrite === 'true',
      rebuildMetadata: req.body.rebuildMetadata !== 'false',
      validateChecksum: req.body.validateChecksum !== 'false'
    };

    const taskId = this.createTask();

    this.executeImport(taskId, file.path, file.originalname, options).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      filename: file.originalname,
      message: 'Import task started'
    });
  }

  private async executeImport(
    taskId: string,
    filePath: string,
    filename: string,
    options: ImportOptions
  ): Promise<void> {
    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      const result = await this.importHandler.importPackage(
        filePath,
        options,
        (progress: ImportProgress) => {
          this.updateTask(taskId, {
            progress: progress.totalProgress,
            message: progress.phaseDescription,
            detailedProgress: progress
          });
        }
      );

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        result,
        message: `导入完成: ${result.imported} 个文件`
      });

      this.logger.info(
        { taskId, imported: result.imported },
        'Import task completed: @{imported} files imported'
      );
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      this.logger.error(
        { taskId, error: error.message },
        'Import task failed: @{error}'
      );
    } finally {
      try {
        await rm(filePath, { force: true });
      } catch {
        // 忽略清理错误
      }
    }
  }

  private async handleLocalImport(req: Request, res: Response): Promise<void> {
    const { path: filePath, overwrite, validateChecksum, rebuildMetadata } = req.body || {};

    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ success: false, error: '请提供文件路径' });
      return;
    }

    // 验证文件扩展名
    if (!filePath.endsWith('.tar.gz') && !filePath.endsWith('.tgz')) {
      res.status(400).json({ success: false, error: '只支持 .tar.gz 或 .tgz 文件' });
      return;
    }

    // 验证文件存在
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        res.status(400).json({ success: false, error: '指定路径不是文件' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, error: '文件不存在或无法访问: ' + filePath });
      return;
    }

    const options: ImportOptions = {
      overwrite: overwrite === true,
      rebuildMetadata: rebuildMetadata !== false,
      validateChecksum: validateChecksum !== false
    };

    const taskId = this.createTask();
    const filename = filePath.split('/').pop() || filePath;

    // 本地路径导入不删除源文件
    this.executeLocalImport(taskId, filePath, options).catch((error) => {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      filename,
      message: 'Local import task started'
    });
  }

  private async executeLocalImport(
    taskId: string,
    filePath: string,
    options: ImportOptions
  ): Promise<void> {
    this.updateTask(taskId, { status: 'running', progress: 0 });

    try {
      const result = await this.importHandler.importPackage(
        filePath,
        options,
        (progress: ImportProgress) => {
          this.updateTask(taskId, {
            progress: progress.totalProgress,
            message: progress.phaseDescription,
            detailedProgress: progress
          });
        }
      );

      this.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        result,
        message: `导入完成: ${result.imported} 个文件`
      });

      this.logger.info(
        { taskId, imported: result.imported },
        'Local import task completed: @{imported} files imported'
      );
    } catch (error: any) {
      this.updateTask(taskId, {
        status: 'failed',
        error: error.message
      });
      this.logger.error(
        { taskId, error: error.message },
        'Local import task failed: @{error}'
      );
    }
    // 注意：本地路径导入不删除源文件
  }

  private handleStatus(req: Request, res: Response): void {
    const { taskId } = req.params;
    const task = this.tasks.get(taskId);

    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    res.json(task);
  }

  private async handleHistory(req: Request, res: Response): Promise<void> {
    try {
      const history = await this.importHandler.readImportHistory();
      res.json({
        success: true,
        history: history.imports,
        lastImport: history.imports.length > 0
          ? history.imports[history.imports.length - 1]
          : undefined
      });
    } catch (error: any) {
      this.logger.error({ error: error.message }, 'Failed to get import history: @{error}');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private handleWebUI(req: Request, res: Response): void {
    const config = this.config as HealerConfig;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getImportUIHTML(config));
  }

  private createTask(): string {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.tasks.set(taskId, {
      taskId,
      status: 'pending'
    });
    return taskId;
  }

  private updateTask(taskId: string, updates: Partial<ImportTaskStatus>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }

  // ==================== 元数据同步功能 ====================

  /**
   * 处理单个包的同步请求
   */
  private async handleSyncPackage(req: Request, res: Response): Promise<void> {
    this.ensureInitialized();

    const { scope, name } = req.params;
    const packageName = scope ? `@${scope}/${name}` : name;

    this.logger.info(
      { packageName },
      '[Sync] Syncing metadata for @{packageName}'
    );

    try {
      const result = await this.syncer.syncPackage(packageName);

      if (result.success) {
        res.json({
          success: true,
          packageName: result.packageName,
          versionsCount: result.versionsCount,
          distTags: result.distTags,
          message: `Successfully synced ${result.versionsCount} versions`
        });
      } else {
        res.status(500).json({
          success: false,
          packageName: result.packageName,
          error: result.error
        });
      }
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message },
        '[Sync] Failed to sync @{packageName}: @{error}'
      );
      res.status(500).json({
        success: false,
        packageName,
        error: error.message
      });
    }
  }

  /**
   * 处理批量同步请求
   */
  private async handleSyncAll(req: Request, res: Response): Promise<void> {
    this.ensureInitialized();

    // 获取要同步的包列表
    let packageNames: string[] = req.body.packages || [];

    // 如果没有指定包列表，则扫描本地存储获取所有包
    if (packageNames.length === 0) {
      try {
        packageNames = await this.scanLocalPackages();
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: `Failed to scan local packages: ${error.message}`
        });
        return;
      }
    }

    if (packageNames.length === 0) {
      res.json({
        success: true,
        message: 'No packages to sync',
        results: []
      });
      return;
    }

    // 创建同步任务
    const taskId = this.createSyncTask();

    // 异步执行同步
    this.executeSyncAll(taskId, packageNames).catch((error) => {
      this.updateSyncTask(taskId, {
        status: 'failed',
        error: error.message
      });
    });

    res.json({
      success: true,
      taskId,
      totalPackages: packageNames.length,
      message: 'Sync task started'
    });
  }

  /**
   * 扫描本地存储获取所有包名
   */
  private async scanLocalPackages(): Promise<string[]> {
    const packages: string[] = [];

    try {
      const items = await readdir(this.storagePath, { withFileTypes: true });

      for (const item of items) {
        if (!item.isDirectory() || item.name.startsWith('.')) {
          continue;
        }

        if (item.name.startsWith('@')) {
          // Scoped package
          const scopePath = join(this.storagePath, item.name);
          const scopedItems = await readdir(scopePath, { withFileTypes: true });

          for (const scopedItem of scopedItems) {
            if (scopedItem.isDirectory() && !scopedItem.name.startsWith('.')) {
              packages.push(`${item.name}/${scopedItem.name}`);
            }
          }
        } else {
          // Regular package
          packages.push(item.name);
        }
      }
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        '[Sync] Failed to scan local packages: @{error}'
      );
      throw error;
    }

    return packages;
  }

  /**
   * 执行批量同步
   */
  private async executeSyncAll(taskId: string, packageNames: string[]): Promise<void> {
    this.updateSyncTask(taskId, {
      status: 'running',
      progress: 0,
      current: 0,
      total: packageNames.length
    });

    const results: SyncResult[] = [];

    for (let i = 0; i < packageNames.length; i++) {
      const packageName = packageNames[i];

      this.updateSyncTask(taskId, {
        current: i + 1,
        currentPackage: packageName,
        progress: Math.round(((i + 1) / packageNames.length) * 100)
      });

      try {
        // 使用自定义同步逻辑，通过 Verdaccio 存储 API 保存
        const result = await this.syncPackageViaStorage(packageName);
        results.push(result);
      } catch (error: any) {
        results.push({
          success: false,
          packageName,
          versionsCount: 0,
          distTags: {},
          error: error.message
        });
      }

      // 添加小延迟，避免请求过快
      if (i < packageNames.length - 1) {
        await this.delay(200);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    this.updateSyncTask(taskId, {
      status: 'completed',
      progress: 100,
      results,
      currentPackage: undefined
    });

    this.logger.info(
      { taskId, success: successCount, failed: failedCount },
      '[Sync] Sync all completed: @{success} success, @{failed} failed'
    );
  }

  /**
   * 通过 Verdaccio 存储 API 同步单个包
   */
  private async syncPackageViaStorage(packageName: string): Promise<SyncResult> {
    try {
      // 1. 从远端获取最新元数据
      const remoteMetadata = await this.syncer.fetchRemoteMetadata(packageName);

      // 2. 读取本地元数据（如果存在）
      const localMetadata = await this.syncer.readLocalMetadata(packageName);

      // 3. 合并元数据（使用 syncer 的合并逻辑）
      const mergedMetadata = this.mergeMetadataForSync(localMetadata, remoteMetadata);

      // 4. 通过 Verdaccio 存储 API 保存
      await this.saveMetadataViaStorage(packageName, mergedMetadata);

      return {
        success: true,
        packageName,
        versionsCount: Object.keys(mergedMetadata.versions || {}).length,
        distTags: mergedMetadata['dist-tags'] || {}
      };
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message },
        '[syncPackageViaStorage] Failed to sync @{packageName}: @{error}'
      );

      return {
        success: false,
        packageName,
        versionsCount: 0,
        distTags: {},
        error: error.message
      };
    }
  }

  /**
   * 合并本地和远端元数据
   */
  private mergeMetadataForSync(local: Manifest | null, remote: Manifest): Manifest {
    if (!local) {
      return remote;
    }

    // 远端元数据优先，但保留本地的 _uplinks 等信息
    const merged = { ...remote };

    // 合并版本信息（保留本地有但远端没有的版本）
    if (local.versions) {
      merged.versions = { ...local.versions, ...remote.versions };
    }

    // 保留本地的 _uplinks 信息
    if (local._uplinks) {
      merged._uplinks = {
        ...local._uplinks,
        synced: {
          etag: '',
          fetched: Date.now()
        }
      };
    }

    return merged;
  }

  /**
   * 获取同步任务状态
   */
  private handleSyncStatus(req: Request, res: Response): void {
    const { taskId } = req.params;
    const task = this.syncTasks.get(taskId);

    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    res.json(task);
  }

  /**
   * 列出本地所有包
   */
  private async handleListPackages(req: Request, res: Response): Promise<void> {
    try {
      const packages = await this.scanLocalPackages();
      res.json({
        success: true,
        count: packages.length,
        packages
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  private createSyncTask(): string {
    const taskId = `sync-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.syncTasks.set(taskId, {
      taskId,
      status: 'pending'
    });
    return taskId;
  }

  private updateSyncTask(taskId: string, updates: Partial<SyncTaskStatus>): void {
    const task = this.syncTasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
