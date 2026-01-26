import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { LRUCache } from 'lru-cache';
import { Logger } from '@verdaccio/types';
import { HealerConfig, ShasumCacheEntry } from './types';

/**
 * Shasum 缓存 - 缓存文件的哈希值以提高性能
 */
export class ShasumCache {
  private cache: LRUCache<string, ShasumCacheEntry>;
  private logger: Logger;

  constructor(config: HealerConfig, logger: Logger) {
    this.logger = logger;
    this.cache = new LRUCache<string, ShasumCacheEntry>({
      max: config.shasumCacheSize || 10000
    });
  }

  /**
   * 获取或计算文件的哈希值
   */
  async getOrCompute(
    filePath: string
  ): Promise<{ shasum: string; integrity: string }> {
    try {
      const fileStat = await stat(filePath);
      const cached = this.cache.get(filePath);

      // 如果缓存存在且 mtime 未变，直接返回
      if (cached && cached.mtime === fileStat.mtimeMs) {
        return { shasum: cached.shasum, integrity: cached.integrity };
      }

      // 计算新的哈希
      const { shasum, integrity } = await this.computeHashes(filePath);

      // 更新缓存
      this.cache.set(filePath, {
        shasum,
        integrity,
        mtime: fileStat.mtimeMs
      });

      return { shasum, integrity };
    } catch (error: any) {
      this.logger.error(
        { filePath, error: error.message },
        'Failed to compute hash for @{filePath}: @{error}'
      );
      throw error;
    }
  }

  /**
   * 计算文件的 SHA-1 和 SHA-512 哈希
   */
  private computeHashes(
    filePath: string
  ): Promise<{ shasum: string; integrity: string }> {
    return new Promise((resolve, reject) => {
      const sha1Hash = createHash('sha1');
      const sha512Hash = createHash('sha512');

      const stream = createReadStream(filePath);

      stream.on('data', (chunk: Buffer | string) => {
        sha1Hash.update(chunk);
        sha512Hash.update(chunk);
      });

      stream.on('end', () => {
        const shasum = sha1Hash.digest('hex');
        const integrity = `sha512-${sha512Hash.digest('base64')}`;
        resolve({ shasum, integrity });
      });

      stream.on('error', reject);
    });
  }

  /**
   * 清除缓存
   */
  clear(filePath?: string): void {
    if (filePath) {
      this.cache.delete(filePath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): { size: number; max: number } {
    return {
      size: this.cache.size,
      max: this.cache.max
    };
  }
}
