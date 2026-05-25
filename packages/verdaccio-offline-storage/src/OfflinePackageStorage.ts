import { existsSync, readdirSync, createReadStream } from 'fs';
import { readdir, stat, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { basename, dirname, join } from 'path';
import semver from 'semver';
import { Logger, Manifest, Callback } from '@verdaccio/types';
import { OfflineStorageConfig } from './types';

// Import LocalFS from @verdaccio/local-storage-legacy
// Verdaccio 6.x uses local-storage-legacy package
let LocalFS: any;
try {
  // Try @verdaccio/local-storage-legacy first (used by Verdaccio 6.x)
  LocalFS = require('@verdaccio/local-storage-legacy/lib/local-fs').default;
} catch {
  try {
    // Fallback to @verdaccio/local-storage (newer versions)
    LocalFS = require('@verdaccio/local-storage').LocalDriver ||
              require('@verdaccio/local-storage/lib/local-fs').default;
  } catch (e) {
    console.error('[verdaccio-offline-storage] Failed to load LocalFS:', e);
    throw new Error('Could not load LocalFS from @verdaccio/local-storage-legacy or @verdaccio/local-storage');
  }
}

/**
 * IPackageStorage implementation for offline mode
 *
 * This works just like the IPackageStorage used by the local-storage plugin but modifying
 * the packages definition files so only the locally available versions appear in the definition.
 * This does NOT modify the original package.json file stored in the local-storage cache.
 */
export class OfflinePackageStorage extends LocalFS {
  private config: OfflineStorageConfig;
  protected logger: Logger;

  constructor(path: string, logger: Logger, config: OfflineStorageConfig) {
    super(path, logger);
    this.config = config;
    this.logger = logger;

    // 添加构造函数日志，确认插件被加载
    this.logger.warn(
      { path },
      '[verdaccio-offline-storage] OfflinePackageStorage initialized for path: @{path}'
    );
  }

  /**
   * 保存包元数据到本地文件
   * 重写此方法以添加调试日志，跟踪元数据保存操作
   */
  savePackage(name: string, value: Manifest, cb: Callback): void {
    const versionCount = Object.keys(value.versions || {}).length;
    const distTags = value['dist-tags'] || {};

    // 使用 warn 级别确保日志可见
    this.logger.warn(
      {
        packageName: name,
        versions: versionCount,
        latest: distTags.latest,
        tags: Object.keys(distTags).join(', ')
      },
      '[verdaccio-offline-storage/savePackage] Saving package @{packageName} with @{versions} versions, latest: @{latest}, tags: @{tags}'
    );

    // 调用父类方法保存元数据
    super.savePackage(name, value, (err: any) => {
      if (err) {
        this.logger.error(
          { packageName: name, error: err.message },
          '[verdaccio-offline-storage/savePackage] Failed to save package @{packageName}: @{error}'
        );
      } else {
        this.logger.info(
          { packageName: name },
          '[verdaccio-offline-storage/savePackage] Successfully saved package @{packageName}'
        );
      }
      cb(err);
    });
  }

  /**
   * 更新包元数据
   * 重写此方法以添加调试日志，跟踪元数据更新流程
   */
  updatePackage(
    name: string,
    updateHandler: (data: Manifest, cb: Callback) => void,
    onWrite: (name: string, data: Manifest, cb: Callback) => void,
    transformPackage: (data: Manifest) => Manifest,
    onEnd: Callback
  ): void {
    // 使用 warn 级别确保日志可见
    this.logger.warn(
      { packageName: name },
      '[verdaccio-offline-storage/updatePackage] Starting update for package @{packageName}'
    );

    super.updatePackage(
      name,
      (data: Manifest, cb: Callback) => {
        const beforeVersions = Object.keys(data.versions || {}).length;
        this.logger.debug(
          { packageName: name, versions: beforeVersions },
          '[verdaccio-offline-storage/updatePackage] Before update: @{packageName} has @{versions} versions'
        );
        updateHandler(data, cb);
      },
      (pkgName: string, data: Manifest, cb: Callback) => {
        const versionCount = Object.keys(data.versions || {}).length;
        const distTags = data['dist-tags'] || {};
        this.logger.info(
          {
            packageName: pkgName,
            versions: versionCount,
            latest: distTags.latest
          },
          '[verdaccio-offline-storage/updatePackage] Writing package @{packageName} with @{versions} versions, latest: @{latest}'
        );
        onWrite(pkgName, data, cb);
      },
      transformPackage,
      (err: any) => {
        if (err) {
          this.logger.error(
            { packageName: name, error: err?.message || err },
            '[verdaccio-offline-storage/updatePackage] Update failed for @{packageName}: @{error}'
          );
        } else {
          this.logger.info(
            { packageName: name },
            '[verdaccio-offline-storage/updatePackage] Update completed for @{packageName}'
          );
        }
        onEnd(err);
      }
    );
  }

  /**
   * Computes a package's definition that only lists the locally available versions.
   */
  readPackage(name: string, cb: Callback): void {
    // 尝试获取包的访问配置
    let packageAccess: any = { proxy: [] };
    const hasGetMatchedPackagesSpec = typeof this.config.getMatchedPackagesSpec === 'function';
    let hasProxy = false;
    let canDetermineProxy = false;

    if (hasGetMatchedPackagesSpec) {
      packageAccess = this.config.getMatchedPackagesSpec(name) || { proxy: [] };
      const proxyConfig = packageAccess?.proxy;
      hasProxy = Array.isArray(proxyConfig) ? proxyConfig.length > 0 : !!proxyConfig;
      canDetermineProxy = true;
    }

    // 判断是否为 offline 模式
    // 规则：
    // 1) 显式配置 offline: true 时，始终离线
    // 2) 能判断 proxy 时，无 proxy 的包走离线
    // 3) 无法判断 proxy 时，默认在线，避免阻断回源
    const offline = this.config.offline === true || (canDetermineProxy && !hasProxy);

    // 添加详细的调试日志
    this.logger.debug(
      {
        packageName: name,
        offline,
        hasProxy,
        canDetermineProxy,
        configOffline: this.config.offline,
        hasGetMatchedPackagesSpec,
        proxy: packageAccess?.proxy ? JSON.stringify(packageAccess.proxy) : 'undefined'
      },
      '[verdaccio-offline-storage/readPackage] Package @{packageName} mode check: offline=@{offline}, hasProxy=@{hasProxy}, canDetermineProxy=@{canDetermineProxy}, configOffline=@{configOffline}, hasGetMatchedPackagesSpec=@{hasGetMatchedPackagesSpec}'
    );

    const resolveMode = offline ? 'offline' : 'online';
    this.logger.debug(
      { packageName: name, offline },
      `[verdaccio-offline-storage/readPackage] Resolving package @{packageName} in ${resolveMode} mode`
    );

    super.readPackage(name, async (err: any, data: Manifest) => {
      if (err) {
        cb(err, data);
        return;
      }

      try {
        this.logger.debug(
          { packageName: name },
          '[verdaccio-offline-storage/readPackage] Discovering local versions for package: @{packageName}'
        );

        const items = await readdir(this.path);
        const minSize = this.config.minTarballSize ?? 128;
        const verifyChecksum = this.config.verifyChecksum !== false;
        const tarballsByVersion = new Map<string, string[]>();
        for (const item of items) {
          if (!item.endsWith('.tgz')) continue;
          const version = this.extractVersionFromTarballFilename(item);
          if (!version) continue;

          const tarballPath = join(this.path, item);

          // 1. 检查文件大小（低开销）
          try {
            const fileStat = await stat(tarballPath);
            if (fileStat.size < minSize) {
              this.logger.warn(
                { packageName: name, item, size: fileStat.size },
                '[verdaccio-offline-storage] Skipping undersized tarball @{item} for @{packageName} (@{size} bytes)'
              );
              continue;
            }
          } catch {
            continue;
          }

          // 2. 校验 SHA-1（如果启用且 metadata 中有 shasum）
          if (verifyChecksum) {
            const versionMeta = data?.versions?.[version];
            const expectedShasum = versionMeta?.dist?.shasum;
            if (expectedShasum && typeof expectedShasum === 'string' && expectedShasum.length > 0) {
              try {
                const actualShasum = await this.computeTarballShasum(tarballPath);
                if (actualShasum !== expectedShasum) {
                  this.logger.warn(
                    { packageName: name, version, expected: expectedShasum, actual: actualShasum },
                    '[verdaccio-offline-storage] Checksum mismatch for @{packageName}@@{version}, removing corrupt tarball'
                  );
                  try {
                    await unlink(tarballPath);
                  } catch {
                    // 忽略删除失败
                  }
                  continue;
                }
              } catch (err: any) {
                this.logger.warn(
                  { packageName: name, version, error: err.message },
                  '[verdaccio-offline-storage] Failed to compute checksum for @{packageName}@@{version}: @{error}'
                );
                continue;
              }
            }
          }

          const filenames = tarballsByVersion.get(version) || [];
          filenames.push(item);
          tarballsByVersion.set(version, filenames);
        }

        const localVersions = Array.from(tarballsByVersion.keys());

        this.logger.debug(
          { packageName: name, count: localVersions.length },
          '[verdaccio-offline-storage/readPackage] Discovered @{count} local versions for package: @{packageName}'
        );

        const allVersions = Object.keys(data.versions || {});
        if (offline) {
          const originalVersionCount = allVersions.length;

          // 离线模式下仅保留本地已有 tarball 的版本
          for (const version of allVersions) {
            if (!localVersions.includes(version)) {
              delete data.versions[version];
              this.logger.trace(
                { packageName: name, version },
                '[verdaccio-offline-storage/readPackage] Removed @{packageName}@@{version}'
              );
            }
          }

          const removedCount = originalVersionCount - Object.keys(data.versions).length;
          this.logger.debug(
            { packageName: name, count: removedCount },
            '[verdaccio-offline-storage/readPackage] Removed @{count} unavailable versions for package: @{packageName}'
          );
        }

        // 对每个可用版本，校正 dist.tarball 文件名，兼容 scoped 包的两种命名：
        // 1) package-1.0.0.tgz（旧格式）
        // 2) scope-package-1.0.0.tgz（新格式）
        const versionsToProcess = Object.keys(data.versions || {});
        for (const version of versionsToProcess) {
          const versionManifest: any = data.versions?.[version];
          const localFilenames = [...(tarballsByVersion.get(version) || [])].sort();
          if (!versionManifest || localFilenames.length === 0) continue;

          const currentFilename = this.extractFilenameFromTarballUrl(
            versionManifest?.dist?.tarball
          );
          const selectedFilename =
            (currentFilename && localFilenames.includes(currentFilename) && currentFilename) ||
            localFilenames[0];

          if (!selectedFilename) continue;

          if (!versionManifest.dist) {
            versionManifest.dist = {};
          }

          if (currentFilename !== selectedFilename) {
            versionManifest.dist.tarball = this.rewriteTarballUrl(
              versionManifest.dist.tarball,
              name,
              selectedFilename
            );

            this.logger.debug(
              { packageName: name, version, filename: selectedFilename },
              '[verdaccio-offline-storage/readPackage] Rewrote tarball for @{packageName}@@{version} to @{filename}'
            );
          }
        }

        // Verdaccio tarball 回源依赖 _distfiles。历史导入数据可能只包含 versions[*].dist.tarball，
        // 导致本地 miss 后无法根据 _distfiles 回源。这里按当前 manifest 做一次运行时回填兜底。
        const distfiles = this.ensureDistfilesMap(data);
        let distfilesBackfilled = 0;
        for (const version of versionsToProcess) {
          const versionManifest: any = data.versions?.[version];
          const tarballUrl = versionManifest?.dist?.tarball;
          const shasum = versionManifest?.dist?.shasum;

          if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
            continue;
          }

          const manifestFilename = this.extractFilenameFromTarballUrl(tarballUrl);
          if (manifestFilename) {
            if (!distfiles[manifestFilename]) {
              distfilesBackfilled++;
            }
            distfiles[manifestFilename] = this.createDistfileRecord(
              distfiles[manifestFilename],
              tarballUrl,
              shasum
            );
          }

          // 为本地已存在的同版本 tarball 建立别名，兼容旧/新命名格式混用。
          const localFilenames = tarballsByVersion.get(version) || [];
          for (const localFilename of localFilenames) {
            if (!distfiles[localFilename]) {
              distfilesBackfilled++;
            }
            distfiles[localFilename] = this.createDistfileRecord(
              distfiles[localFilename],
              this.rewriteTarballUrl(tarballUrl, name, localFilename),
              shasum
            );
          }
        }

        if (distfilesBackfilled > 0) {
          this.logger.debug(
            { packageName: name, count: distfilesBackfilled },
            '[verdaccio-offline-storage/readPackage] Backfilled @{count} _distfiles entries for @{packageName}'
          );
        }

        // 离线模式下，将 dist-tags.latest 对齐到本地可用的最高版本
        if (offline && versionsToProcess.length > 0) {
          const sortedVersions = versionsToProcess
            .filter((v) => semver.valid(v))
            .sort((a, b) => semver.compare(b, a));

          // Prefer stable versions over prereleases
          const stableVersions = sortedVersions.filter((v) => !semver.prerelease(v));
          const latestVersion = stableVersions.length > 0 ? stableVersions[0] : sortedVersions[0];

          if (latestVersion) {
            data['dist-tags'] = data['dist-tags'] || {};
            data['dist-tags'].latest = latestVersion;

            this.logger.debug(
              { packageName: name, latest: latestVersion },
              '[verdaccio-offline-storage/readPackage] Set latest version to @{latest} for package: @{packageName}'
            );
          }
        }

        cb(null, data);
      } catch (readErr: any) {
        this.logger.error(
          { err: readErr.message, packageName: name },
          '[verdaccio-offline-storage/readPackage] Error discovering package "@{packageName}" files: @{err}'
        );
        cb(readErr, data);
      }
    });
  }

  /**
   * 读取 tarball 时兼容两种 scoped 包命名格式：
   * 1) package-x.y.z.tgz
   * 2) scope-package-x.y.z.tgz
   */
  readTarball(name: string): any {
    const resolvedTarballName = this.resolveTarballNameForRead(name);
    if (resolvedTarballName !== name) {
      this.logger.debug(
        { requested: name, resolved: resolvedTarballName },
        '[verdaccio-offline-storage/readTarball] Remapped tarball @{requested} -> @{resolved}'
      );
    }

    return super.readTarball(resolvedTarballName);
  }

  private extractVersionFromTarballFilename(filename: string): string | null {
    const baseName = filename.replace('.tgz', '');
    const versionMatch = baseName.match(
      /-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?)$/
    );

    if (!versionMatch) {
      return null;
    }

    const version = versionMatch[1];
    return semver.valid(version) ? version : null;
  }

  private extractFilenameFromTarballUrl(tarball?: string): string | undefined {
    if (!tarball || typeof tarball !== 'string') {
      return undefined;
    }

    const decoded = tarball.split('?')[0].split('#')[0];
    const segments = decoded.split('/');
    const last = segments[segments.length - 1];
    return last && last.endsWith('.tgz') ? last : undefined;
  }

  private rewriteTarballUrl(
    existingTarball: string | undefined,
    packageName: string,
    filename: string
  ): string {
    if (!existingTarball || typeof existingTarball !== 'string') {
      return `${packageName}/-/${filename}`;
    }

    const markerIndex = existingTarball.lastIndexOf('/-/');
    if (markerIndex >= 0) {
      return `${existingTarball.substring(0, markerIndex + 3)}${filename}`;
    }

    const slashIndex = existingTarball.lastIndexOf('/');
    if (slashIndex >= 0) {
      return `${existingTarball.substring(0, slashIndex + 1)}${filename}`;
    }

    return `${packageName}/-/${filename}`;
  }

  private ensureDistfilesMap(manifest: Manifest): Record<string, any> {
    const raw = manifest as any;
    if (!raw._distfiles || typeof raw._distfiles !== 'object') {
      raw._distfiles = {};
    }
    return raw._distfiles as Record<string, any>;
  }

  private createDistfileRecord(
    existing: any,
    url: string,
    shasum?: string
  ): Record<string, any> {
    const record: Record<string, any> =
      existing && typeof existing === 'object' ? { ...existing } : {};

    record.url = url;
    if (!record.sha && typeof shasum === 'string' && shasum.length > 0) {
      record.sha = shasum;
    }

    return record;
  }

  private resolveTarballNameForRead(requestedTarballName: string): string {
    const requestedPath = join(this.path, requestedTarballName);
    if (existsSync(requestedPath)) {
      return requestedTarballName;
    }

    const version = this.extractVersionFromTarballFilename(requestedTarballName);
    if (!version) {
      return requestedTarballName;
    }

    // 先按当前包目录推导最可能的命名
    for (const candidate of this.getScopedTarballNameCandidates(version)) {
      if (existsSync(join(this.path, candidate))) {
        return candidate;
      }
    }

    // 回退：目录里找任意同版本 tarball
    try {
      const files = readdirSync(this.path)
        .filter((file) => file.endsWith('.tgz'))
        .filter((file) => this.extractVersionFromTarballFilename(file) === version)
        .sort();

      if (files.length > 0) {
        return files[0];
      }
    } catch {
      // 忽略目录读取错误，继续使用原始名称
    }

    return requestedTarballName;
  }

  private computeTarballShasum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sha1 = createHash('sha1');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk: Buffer | string) => sha1.update(chunk));
      stream.on('end', () => resolve(sha1.digest('hex')));
      stream.on('error', reject);
    });
  }

  private getScopedTarballNameCandidates(version: string): string[] {
    const packageBase = basename(this.path);
    const scopeBase = basename(dirname(this.path));

    const candidates = [`${packageBase}-${version}.tgz`];
    if (scopeBase.startsWith('@')) {
      candidates.push(`${scopeBase.substring(1)}-${packageBase}-${version}.tgz`);
    }

    return Array.from(new Set(candidates));
  }
}
