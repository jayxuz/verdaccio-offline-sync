import { readdir, stat } from 'fs/promises';
import path from 'path';
import { Logger } from '@verdaccio/types';
import { HealerConfig, TarballInfo, ScanCacheEntry } from './types';

/**
 * 存储扫描器 - 扫描存储目录中的 tarball 文件
 */
export class StorageScanner {
  private config: HealerConfig;
  private logger: Logger;
  private storagePath: string;
  private scanCache: Map<string, ScanCacheEntry>;
  private cacheTTL: number;

  constructor(config: HealerConfig, storagePath: string, logger: Logger) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;
    this.scanCache = new Map();
    this.cacheTTL = config.scanCacheTTL || 60000; // 默认 1 分钟
  }

  /**
   * 扫描指定包的所有 tarball 文件
   */
  async scanPackageTarballs(packageName: string): Promise<TarballInfo[]> {
    // 检查缓存
    const cached = this.scanCache.get(packageName);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.tarballs;
    }

    const packageDir = this.getPackageDir(packageName);
    const tarballs: TarballInfo[] = [];

    try {
      const files = await readdir(packageDir);

      for (const file of files) {
        if (!file.endsWith('.tgz')) continue;

        const version = this.extractVersionFromFilename(packageName, file);
        if (!version) continue;

        const filePath = path.join(packageDir, file);

        try {
          const fileStat = await stat(filePath);

          tarballs.push({
            filename: file,
            version,
            path: filePath,
            size: fileStat.size,
            mtime: fileStat.mtime
          });
        } catch {
          // 忽略无法访问的文件
        }
      }

      // 更新缓存
      this.scanCache.set(packageName, {
        tarballs,
        timestamp: Date.now()
      });

      this.logger.debug(
        { packageName, count: tarballs.length },
        'Scanned @{count} tarballs for @{packageName}'
      );

      return tarballs;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      this.logger.error(
        { packageName, error: error.message },
        'Failed to scan tarballs for @{packageName}: @{error}'
      );
      return [];
    }
  }

  /**
   * 获取包的存储目录
   */
  private getPackageDir(packageName: string): string {
    return path.join(this.storagePath, packageName);
  }

  /**
   * 从文件名中提取版本号
   */
  private extractVersionFromFilename(
    packageName: string,
    filename: string
  ): string | null {
    const baseName = filename.replace('.tgz', '');

    // 尝试从文件名中提取版本号
    // 格式: package-name-1.0.0.tgz 或 scope-package-1.0.0.tgz
    const versionMatch = baseName.match(
      /-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?)$/
    );

    if (versionMatch) {
      return versionMatch[1];
    }

    return null;
  }

  /**
   * 清除扫描缓存
   */
  clearCache(packageName?: string): void {
    if (packageName) {
      this.scanCache.delete(packageName);
    } else {
      this.scanCache.clear();
    }
  }

  /**
   * 检查目录是否有变化（基于 mtime）
   */
  async hasDirectoryChanged(packageName: string): Promise<boolean> {
    const cached = this.scanCache.get(packageName);
    if (!cached) return true;

    const packageDir = this.getPackageDir(packageName);

    try {
      const dirStat = await stat(packageDir);
      // 如果目录的 mtime 比缓存时间新，说明有变化
      return dirStat.mtimeMs > cached.timestamp;
    } catch {
      return true;
    }
  }
}
