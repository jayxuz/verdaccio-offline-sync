import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rm, copyFile, readFile, writeFile, stat, access } from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import tar from 'tar';
import { Logger } from '@verdaccio/types';
import {
  ImportHistoryFile,
  ImportRecord,
  ImportResult,
  ImportOptions,
  ImportProgress,
  ExportManifest,
  ExportFileEntry
} from './types';

const IMPORT_HISTORY_FILE = '.import-history.json';
const TEMP_IMPORT_DIR = '.import-temp';

/**
 * 差分包导入处理器
 * 用于解压和导入差分导出包
 */
export class ImportHandler {
  private storagePath: string;
  private logger: Logger;

  constructor(storagePath: string, logger: Logger) {
    this.storagePath = storagePath;
    this.logger = logger;
  }

  /**
   * 导入差分包
   */
  async importPackage(
    archivePath: string,
    options: ImportOptions = {},
    onProgress?: (progress: ImportProgress) => void
  ): Promise<ImportResult> {
    const {
      overwrite = false,
      rebuildMetadata = true,
      validateChecksum = true
    } = options;

    const startTime = Date.now();
    const importId = `import-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const tempDir = path.join(this.storagePath, TEMP_IMPORT_DIR, importId);

    this.logger.info({ archivePath, importId }, 'Starting import: @{importId}');

    try {
      // 阶段 1: 解压
      if (onProgress) {
        onProgress({
          phase: 'extracting',
          phaseProgress: 0,
          totalProgress: 0,
          processed: 0,
          total: 1,
          startTime,
          phaseDescription: '解压导出包...'
        });
      }

      await mkdir(tempDir, { recursive: true });
      await tar.extract({
        file: archivePath,
        cwd: tempDir
      });

      if (onProgress) {
        onProgress({
          phase: 'extracting',
          phaseProgress: 100,
          totalProgress: 10,
          processed: 1,
          total: 1,
          startTime,
          phaseDescription: '解压完成'
        });
      }

      // 阶段 2: 读取并验证清单
      if (onProgress) {
        onProgress({
          phase: 'validating',
          phaseProgress: 0,
          totalProgress: 10,
          processed: 0,
          total: 1,
          startTime,
          phaseDescription: '验证清单...'
        });
      }

      const manifestPath = path.join(tempDir, '.export-manifest.json');
      let manifest: ExportManifest;

      try {
        const manifestContent = await readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(manifestContent);
      } catch (error) {
        throw new Error('无效的导出包：缺少或损坏的清单文件');
      }

      this.logger.info(
        { exportId: manifest.exportId, files: manifest.files.length },
        'Found manifest with @{files} files from export @{exportId}'
      );

      // 阶段 3: 验证文件校验和（可选）
      const errors: string[] = [];
      let validated = 0;

      if (validateChecksum) {
        for (const file of manifest.files) {
          const filePath = path.join(tempDir, file.path);

          try {
            const actualChecksum = await this.calculateFileChecksum(filePath);
            if (actualChecksum !== file.checksum) {
              errors.push(`校验和不匹配: ${file.path}`);
              this.logger.warn(
                { path: file.path },
                'Checksum mismatch for @{path}'
              );
            }
          } catch (error: any) {
            errors.push(`无法验证文件: ${file.path} - ${error.message}`);
          }

          validated++;
          if (onProgress) {
            const progress = Math.round((validated / manifest.files.length) * 100);
            onProgress({
              phase: 'validating',
              phaseProgress: progress,
              totalProgress: 10 + Math.round(progress * 0.2),
              currentFile: file.path,
              processed: validated,
              total: manifest.files.length,
              startTime,
              phaseDescription: `验证文件: ${file.path}`
            });
          }
        }
      }

      // 阶段 4: 导入文件
      if (onProgress) {
        onProgress({
          phase: 'importing',
          phaseProgress: 0,
          totalProgress: 30,
          processed: 0,
          total: manifest.files.length,
          startTime,
          phaseDescription: '导入文件...'
        });
      }

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const packages = new Set<string>();
      let versions = 0;

      for (const file of manifest.files) {
        const normalizedPath = this.normalizePackagePath(file.path);
        const sourcePath = path.join(tempDir, file.path);
        const destPath = path.join(this.storagePath, normalizedPath);

        try {
          // 检查目标文件是否存在
          let exists = false;
          try {
            await access(destPath);
            exists = true;
          } catch {
            exists = false;
          }

          if (exists && !overwrite) {
            skipped++;
            this.logger.debug({ path: file.path }, 'Skipping existing file: @{path}');
          } else {
            // 确保目标目录存在
            await mkdir(path.dirname(destPath), { recursive: true });
            // 复制文件
            await copyFile(sourcePath, destPath);
            imported++;

            if (file.packageName) {
              packages.add(this.normalizePackagePath(file.packageName));
            }
            if (file.type === 'tarball') {
              versions++;
            }

            this.logger.debug({ path: file.path }, 'Imported file: @{path}');
          }
        } catch (error: any) {
          failed++;
          errors.push(`导入失败: ${file.path} - ${error.message}`);
          this.logger.error(
            { path: file.path, error: error.message },
            'Failed to import @{path}: @{error}'
          );
        }

        const processed = imported + skipped + failed;
        if (onProgress) {
          const progress = Math.round((processed / manifest.files.length) * 100);
          onProgress({
            phase: 'importing',
            phaseProgress: progress,
            totalProgress: 30 + Math.round(progress * 0.6),
            currentFile: file.path,
            processed,
            total: manifest.files.length,
            startTime,
            phaseDescription: `导入文件: ${file.path}`
          });
        }
      }

      // 阶段 5: 重建元数据（可选）
      let metadataRebuilt = false;
      if (rebuildMetadata && packages.size > 0) {
        if (onProgress) {
          onProgress({
            phase: 'rebuilding',
            phaseProgress: 0,
            totalProgress: 90,
            processed: 0,
            total: packages.size,
            startTime,
            phaseDescription: '重建元数据...'
          });
        }

        // 这里只是标记需要重建，实际重建由 healer-filter 在下次请求时自动完成
        // 或者可以调用外部的重建逻辑
        metadataRebuilt = true;

        if (onProgress) {
          onProgress({
            phase: 'rebuilding',
            phaseProgress: 100,
            totalProgress: 95,
            processed: packages.size,
            total: packages.size,
            startTime,
            phaseDescription: '元数据将在下次访问时自动重建'
          });
        }
      }

      // 完成
      const result: ImportResult = {
        success: failed === 0,
        importId,
        imported,
        skipped,
        failed,
        packages: packages.size,
        versions,
        metadataRebuilt,
        errors: errors.length > 0 ? errors : undefined
      };

      // 保存导入记录
      await this.addImportRecord({
        importId,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        sourceExportId: manifest.exportId,
        fileCount: manifest.files.length,
        totalSize: manifest.stats.totalSize,
        filename: path.basename(archivePath),
        status: failed === 0 ? 'success' : (imported > 0 ? 'partial' : 'failed'),
        summary: {
          packages: packages.size,
          versions,
          skipped,
          errors: failed
        },
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined
      });

      if (onProgress) {
        onProgress({
          phase: 'completed',
          phaseProgress: 100,
          totalProgress: 100,
          processed: manifest.files.length,
          total: manifest.files.length,
          startTime,
          phaseDescription: `导入完成: ${imported} 个文件`
        });
      }

      this.logger.info(
        { importId, imported, skipped, failed },
        'Import completed: @{imported} imported, @{skipped} skipped, @{failed} failed'
      );

      return result;
    } finally {
      // 清理临时目录
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    }
  }

  /**
   * 规范化包路径，将 URL 编码的 %2f 解码为 /
   * 例如: @babel%2fcore/core-7.26.0.tgz -> @babel/core/core-7.26.0.tgz
   */
  private normalizePackagePath(p: string): string {
    return p.replace(/%2f/gi, '/');
  }

  /**
   * 计算文件 SHA256 校验和
   */
  private async calculateFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * 读取导入历史
   */
  async readImportHistory(): Promise<ImportHistoryFile> {
    const historyPath = path.join(this.storagePath, IMPORT_HISTORY_FILE);

    try {
      const content = await readFile(historyPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { version: 1, imports: [] };
      }
      throw error;
    }
  }

  /**
   * 写入导入历史
   */
  private async writeImportHistory(history: ImportHistoryFile): Promise<void> {
    const historyPath = path.join(this.storagePath, IMPORT_HISTORY_FILE);
    await writeFile(historyPath, JSON.stringify(history, null, 2));
  }

  /**
   * 添加导入记录
   */
  private async addImportRecord(record: ImportRecord): Promise<void> {
    const history = await this.readImportHistory();
    history.imports.push(record);
    // 只保留最近 100 条记录
    if (history.imports.length > 100) {
      history.imports = history.imports.slice(-100);
    }
    await this.writeImportHistory(history);
  }

  /**
   * 获取上传目录
   */
  getUploadDir(): string {
    return path.join(this.storagePath, '.uploads');
  }

  /**
   * 确保上传目录存在
   */
  async ensureUploadDir(): Promise<string> {
    const uploadDir = this.getUploadDir();
    await mkdir(uploadDir, { recursive: true });
    return uploadDir;
  }
}
