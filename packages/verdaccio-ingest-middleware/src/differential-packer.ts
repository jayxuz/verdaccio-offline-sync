import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rm, copyFile, readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import tar from 'tar';
import { Logger } from '@verdaccio/types';
import {
  ScannedFile,
  ExportManifest,
  ExportFileEntry,
  ExportRecord,
  ExportProgress
} from './types';

/**
 * 差分打包器
 * 用于创建和解压差分导出包
 */
export class DifferentialPacker {
  private storagePath: string;
  private logger: Logger;

  constructor(storagePath: string, logger: Logger) {
    this.storagePath = storagePath;
    this.logger = logger;
  }

  /**
   * 创建导出包
   */
  async createExportPackage(
    files: ScannedFile[],
    options: {
      exportId: string;
      baseTimestamp?: Date;
      outputDir: string;
      filenamePrefix?: string;
      onProgress?: (progress: ExportProgress) => void;
    }
  ): Promise<{
    filename: string;
    path: string;
    size: number;
    checksum: string;
    manifest: ExportManifest;
  }> {
    const {
      exportId,
      baseTimestamp,
      outputDir,
      filenamePrefix = 'diff-export',
      onProgress
    } = options;

    const timestamp = new Date();
    const timestampStr = timestamp.toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}-${timestampStr}.tar.gz`;
    const outputPath = path.join(outputDir, filename);

    // 创建临时目录
    const tempDir = path.join(outputDir, `.temp-${exportId}`);
    await mkdir(tempDir, { recursive: true });

    try {
      // 阶段 1: 计算文件校验和
      this.logger.info('Calculating file checksums...');
      const filesWithChecksum: ExportFileEntry[] = [];
      let processed = 0;
      const total = files.length;

      for (const file of files) {
        const checksum = await this.calculateFileChecksum(file.absolutePath);
        filesWithChecksum.push({
          path: file.relativePath,
          size: file.size,
          mtime: file.mtime.toISOString(),
          checksum,
          type: file.type,
          packageName: file.packageName,
          version: file.version
        });

        processed++;
        if (onProgress) {
          onProgress({
            phase: 'calculating-checksums',
            phaseProgress: Math.round((processed / total) * 100),
            totalProgress: Math.round((processed / total) * 30),
            currentFile: file.relativePath,
            processed,
            total,
            startTime: timestamp.getTime(),
            phaseDescription: `计算校验和: ${file.relativePath}`
          });
        }
      }

      // 阶段 2: 复制文件到临时目录
      this.logger.info('Copying files to temp directory...');
      processed = 0;

      for (const file of files) {
        const destPath = path.join(tempDir, file.relativePath);
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(file.absolutePath, destPath);

        processed++;
        if (onProgress) {
          onProgress({
            phase: 'packing',
            phaseProgress: Math.round((processed / total) * 100),
            totalProgress: 30 + Math.round((processed / total) * 50),
            currentFile: file.relativePath,
            processed,
            total,
            startTime: timestamp.getTime(),
            phaseDescription: `复制文件: ${file.relativePath}`
          });
        }
      }

      // 计算统计信息
      const packages = new Set(files.map(f => f.packageName));
      const versions = files.filter(f => f.type === 'tarball').length;
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);

      // 创建清单文件
      const manifest: ExportManifest = {
        version: 1,
        exportId,
        timestamp: timestamp.toISOString(),
        baseTimestamp: baseTimestamp?.toISOString(),
        type: baseTimestamp ? 'incremental' : 'full',
        files: filesWithChecksum,
        stats: {
          totalFiles: files.length,
          totalSize,
          packages: packages.size,
          versions
        }
      };

      // 写入清单文件
      const manifestPath = path.join(tempDir, '.export-manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // 阶段 3: 创建 tar.gz 包
      this.logger.info('Creating tar.gz archive...');
      if (onProgress) {
        onProgress({
          phase: 'finalizing',
          phaseProgress: 0,
          totalProgress: 80,
          processed: 0,
          total: 1,
          startTime: timestamp.getTime(),
          phaseDescription: '创建压缩包...'
        });
      }

      await tar.create(
        {
          gzip: true,
          file: outputPath,
          cwd: tempDir
        },
        ['.']
      );

      // 计算最终文件的校验和和大小
      const outputStat = await stat(outputPath);
      const outputChecksum = await this.calculateFileChecksum(outputPath);

      if (onProgress) {
        onProgress({
          phase: 'completed',
          phaseProgress: 100,
          totalProgress: 100,
          processed: total,
          total,
          startTime: timestamp.getTime(),
          phaseDescription: '导出完成'
        });
      }

      this.logger.info(
        { filename, size: outputStat.size, files: files.length },
        'Export package created: @{filename} (@{size} bytes, @{files} files)'
      );

      return {
        filename,
        path: outputPath,
        size: outputStat.size,
        checksum: outputChecksum,
        manifest
      };
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
   * 生成导出记录
   */
  createExportRecord(
    exportId: string,
    filename: string,
    checksum: string,
    manifest: ExportManifest
  ): ExportRecord {
    return {
      exportId,
      timestamp: manifest.timestamp,
      timestampMs: new Date(manifest.timestamp).getTime(),
      fileCount: manifest.stats.totalFiles,
      totalSize: manifest.stats.totalSize,
      filename,
      checksum,
      type: manifest.type,
      baseTimestamp: manifest.baseTimestamp,
      summary: {
        packages: manifest.stats.packages,
        versions: manifest.stats.versions
      }
    };
  }
}