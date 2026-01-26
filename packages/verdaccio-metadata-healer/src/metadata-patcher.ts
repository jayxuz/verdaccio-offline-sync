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

        // 更新 time
        patchedManifest.time[tarball.version] = tarball.mtime.toISOString();

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
  private extractPackageJson(tarballPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const extract = tar.extract();
      let packageJson: any = null;

      extract.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = [];

        // package.json 通常在 package/package.json
        if (
          header.name.endsWith('package.json') &&
          header.name.split('/').length === 2
        ) {
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            try {
              packageJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e) {
              // 忽略解析错误
            }
            next();
          });
        } else {
          stream.resume();
          stream.on('end', next);
        }
      });

      extract.on('finish', () => {
        if (packageJson) {
          resolve(packageJson);
        } else {
          reject(new Error('package.json not found in tarball'));
        }
      });

      extract.on('error', reject);

      createReadStream(tarballPath)
        .pipe(createGunzip())
        .pipe(extract);
    });
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
      name: packageJson.name,
      version: tarball.version,
      description: packageJson.description || '',
      main: packageJson.main || 'index.js',
      scripts: packageJson.scripts || {},
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
  updateDistTags(manifest: Manifest): void {
    const versions = Object.keys(manifest.versions || {});
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

    // 只在没有 latest 或当前 latest 不存在时更新
    if (
      !manifest['dist-tags'].latest ||
      !manifest.versions[manifest['dist-tags'].latest]
    ) {
      manifest['dist-tags'].latest = latestStable;

      this.logger.debug(
        { latest: latestStable },
        'Updated dist-tags.latest to @{latest}'
      );
    }
  }
}
