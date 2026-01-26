import { Router, Express, Request, Response } from 'express';
import { pluginUtils } from '@verdaccio/core';
import { Config, Logger } from '@verdaccio/types';
import multer from 'multer';
import path from 'path';
import { rm } from 'fs/promises';
import { ImportHandler } from './import-handler';
import { getImportUIHTML } from './import-ui';
import {
  HealerConfig,
  ImportTaskStatus,
  ImportOptions,
  ImportProgress
} from './types';

/**
 * Verdaccio 导入中间件插件
 * 用于内网环境下导入差分包
 */
export default class ImportMiddleware extends pluginUtils.Plugin<HealerConfig> {
  private logger: Logger;
  private storagePath: string;
  private importHandler!: ImportHandler;
  private tasks: Map<string, ImportTaskStatus>;
  private upload!: multer.Multer;

  constructor(config: HealerConfig, options: pluginUtils.PluginOptions) {
    super(config, options);
    this.logger = options.logger;
    this.storagePath = config.storagePath || (options.config as Config).storage || './storage';
    this.tasks = new Map();
  }

  /**
   * 注册中间件路由
   */
  register_middlewares(app: Express, auth: any, storage: any): void {
    this.importHandler = new ImportHandler(this.storagePath, this.logger);

    // 配置文件上传
    const uploadDir = this.importHandler.getUploadDir();
    this.upload = multer({
      dest: uploadDir,
      limits: {
        fileSize: 1024 * 1024 * 1024 * 2 // 2GB 限制
      },
      fileFilter: (req, file, cb) => {
        // 只接受 .tar.gz 或 .tgz 文件
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
          cb(null, true);
        } else {
          cb(new Error('只支持 .tar.gz 或 .tgz 文件'));
        }
      }
    });

    const router = Router();

    // 上传并导入差分包
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.post('/healer/import/upload', this.upload.single('file') as any, this.handleUpload.bind(this));

    // 查询导入任务状态
    router.get('/healer/import/status/:taskId', this.handleStatus.bind(this));

    // 获取导入历史
    router.get('/healer/import/history', this.handleHistory.bind(this));

    // Web UI 管理界面
    router.get('/healer/ui', this.handleWebUI.bind(this));

    app.use('/_', router);

    this.logger.info('Import middleware registered');
  }

  /**
   * 处理文件上传和导入
   */
  private async handleUpload(req: Request, res: Response): Promise<void> {
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, error: '未上传文件' });
      return;
    }

    // 解析导入选项
    const options: ImportOptions = {
      overwrite: req.body.overwrite === 'true',
      rebuildMetadata: req.body.rebuildMetadata !== 'false',
      validateChecksum: req.body.validateChecksum !== 'false'
    };

    // 创建任务
    const taskId = this.createTask();

    // 异步执行导入
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

  /**
   * 执行导入任务
   */
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
      // 清理上传的文件
      try {
        await rm(filePath, { force: true });
      } catch {
        // 忽略清理错误
      }
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
   * 处理历史查询
   */
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

  /**
   * 处理 Web UI 请求
   */
  private handleWebUI(req: Request, res: Response): void {
    const config = this.config as HealerConfig;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getImportUIHTML(config));
  }

  /**
   * 创建任务
   */
  private createTask(): string {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.tasks.set(taskId, {
      taskId,
      status: 'pending'
    });
    return taskId;
  }

  /**
   * 更新任务状态
   */
  private updateTask(taskId: string, updates: Partial<ImportTaskStatus>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }
}
