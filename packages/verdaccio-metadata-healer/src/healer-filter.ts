import { Router, Express, Request, Response } from 'express';
import { pluginUtils } from '@verdaccio/core';
import { Config, Logger, Manifest } from '@verdaccio/types';
import multer from 'multer';
import { rm } from 'fs/promises';
import { StorageScanner } from './storage-scanner';
import { MetadataPatcher } from './metadata-patcher';
import { ShasumCache } from './shasum-cache';
import { ImportHandler } from './import-handler';
import { getImportUIHTML } from './import-ui';
import { HealerConfig, TarballInfo, ImportTaskStatus, ImportOptions, ImportProgress } from './types';

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

  constructor(config: HealerConfig, options: pluginUtils.PluginOptions) {
    super(config, options);
    this.logger = options.logger;
    this.storagePath = config.storagePath || (options.config as Config).storage || './storage';
    this.patcher = new MetadataPatcher(config, this.logger);
    this.shasumCache = new ShasumCache(config, this.logger);

    this.logger.info('MetadataHealerFilter initialized');
  }

  /**
   * 延迟初始化扫描器
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      this.scanner = new StorageScanner(
        this.config as HealerConfig,
        this.storagePath,
        this.logger
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

    try {
      // 1. 扫描存储目录中的 .tgz 文件
      const tarballs = await this.scanner.scanPackageTarballs(packageName);

      if (tarballs.length === 0) {
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
        fileSize: 1024 * 1024 * 1024 * 2 // 2GB 限制
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.post('/healer/import/upload', this.upload.single('file') as any, this.handleUpload.bind(this));
    router.get('/healer/import/status/:taskId', this.handleStatus.bind(this));
    router.get('/healer/import/history', this.handleHistory.bind(this));
    router.get('/healer/ui', this.handleWebUI.bind(this));

    app.use('/_', router);

    this.logger.info('Import middleware registered at /_/healer/ui');
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
}
