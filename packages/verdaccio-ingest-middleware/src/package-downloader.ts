import pacote from 'pacote';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { Logger } from '@verdaccio/types';
import {
  IngestConfig,
  ResolvedPackage,
  DownloadResult,
  PlatformConfig
} from './types';

/**
 * 包下载器 - 负责从上游仓库下载包
 */
export class PackageDownloader {
  private config: IngestConfig;
  private logger: Logger;
  private storagePath: string;
  private registry: string;
  // 请求级缓存，避免短时间内重复拉取同一元数据
  private packumentCache: Map<string, any> = new Map();
  private packumentInflight: Map<string, Promise<any>> = new Map();
  private manifestCache: Map<string, any> = new Map();
  private manifestInflight: Map<string, Promise<any>> = new Map();

  constructor(config: IngestConfig, storagePath: string, logger: Logger) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;
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

    // 计算哈希
    const sha1Hash = createHash('sha1');
    const sha512Hash = createHash('sha512');
    sha1Hash.update(tarballBuffer);
    sha512Hash.update(tarballBuffer);
    const size = tarballBuffer.length;

    // 写入文件
    await writeFile(tarballPath, tarballBuffer);

    const shasum = sha1Hash.digest('hex');
    const integrity = `sha512-${sha512Hash.digest('base64')}`;

    // 获取完整 manifest
    const manifest = await this.getManifest(spec, true);

    this.logger.info(
      { name: pkg.name, version: pkg.version, shasum, size, registry: this.registry },
      'Downloaded @{name}@@{version} (shasum: @{shasum}, size: @{size} bytes)'
    );

    return {
      package: pkg,
      tarballPath,
      tarballName,
      shasum,
      integrity,
      size,
      manifest
    };
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

  /**
   * 保存元数据到存储
   */
  async savePackument(packageName: string, packument: any): Promise<void> {
    const packagePath = this.getPackagePath(packageName);
    const metadataPath = path.join(packagePath, 'package.json');

    await mkdir(packagePath, { recursive: true });
    await writeFile(metadataPath, JSON.stringify(packument, null, 2));

    this.logger.debug(
      { packageName },
      'Saved packument for @{packageName}'
    );
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
      ).some((dep) => this.isPlatformSpecificPackage(dep));

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
      .filter(([name]) => this.matchesPlatform(name, platform));
    const limit = pLimit(Math.min(this.getConcurrency(), Math.max(1, candidates.length)));

    const results = await Promise.all(
      candidates.map(([name, versionRange]) =>
        limit(async () => {
          try {
            const depManifest = await this.getManifest(`${name}@${versionRange}`, false);
            return {
              name,
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
   * 检查包名是否是平台特定的
   */
  private isPlatformSpecificPackage(packageName: string): boolean {
    const platformPatterns = [
      /@esbuild\//,
      /@swc\/core-/,
      /@rollup\/rollup-/,
      /@img\/sharp-/,
      /-linux-/,
      /-win32-/,
      /-darwin-/,
      /-x64/,
      /-arm64/,
      /-gnu$/,
      /-musl$/,
      /-msvc$/
    ];

    return platformPatterns.some((pattern) => pattern.test(packageName));
  }

  /**
   * 检查包名是否匹配指定平台
   */
  private matchesPlatform(packageName: string, platform: PlatformConfig): boolean {
    const name = packageName.toLowerCase();

    // 检查操作系统
    const osMatch =
      (platform.os === 'linux' && name.includes('linux')) ||
      (platform.os === 'win32' && name.includes('win32')) ||
      (platform.os === 'darwin' && name.includes('darwin'));

    if (!osMatch) return false;

    // 检查架构
    const archMatch =
      (platform.arch === 'x64' && (name.includes('x64') || name.includes('x86_64'))) ||
      (platform.arch === 'arm64' && (name.includes('arm64') || name.includes('aarch64'))) ||
      (platform.arch === 'ia32' && (name.includes('ia32') || name.includes('x86')));

    if (!archMatch) return false;

    // 检查 libc（仅 Linux）
    if (platform.os === 'linux' && platform.libc) {
      const libcMatch =
        (platform.libc === 'glibc' && (name.includes('gnu') || !name.includes('musl'))) ||
        (platform.libc === 'musl' && name.includes('musl'));

      return libcMatch;
    }

    return true;
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
