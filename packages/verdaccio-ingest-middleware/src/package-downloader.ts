import pacote from 'pacote';
import { createHash } from 'crypto';
import { mkdir, writeFile, unlink } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { Logger } from '@verdaccio/types';
import {
  IngestConfig,
  ResolvedPackage,
  DownloadResult,
  PlatformConfig
} from './types';
import { persistPackumentWithVerdaccioStorage } from './packument-persistence';
import type { PackumentPersistence } from './packument-persistence';
import {
  isPlatformSpecificPackageName,
  matchesPlatformPackageName
} from './platform-utils';

/**
 * 包下载器 - 负责从上游仓库下载包
 */
export class PackageDownloader {
  private config: IngestConfig;
  private logger: Logger;
  private storagePath: string;
  private verdaccioStorage: any;
  private persistPackument: PackumentPersistence;
  private registry: string;
  // 请求级缓存，避免短时间内重复拉取同一元数据
  private packumentCache: Map<string, any> = new Map();
  private packumentInflight: Map<string, Promise<any>> = new Map();
  private manifestCache: Map<string, any> = new Map();
  private manifestInflight: Map<string, Promise<any>> = new Map();

  constructor(
    config: IngestConfig,
    storagePath: string,
    logger: Logger,
    verdaccioStorage?: any,
    persistPackument: PackumentPersistence = persistPackumentWithVerdaccioStorage
  ) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;
    this.verdaccioStorage = verdaccioStorage;
    this.persistPackument = persistPackument;
    this.registry = config.upstreamRegistry || 'https://registry.npmjs.org';
  }

  /**
   * 批量下载包
   */
  async downloadAll(
    packages: ResolvedPackage[],
    concurrency: number = 5
  ): Promise<DownloadResult[]> {
    const limit = pLimit(concurrency);
    const results: DownloadResult[] = [];

    const tasks = packages.map((pkg) =>
      limit(async () => {
        try {
          const result = await this.downloadPackage(pkg);
          results.push(result);
          return result;
        } catch (error: any) {
          this.logger.error(
            { pkg: pkg.name, version: pkg.version, error: error.message },
            'Failed to download @{pkg}@@{version}: @{error}'
          );
          throw error;
        }
      })
    );

    await Promise.allSettled(tasks);
    return results;
  }

  /**
   * 下载单个包
   */
  async downloadPackage(pkg: ResolvedPackage): Promise<DownloadResult>;
  async downloadPackage(name: string, version: string): Promise<DownloadResult>;
  async downloadPackage(
    pkgOrName: ResolvedPackage | string,
    version?: string
  ): Promise<DownloadResult> {
    const pkg: ResolvedPackage =
      typeof pkgOrName === 'string'
        ? {
            name: pkgOrName,
            version: version!,
            dist: { shasum: '', tarball: '' },
            dependencies: {}
          }
        : pkgOrName;

    const spec = `${pkg.name}@${pkg.version}`;
    const tarballDir = this.getPackagePath(pkg.name);
    const tarballName = this.getTarballName(pkg.name, pkg.version);
    const tarballPath = path.join(tarballDir, tarballName);

    // 确保目录存在
    await mkdir(tarballDir, { recursive: true });

    this.logger.debug(
      { spec, registry: this.registry },
      'Downloading @{spec} from @{registry}'
    );

    // 下载 tarball（使用 pacote.tarball() 获取 Buffer）
    const tarballBuffer = await pacote.tarball(spec, {
      registry: this.registry
    });

    // 验证下载的 tarball 不是空的
    if (!tarballBuffer || tarballBuffer.length === 0) {
      throw new Error(`Downloaded tarball for ${spec} is empty`);
    }

    // 最小体积检查
    const minSize = this.getMinTarballSize();
    if (tarballBuffer.length < minSize) {
      throw new Error(
        `Downloaded tarball for ${spec} is too small (${tarballBuffer.length} bytes, minimum ${minSize})`
      );
    }

    // 计算哈希（在写入磁盘前，避免坏文件落地）
    const sha1Hash = createHash('sha1');
    const sha512Hash = createHash('sha512');
    sha1Hash.update(tarballBuffer);
    sha512Hash.update(tarballBuffer);
    const size = tarballBuffer.length;
    const shasum = sha1Hash.digest('hex');
    const integrity = `sha512-${sha512Hash.digest('base64')}`;

    // 获取 manifest 用于校验
    let manifest: any;
    let verified = false;

    try {
      manifest = await this.getManifest(spec, true);
    } catch (manifestErr: any) {
      // manifest 获取失败时，仍然写入文件（已有内容），但标记未校验
      this.logger.warn(
        { spec, error: manifestErr.message },
        'Failed to fetch manifest for @{spec}, writing tarball without verification'
      );
      await writeFile(tarballPath, tarballBuffer);

      return {
        package: pkg,
        tarballPath,
        tarballName,
        shasum,
        integrity,
        size,
        manifest: null,
        verified: false
      };
    }

    // 校验 SHA-1
    if (this.shouldVerifyChecksum()) {
      const expectedShasum = manifest?.dist?.shasum;
      if (expectedShasum && typeof expectedShasum === 'string' && expectedShasum.length > 0) {
        if (shasum !== expectedShasum) {
          throw new Error(
            `SHA-1 checksum mismatch for ${spec}: expected ${expectedShasum}, got ${shasum}`
          );
        }
        verified = true;
      } else {
        this.logger.warn(
          { spec },
          'No dist.shasum in manifest for @{spec}, skipping checksum verification'
        );
      }
    }

    // 校验通过后写入磁盘
    await writeFile(tarballPath, tarballBuffer);

    this.logger.info(
      { name: pkg.name, version: pkg.version, shasum, size, verified, registry: this.registry },
      'Downloaded @{name}@@{version} (shasum: @{shasum}, size: @{size} bytes, verified: @{verified})'
    );

    return {
      package: pkg,
      tarballPath,
      tarballName,
      shasum,
      integrity,
      size,
      manifest,
      verified
    };
  }

  /**
   * 清理下载失败/校验失败后残留的 tarball 文件
   */
  async cleanupTarball(packageName: string, version: string): Promise<void> {
    const tarballPath = path.join(
      this.getPackagePath(packageName),
      this.getTarballName(packageName, version)
    );
    try {
      await unlink(tarballPath);
      this.logger.debug(
        { packageName, version },
        'Cleaned up corrupt tarball for @{packageName}@@{version}'
      );
    } catch {
      // 文件可能不存在，忽略
    }
  }

  /**
   * 下载包的元数据（packument）
   */
  async downloadPackument(packageName: string): Promise<any> {
    return this.getPackument(packageName);
  }

  /**
   * 清理请求缓存（任务结束后调用，释放内存）
   */
  clearRequestCache(): void {
    this.packumentCache.clear();
    this.packumentInflight.clear();
    this.manifestCache.clear();
    this.manifestInflight.clear();
  }

  /**
   * 获取包的元数据（带缓存 + 并发去重）
   */
  private async getPackument(packageName: string): Promise<any> {
    if (this.packumentCache.has(packageName)) {
      return this.packumentCache.get(packageName);
    }

    const inflight = this.packumentInflight.get(packageName);
    if (inflight) {
      return inflight;
    }

    const request = (async () => {
      try {
        const packument = await pacote.packument(packageName, {
          registry: this.registry,
          fullMetadata: true
        });
        this.packumentCache.set(packageName, packument);
        return packument;
      } catch (error: any) {
        this.logger.error(
          { packageName, error: error.message },
          'Failed to fetch packument for @{packageName}: @{error}'
        );
        throw error;
      } finally {
        this.packumentInflight.delete(packageName);
      }
    })();

    this.packumentInflight.set(packageName, request);
    return request;
  }

  /**
   * 获取 manifest（带缓存 + 并发去重）
   */
  private async getManifest(spec: string, fullMetadata: boolean): Promise<any> {
    const cacheKey = `${fullMetadata ? 'full' : 'lean'}:${spec}`;
    if (this.manifestCache.has(cacheKey)) {
      return this.manifestCache.get(cacheKey);
    }

    const inflight = this.manifestInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const request = (async () => {
      try {
        const manifest = await pacote.manifest(spec, {
          registry: this.registry,
          fullMetadata
        });
        this.manifestCache.set(cacheKey, manifest);
        return manifest;
      } catch (error: any) {
        this.logger.warn(
          { spec, error: error.message },
          'Failed to fetch manifest for @{spec}: @{error}'
        );
        throw error;
      } finally {
        this.manifestInflight.delete(cacheKey);
      }
    })();

    this.manifestInflight.set(cacheKey, request);
    return request;
  }

  private getConcurrency(): number {
    const configured = Number(this.config.concurrency);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 5;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }

  private getMinTarballSize(): number {
    const configured = Number(this.config.minTarballSize);
    return Number.isFinite(configured) && configured > 0 ? configured : 128;
  }

  private shouldVerifyChecksum(): boolean {
    return this.config.verifyChecksum !== false;
  }

  /**
   * 保存元数据到存储
   */
  async savePackument(packageName: string, packument: any): Promise<void> {
    try {
      await this.persistPackument(this.verdaccioStorage, packageName, packument);

      this.logger.debug(
        { packageName },
        'Saved packument for @{packageName}'
      );
    } catch (error: any) {
      this.logger.error(
        { packageName, error: error?.message || String(error) },
        'Failed to save packument for @{packageName}: @{error}'
      );
      throw error;
    }
  }

  /**
   * 检测包是否包含平台特定的二进制文件
   */
  async detectBinaryPackage(
    packageName: string,
    version: string
  ): Promise<boolean> {
    try {
      const manifest = await this.getManifest(`${packageName}@${version}`, true);

      // 检查 optionalDependencies 中的平台特定包
      const hasOptionalPlatformDeps = Object.keys(
        manifest.optionalDependencies || {}
      ).some((dep) => isPlatformSpecificPackageName(dep));

      // 检查 package.json 中的 os/cpu 字段
      const hasOsCpuRestriction = manifest.os || manifest.cpu;

      return hasOptionalPlatformDeps || !!hasOsCpuRestriction;
    } catch {
      return false;
    }
  }

  /**
   * 下载所有目标平台的二进制包
   */
  async downloadForPlatforms(
    packageName: string,
    version: string,
    platforms: PlatformConfig[]
  ): Promise<DownloadResult[]> {
    const platformDeps = await this.getPlatformDependencies(packageName, version, platforms);
    if (platformDeps.length === 0) {
      return [];
    }

    const packages: ResolvedPackage[] = platformDeps.map((dep) => ({
      name: dep.name,
      version: dep.version,
      dist: { shasum: '', tarball: '' },
      dependencies: {}
    }));

    return this.downloadAll(packages, this.getConcurrency());
  }

  /**
   * 获取平台特定的依赖（公开方法）
   */
  async getPlatformDependencies(
    packageName: string,
    version: string,
    platforms: PlatformConfig[]
  ): Promise<Array<{ name: string; version: string }>> {
    const allDeps: Array<{ name: string; version: string }> = [];
    const limit = pLimit(Math.min(this.getConcurrency(), Math.max(1, platforms.length)));

    await Promise.all(
      platforms.map((platform) =>
        limit(async () => {
          try {
            const deps = await this.resolvePlatformDependencies(
              packageName,
              version,
              platform
            );
            allDeps.push(...deps);
          } catch {
            // 忽略解析失败
          }
        })
      )
    );

    // 去重
    const seen = new Set<string>();
    return allDeps.filter((dep) => {
      const key = `${dep.name}@${dep.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 解析平台特定的依赖
   */
  private async resolvePlatformDependencies(
    packageName: string,
    version: string,
    platform: PlatformConfig
  ): Promise<Array<{ name: string; version: string }>> {
    const manifest = await this.getManifest(`${packageName}@${version}`, true);

    const optionalDeps = manifest.optionalDependencies || {};
    const candidates = Object.entries(optionalDeps)
      .filter(([name]) => matchesPlatformPackageName(name, platform));
    const limit = pLimit(Math.min(this.getConcurrency(), Math.max(1, candidates.length)));

    const results = await Promise.all(
      candidates.map(([name, versionRange]) =>
        limit(async () => {
          try {
            const depManifest = await this.getManifest(`${name}@${versionRange}`, false);
            return {
              // npm aliases use the dependency key as an install-time alias, but
              // the registry tarball belongs to the manifest's real package.
              // Example: @openai/codex-win32-x64 points to
              // npm:@openai/codex@0.146.1-win32-x64.
              name: typeof depManifest.name === 'string' ? depManifest.name : name,
              version: depManifest.version
            };
          } catch {
            return null;
          }
        })
      )
    );

    return results.filter((item): item is { name: string; version: string } => item !== null);
  }

  /**
   * 获取包的存储路径
   */
  private getPackagePath(packageName: string): string {
    return path.join(this.storagePath, packageName);
  }

  /**
   * 获取 tarball 文件名
   */
  private getTarballName(packageName: string, version: string): string {
    const baseName = packageName.replace('@', '').replace('/', '-');
    return `${baseName}-${version}.tgz`;
  }
}
