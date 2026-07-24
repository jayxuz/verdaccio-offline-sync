import { Logger, Manifest } from '@verdaccio/types';
import { readFile } from 'fs/promises';
import { join } from 'path';
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
 * 已从远端获取、与本地数据合并并规范化，但尚未持久化的包元数据。
 */
export interface PreparedPackage {
  packageName: string;
  manifest: Manifest;
  versionsCount: number;
  distTags: Record<string, string>;
}

/**
 * 旧同步 API 的兼容结果。该 API 仅准备元数据，因此 persisted 始终为 false。
 */
export interface PreparationSyncResult extends SyncResult {
  persisted: false;
  manifest?: Manifest;
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
   * 获取远端元数据并与本地信息合并。此方法不执行持久化。
   */
  async preparePackage(packageName: string): Promise<PreparedPackage> {
    this.logger.info(
      { packageName, storagePath: this.storagePath },
      '[MetadataSyncer] Preparing @{packageName}, storage: @{storagePath}'
    );

    try {
      // 1. 从远端获取最新元数据
      const remoteMetadata = await this.fetchRemoteMetadata(packageName);

      // 2. 读取本地元数据（如果存在）
      const localMetadata = await this.readLocalMetadata(packageName);

      // 3. 合并元数据
      const mergedMetadata = this.mergeMetadata(localMetadata, remoteMetadata);

      return {
        packageName,
        manifest: mergedMetadata,
        versionsCount: Object.keys(mergedMetadata.versions || {}).length,
        distTags: mergedMetadata['dist-tags'] || {}
      };
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error.message, stack: error.stack },
        '[MetadataSyncer] Failed to prepare @{packageName}: @{error}'
      );
      throw error;
    }
  }

  /**
   * @deprecated 使用 preparePackage；保留 SyncResult 成功/失败语义，但不执行持久化。
   */
  async syncPackage(packageName: string): Promise<PreparationSyncResult> {
    try {
      const prepared = await this.preparePackage(packageName);
      return {
        success: true,
        packageName: prepared.packageName,
        versionsCount: prepared.versionsCount,
        distTags: prepared.distTags,
        manifest: prepared.manifest,
        persisted: false
      };
    } catch (error: any) {
      return {
        success: false,
        packageName,
        versionsCount: 0,
        distTags: {},
        error: error?.message || String(error),
        persisted: false
      };
    }
  }

  /**
   * 合并本地和远端元数据
   * 远端元数据优先，但保留本地的 _uplinks 等信息
   */
  mergeMetadata(
    local: Manifest | null,
    remote: Manifest
  ): Manifest {
    const localManifest = (local || {
      name: remote.name,
      versions: {},
      'dist-tags': {}
    }) as any;
    const remoteManifest = remote as any;
    const distfiles: Record<string, any> = {
      ...this.asMap(remoteManifest._distfiles)
    };

    for (const version of Object.values(this.asMap(remoteManifest.versions))) {
      const dist = this.asMap(this.asMap(version).dist);
      const filename = this.extractFilenameFromTarballUrl(dist.tarball);
      if (!filename) {
        continue;
      }

      const record: Record<string, any> = {
        ...this.asMap(distfiles[filename]),
        url: dist.tarball
      };
      if (typeof dist.shasum === 'string' && dist.shasum.length > 0) {
        record.sha = dist.shasum;
      }
      distfiles[filename] = record;
    }

    const merged = {
      ...localManifest,
      ...remoteManifest,
      versions: {
        ...this.asMap(localManifest.versions),
        ...this.asMap(remoteManifest.versions)
      },
      _attachments: {
        ...this.asMap(localManifest._attachments),
        ...this.asMap(remoteManifest._attachments)
      },
      _distfiles: {
        ...distfiles,
        ...this.asMap(localManifest._distfiles)
      },
      _uplinks: {
        ...this.asMap(remoteManifest._uplinks),
        ...this.asMap(localManifest._uplinks)
      }
    } as Manifest;

    if (this.isValidLocalIdentity(localManifest._rev)) {
      (merged as any)._rev = localManifest._rev;
    } else {
      delete (merged as any)._rev;
    }
    if (this.isValidLocalIdentity(localManifest._id)) {
      (merged as any)._id = localManifest._id;
    } else {
      delete (merged as any)._id;
    }

    return this.normalizeManifest(merged);
  }

  /**
   * 获取包的存储路径
   */
  private getPackagePath(packageName: string): string {
    return join(this.storagePath, packageName);
  }

  private normalizeManifest(manifest: Manifest): Manifest {
    const raw = manifest as any;
    for (const field of [
      'versions',
      'dist-tags',
      '_attachments',
      '_distfiles',
      '_uplinks',
      'time'
    ]) {
      raw[field] = this.asMap(raw[field]);
    }
    return manifest;
  }

  private asMap(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : {};
  }

  private isValidLocalIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  private extractFilenameFromTarballUrl(tarball: unknown): string | null {
    if (typeof tarball !== 'string' || tarball.length === 0) {
      return null;
    }
    const clean = tarball.split('?')[0].split('#')[0];
    const lastSlash = clean.lastIndexOf('/');
    const filename = lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
    if (!filename || !filename.endsWith('.tgz')) {
      return null;
    }
    return filename;
  }

  /**
   * 批量准备多个包的元数据，不执行持久化。
   */
  async preparePackages(
    packageNames: string[],
    onProgress?: (current: number, total: number, packageName: string) => void
  ): Promise<PreparedPackage[]> {
    if (packageNames.length === 0) {
      return [];
    }

    // 保持输入顺序，同时去重，避免重复同步同一个包
    const uniqueNames = Array.from(new Set(packageNames));
    const total = uniqueNames.length;
    const concurrency = this.getSyncConcurrency();
    let completed = 0;

    return this.mapWithConcurrency(uniqueNames, concurrency, async (packageName) => {
      const result = await this.preparePackage(packageName);
      completed++;

      if (onProgress) {
        onProgress(completed, total, packageName);
      }

      return result;
    });
  }

  /**
   * @deprecated 使用 preparePackages；保留 SyncResult 数组语义，但不执行持久化。
   */
  async syncPackages(
    packageNames: string[],
    onProgress?: (current: number, total: number, packageName: string) => void
  ): Promise<PreparationSyncResult[]> {
    if (packageNames.length === 0) {
      return [];
    }

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
