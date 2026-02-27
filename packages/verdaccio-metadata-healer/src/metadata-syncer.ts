import { Logger, Manifest } from '@verdaccio/types';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import pacote from 'pacote';
import { HealerConfig } from './types';

/**
 * 元数据同步结果
 */
export interface SyncResult {
  success: boolean;
  packageName: string;
  versionsCount: number;
  distTags: Record<string, string>;
  error?: string;
}

/**
 * 元数据同步器
 * 用于从远端 registry 获取最新元数据并保存到本地
 */
export class MetadataSyncer {
  private config: HealerConfig;
  private storagePath: string;
  private logger: Logger;
  private upstreamRegistry: string;
  private readonly defaultSyncConcurrency = 5;
  private remoteMetadataInflight: Map<string, Promise<Manifest>> = new Map();

  constructor(
    config: HealerConfig,
    storagePath: string,
    logger: Logger,
    upstreamRegistry?: string
  ) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;
    // 默认使用 npmmirror，可以通过配置覆盖
    this.upstreamRegistry = upstreamRegistry || 'https://registry.npmmirror.com';
  }

  /**
   * 设置上游 registry URL
   */
  setUpstreamRegistry(url: string): void {
    this.upstreamRegistry = url;
  }

  /**
   * 从远端获取包的元数据
   */
  async fetchRemoteMetadata(packageName: string): Promise<Manifest> {
    const inflight = this.remoteMetadataInflight.get(packageName);
    if (inflight) {
      return inflight;
    }

    this.logger.info(
      { packageName, registry: this.upstreamRegistry },
      '[MetadataSyncer] Fetching metadata for @{packageName} from @{registry}'
    );

    const request = (async () => {
      try {
        const packument = await pacote.packument(packageName, {
          registry: this.upstreamRegistry,
          fullMetadata: true
        });

        this.logger.info(
          {
            packageName,
            versions: Object.keys(packument.versions || {}).length,
            latest: packument['dist-tags']?.latest
          },
          '[MetadataSyncer] Fetched @{packageName}: @{versions} versions, latest: @{latest}'
        );

        // pacote.packument 返回的类型与 Verdaccio 的 Manifest 类型不完全兼容
        // 但实际数据结构是兼容的，所以通过 unknown 进行类型转换
        return packument as unknown as Manifest;
      } catch (error: any) {
        this.logger.error(
          { packageName, error: error.message },
          '[MetadataSyncer] Failed to fetch metadata for @{packageName}: @{error}'
        );
        throw error;
      } finally {
        this.remoteMetadataInflight.delete(packageName);
      }
    })();

    this.remoteMetadataInflight.set(packageName, request);
    return request;
  }

  clearRemoteMetadataCache(): void {
    this.remoteMetadataInflight.clear();
  }

  /**
   * 读取本地的 package.json
   */
  async readLocalMetadata(packageName: string): Promise<Manifest | null> {
    const packagePath = this.getPackagePath(packageName);
    const metadataPath = join(packagePath, 'package.json');

    try {
      const content = await readFile(metadataPath, 'utf-8');
      return JSON.parse(content) as Manifest;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 保存元数据到本地
   */
  async saveMetadata(packageName: string, metadata: Manifest): Promise<void> {
    const packagePath = this.getPackagePath(packageName);
    const metadataPath = join(packagePath, 'package.json');

    // 确保目录存在
    await mkdir(dirname(metadataPath), { recursive: true });

    // 记录保存的元数据信息
    const versionsCount = Object.keys(metadata.versions || {}).length;
    const distTags = metadata['dist-tags'] || {};

    this.logger.info(
      {
        packageName,
        path: metadataPath,
        versions: versionsCount,
        latest: distTags.latest,
        tags: Object.keys(distTags).join(', ')
      },
      '[MetadataSyncer] Saving metadata for @{packageName} to @{path} with @{versions} versions, latest: @{latest}'
    );

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    this.logger.info(
      { packageName, path: metadataPath },
      '[MetadataSyncer] Saved metadata for @{packageName} to @{path}'
    );
  }

  /**
   * 同步单个包的元数据
   * 从远端获取最新元数据，合并本地信息，然后保存
   */
  async syncPackage(packageName: string): Promise<SyncResult> {
    this.logger.info(
      { packageName, storagePath: this.storagePath },
      '[MetadataSyncer] Starting sync for @{packageName}, storage: @{storagePath}'
    );

    try {
      // 1. 从远端获取最新元数据
      const remoteMetadata = await this.fetchRemoteMetadata(packageName);

      // 2. 读取本地元数据（如果存在）
      const localMetadata = await this.readLocalMetadata(packageName);

      // 3. 合并元数据
      const mergedMetadata = this.mergeMetadata(localMetadata, remoteMetadata);

      // 4. 保存到本地
      await this.saveMetadata(packageName, mergedMetadata);

      return {
        success: true,
        packageName,
        versionsCount: Object.keys(mergedMetadata.versions || {}).length,
        distTags: mergedMetadata['dist-tags'] || {}
      };
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message, stack: error.stack },
        '[MetadataSyncer] Failed to sync @{packageName}: @{error}'
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
   * 远端元数据优先，但保留本地的 _uplinks 等信息
   */
  private mergeMetadata(
    local: Manifest | null,
    remote: Manifest
  ): Manifest {
    if (!local) {
      return remote;
    }

    // 使用远端元数据作为基础
    const merged = { ...remote };

    // 保留本地的 _uplinks 信息（用于缓存控制）
    if (local._uplinks) {
      merged._uplinks = local._uplinks;
    }

    // 保留本地的 _attachments 信息
    if (local._attachments) {
      merged._attachments = {
        ...merged._attachments,
        ...local._attachments
      };
    }

    // 更新 _uplinks 的 fetched 时间
    if (!merged._uplinks) {
      merged._uplinks = {};
    }
    merged._uplinks['synced'] = {
      etag: '',
      fetched: Date.now()
    };

    return merged;
  }

  /**
   * 获取包的存储路径
   */
  private getPackagePath(packageName: string): string {
    return join(this.storagePath, packageName);
  }

  /**
   * 批量同步多个包的元数据
   */
  async syncPackages(
    packageNames: string[],
    onProgress?: (current: number, total: number, packageName: string) => void
  ): Promise<SyncResult[]> {
    if (packageNames.length === 0) {
      return [];
    }

    // 保持输入顺序，同时去重，避免重复同步同一个包
    const uniqueNames = Array.from(new Set(packageNames));
    const total = uniqueNames.length;
    const concurrency = this.getSyncConcurrency();
    let completed = 0;

    return this.mapWithConcurrency(uniqueNames, concurrency, async (packageName) => {
      const result = await this.syncPackage(packageName);
      completed++;

      if (onProgress) {
        onProgress(completed, total, packageName);
      }

      return result;
    });
  }

  private getSyncConcurrency(): number {
    const configured = Number(this.config.syncConcurrency);
    if (!Number.isFinite(configured) || configured <= 0) {
      return this.defaultSyncConcurrency;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
