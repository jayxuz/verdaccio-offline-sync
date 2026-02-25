import { readdir, stat, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { Logger } from '@verdaccio/types';
import {
  ExportHistoryFile,
  ExportRecord,
  ScannedFile,
  ExportFileEntry
} from './types';

const EXPORT_HISTORY_FILE = '.export-history.json';
const EXPORTS_DIR = '.exports';

/**
 * 差分文件扫描器
 * 用于扫描 storage 目录中自指定时间点以来修改的文件
 */
export class DifferentialScanner {
  private storagePath: string;
  private logger: Logger;

  constructor(storagePath: string, logger: Logger) {
    this.storagePath = storagePath;
    this.logger = logger;
  }

  /**
   * 扫描自指定时间以来修改的文件
   */
  async scanModifiedFiles(options: {
    since?: Date;
    includeMetadata?: boolean;
  }): Promise<ScannedFile[]> {
    const { since, includeMetadata = true } = options;
    const files: ScannedFile[] = [];

    this.logger.info(
      { since: since?.toISOString(), includeMetadata },
      'Scanning modified files since @{since}'
    );

    await this.scanDirectory('', files, since, includeMetadata);

    this.logger.info(
      { count: files.length },
      'Found @{count} modified files'
    );

    return files;
  }

  /**
   * 递归扫描目录
   */
  private async scanDirectory(
    relativePath: string,
    files: ScannedFile[],
    since?: Date,
    includeMetadata?: boolean
  ): Promise<void> {
    const absolutePath = path.join(this.storagePath, relativePath);

    try {
      const entries = await readdir(absolutePath, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelativePath = relativePath
          ? path.join(relativePath, entry.name)
          : entry.name;
        const entryAbsolutePath = path.join(absolutePath, entry.name);

        // 跳过隐藏文件和目录
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isDirectory()) {
          // 递归扫描子目录（使用原始路径以匹配实际文件系统）
          await this.scanDirectory(entryRelativePath, files, since, includeMetadata);
        } else if (entry.isFile()) {
          // 检查文件类型
          const fileType = this.getFileType(entry.name);
          if (!fileType) continue;

          // 如果不包含元数据，跳过 package.json
          if (!includeMetadata && fileType === 'metadata') continue;

          // 获取文件信息
          const fileStat = await stat(entryAbsolutePath);

          // 检查修改时间
          if (since && fileStat.mtime <= since) continue;

          // 规范化路径：将 %2f 解码为 /，确保 scoped 包使用嵌套目录结构
          const normalizedRelativePath = this.normalizePackagePath(entryRelativePath);

          // 解析包名和版本（使用规范化后的路径）
          const packageName = this.extractPackageName(
            this.normalizePackagePath(relativePath)
          );
          const version = fileType === 'tarball'
            ? this.extractVersionFromFilename(packageName, entry.name)
            : undefined;

          files.push({
            relativePath: normalizedRelativePath,
            absolutePath: entryAbsolutePath,
            size: fileStat.size,
            mtime: fileStat.mtime,
            type: fileType,
            packageName,
            version
          });
        }
      }
    } catch (error: any) {
      this.logger.warn(
        { path: absolutePath, error: error.message },
        'Failed to scan directory @{path}: @{error}'
      );
    }
  }

  /**
   * 规范化包路径，将 URL 编码的 %2f 解码为 /
   * 例如: @babel%2fcore -> @babel/core
   */
  private normalizePackagePath(p: string): string {
    return p.replace(/%2f/gi, '/');
  }

  /**
   * 获取文件类型
   */
  private getFileType(filename: string): 'tarball' | 'metadata' | null {
    if (filename.endsWith('.tgz')) {
      return 'tarball';
    }
    if (filename === 'package.json') {
      return 'metadata';
    }
    return null;
  }

  /**
   * 从目录路径提取包名
   */
  private extractPackageName(relativePath: string): string {
    const parts = relativePath.split(path.sep);
    // 处理 scoped 包：嵌套结构 @scope/package -> 取前两段
    if (parts[0] && parts[0].startsWith('@') && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return parts[0] || relativePath;
  }

  /**
   * 从文件名提取版本号
   */
  private extractVersionFromFilename(
    packageName: string,
    filename: string
  ): string | undefined {
    const baseName = filename.replace('.tgz', '');
    // 匹配格式: package-1.0.0.tgz 或 package-1.0.0-beta.1.tgz
    const versionMatch = baseName.match(
      /-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?)$/
    );
    return versionMatch ? versionMatch[1] : undefined;
  }

  /**
   * 读取导出历史文件
   */
  async readExportHistory(): Promise<ExportHistoryFile> {
    const historyPath = path.join(this.storagePath, EXPORT_HISTORY_FILE);

    try {
      const content = await readFile(historyPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // 文件不存在，返回空历史
        return { version: 1, exports: [] };
      }
      throw error;
    }
  }

  /**
   * 写入导出历史文件
   */
  async writeExportHistory(history: ExportHistoryFile): Promise<void> {
    const historyPath = path.join(this.storagePath, EXPORT_HISTORY_FILE);
    await writeFile(historyPath, JSON.stringify(history, null, 2));
  }

  /**
   * 添加导出记录
   */
  async addExportRecord(record: ExportRecord): Promise<void> {
    const history = await this.readExportHistory();
    history.exports.push(record);
    // 只保留最近 100 条记录
    if (history.exports.length > 100) {
      history.exports = history.exports.slice(-100);
    }
    await this.writeExportHistory(history);
  }

  /**
   * 获取上次导出时间
   */
  async getLastExportTimestamp(): Promise<Date | null> {
    const history = await this.readExportHistory();
    if (history.exports.length === 0) {
      return null;
    }
    const lastExport = history.exports[history.exports.length - 1];
    return new Date(lastExport.timestampMs);
  }

  /**
   * 获取导出目录路径
   */
  getExportsDir(): string {
    return path.join(this.storagePath, EXPORTS_DIR);
  }

  /**
   * 确保导出目录存在
   */
  async ensureExportsDir(): Promise<string> {
    const exportsDir = this.getExportsDir();
    await mkdir(exportsDir, { recursive: true });
    return exportsDir;
  }

  /**
   * 将扫描文件转换为导出文件条目（不含 checksum）
   */
  scannedFilesToEntries(
    files: ScannedFile[]
  ): Omit<ExportFileEntry, 'checksum'>[] {
    return files.map(file => ({
      path: file.relativePath,
      size: file.size,
      mtime: file.mtime.toISOString(),
      type: file.type,
      packageName: file.packageName,
      version: file.version
    }));
  }

  /**
   * 计算统计信息
   */
  calculateStats(files: ScannedFile[]): {
    totalFiles: number;
    totalSize: number;
    packages: number;
    versions: number;
  } {
    const packages = new Set<string>();
    let versions = 0;
    let totalSize = 0;

    for (const file of files) {
      packages.add(file.packageName);
      totalSize += file.size;
      if (file.type === 'tarball') {
        versions++;
      }
    }

    return {
      totalFiles: files.length,
      totalSize,
      packages: packages.size,
      versions
    };
  }
}
