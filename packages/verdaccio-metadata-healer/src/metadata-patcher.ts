import { projectPackageFields } from './mirror-core';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import tar from 'tar-stream';
import semver from 'semver';
import { Logger, Manifest, Version, Dist } from '@verdaccio/types';
import { HealerConfig, TarballInfo } from './types';
import { ShasumCache } from './shasum-cache';

/**
 * 元数据修补器 - 动态修复缺失的版本信息
 */
export class MetadataPatcher {
  private config: HealerConfig;
  private logger: Logger;

  constructor(config: HealerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * 修补 manifest，注入缺失的版本信息
   */
  async patchManifest(
    manifest: Manifest,
    missingVersions: TarballInfo[],
    shasumCache: ShasumCache
  ): Promise<Manifest> {
    const patchedManifest = { ...manifest };

    // 确保必要的字段存在
    if (!patchedManifest.versions) {
      patchedManifest.versions = {};
    }
    if (!patchedManifest._attachments) {
      patchedManifest._attachments = {};
    }
    if (!(patchedManifest as any)._distfiles) {
      (patchedManifest as any)._distfiles = {};
    }
    if (!patchedManifest.time) {
      patchedManifest.time = {};
    }

    for (const tarball of missingVersions) {
      try {
        // 从 tarball 中提取 package.json
        const packageJson = await this.extractPackageJson(tarball.path);

        // 计算或获取缓存的 shasum
        const { shasum, integrity } = await shasumCache.getOrCompute(tarball.path);

        // 构建 Version 对象
        const version = this.buildVersionObject(
          packageJson,
          tarball,
          shasum,
          integrity
        );

        // 添加到 manifest
        patchedManifest.versions[tarball.version] = version;

        // 更新 _attachments
        patchedManifest._attachments[tarball.filename] = {
          shasum,
          version: tarball.version
        } as any;

        (patchedManifest as any)._distfiles[tarball.filename] = {
          url: version.dist.tarball,
          sha: shasum
        };

        // 更新 time
        // A cached tgz does not establish an authoritative publication timestamp.

        this.logger.debug(
          { version: tarball.version },
          'Patched version @{version}'
        );
      } catch (error: any) {
        this.logger.warn(
          { version: tarball.version, error: error.message },
          'Failed to patch version @{version}: @{error}'
        );
      }
    }

    // 更新 modified 时间
    patchedManifest.time.modified = new Date().toISOString();

    return patchedManifest;
  }

  /**
   * 从 tarball 中提取 package.json
   */
  private async extractPackageJson(tarballPath: string): Promise<any> {
    const extract = tar.extract();
    let packageJson: any, hasBindingGyp = false, manifests = 0, expanded = 0, entries = 0;
    extract.on('entry', (header, stream, next) => {
      if (++entries > 500000) { extract.destroy(new Error('Tarball entry limit')); return; }
      const name = header.name.replace(/^(\.\/)+/, '');
      if (name === 'package/binding.gyp') hasBindingGyp = true;
      if (name !== 'package/package.json') { stream.resume(); stream.on('end', next); return; }
      if (++manifests !== 1 || header.type !== 'file' || (header.size || 0) > 16 * 1024 ** 2) { extract.destroy(new Error('Invalid package manifest in tgz')); return; }
      const chunks: Buffer[] = []; let size = 0;
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 ** 2) extract.destroy(new Error('Package JSON size limit')); else chunks.push(chunk); });
      stream.on('end', () => { try { packageJson = JSON.parse(Buffer.concat(chunks).toString('utf8')); next(); } catch (error) { extract.destroy(error as Error); } });
    });
    const limit = new Transform({ transform(chunk, _encoding, callback) { expanded += chunk.length; callback(expanded > 20 * 1024 ** 3 ? new Error('Tarball expansion limit') : null, chunk); } });
    await pipeline(createReadStream(tarballPath), createGunzip(), limit, extract);
    if (!packageJson) throw new Error('package/package.json not found in tarball');
    Object.defineProperty(packageJson, '__mirrorHasBindingGyp', { value: hasBindingGyp, enumerable: false });
    return packageJson;
  }

  /**
   * 构建 Version 对象
   */
  private buildVersionObject(
    packageJson: any,
    tarball: TarballInfo,
    shasum: string,
    integrity: string
  ): Version {
    const host = this.config.host || 'localhost:4873';

    // 构建 tarball URL
    const tarballUrl = `http://${host}/${packageJson.name}/-/${tarball.filename}`;

    const dist: Dist = {
      shasum,
      integrity,
      tarball: tarballUrl
    };

    // 构建完整的 Version 对象
    const version = {
      ...projectPackageFields(packageJson),
      name: packageJson.name,
      version: tarball.version,
      description: packageJson.description || '',
      main: packageJson.main || 'index.js',
      scripts: packageJson.scripts || {},
      hasInstallScript: Boolean(packageJson.scripts?.preinstall || packageJson.scripts?.install || packageJson.scripts?.postinstall || (packageJson.__mirrorHasBindingGyp && packageJson.gypfile !== false)),
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
      peerDependencies: packageJson.peerDependencies || {},
      optionalDependencies: packageJson.optionalDependencies || {},
      engines: packageJson.engines || {},
      repository: packageJson.repository,
      keywords: packageJson.keywords || [],
      author: packageJson.author || '',
      license: packageJson.license || '',
      bugs: packageJson.bugs,
      homepage: packageJson.homepage,
      dist,
      _id: `${packageJson.name}@${tarball.version}`
    } as Version;

    return version;
  }

  /**
   * 更新 dist-tags
   */
  updateDistTags(manifest: Manifest, availableVersions?: string[]): void {
    const manifestVersions = new Set(Object.keys(manifest.versions || {}));
    const versions = (availableVersions || Array.from(manifestVersions))
      .filter((version) => manifestVersions.has(version));
    if (versions.length === 0) return;

    // 过滤出有效的 semver 版本
    const validVersions = versions.filter((v) => semver.valid(v));

    if (validVersions.length === 0) return;

    // 按 semver 排序
    const sortedVersions = validVersions.sort((a, b) => {
      try {
        return semver.compare(a, b);
      } catch {
        return a.localeCompare(b);
      }
    });

    // 获取最新的稳定版本（非预发布版本）
    const stableVersions = sortedVersions.filter((v) => !semver.prerelease(v));
    const latestStable =
      stableVersions.length > 0
        ? stableVersions[stableVersions.length - 1]
        : sortedVersions[sortedVersions.length - 1];

    // 确保 dist-tags 存在
    if (!manifest['dist-tags']) {
      manifest['dist-tags'] = {};
    }

    // 始终对齐到本地实际可用的最高稳定版本，升级包导入后立即生效。
    if (manifest['dist-tags'].latest !== latestStable) {
      manifest['dist-tags'].latest = latestStable;

      this.logger.debug(
        { latest: latestStable },
        'Updated dist-tags.latest to @{latest}'
      );
    }
  }
}
