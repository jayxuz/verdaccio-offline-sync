import { readdir } from 'fs/promises';
import { basename } from 'path';
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
  }

  /**
   * Computes a package's definition that only lists the locally available versions.
   */
  readPackage(name: string, cb: Callback): void {
    const packageAccess = this.config.getMatchedPackagesSpec
      ? this.config.getMatchedPackagesSpec(name)
      : { proxy: [] };

    // It's offline if set explicitly in the config or if no proxy is defined for the package
    const offline = this.config.offline || !packageAccess?.proxy || packageAccess.proxy.length === 0;

    if (!offline) {
      this.logger.debug(
        { packageName: name },
        '[verdaccio-offline-storage/readPackage] Resolving package @{packageName} in online mode'
      );
      super.readPackage(name, cb);
      return;
    }

    this.logger.debug(
      { packageName: name },
      '[verdaccio-offline-storage/readPackage] Resolving package @{packageName} in offline mode'
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
        const localVersions = items
          .filter((item: string) => item.endsWith('.tgz'))
          .map((item: string) => {
            // Extract version from filename: package-name-1.0.0.tgz -> 1.0.0
            const baseName = basename(name);
            return item.substring(baseName.length + 1, item.length - 4);
          })
          .filter((v: string) => semver.valid(v));

        this.logger.debug(
          { packageName: name, count: localVersions.length },
          '[verdaccio-offline-storage/readPackage] Discovered @{count} local versions for package: @{packageName}'
        );

        const allVersions = Object.keys(data.versions || {});
        const originalVersionCount = allVersions.length;

        // Remove versions that are not locally available
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

        // Update dist-tags.latest to the highest locally available version
        const availableVersions = Object.keys(data.versions);
        if (availableVersions.length > 0) {
          const sortedVersions = availableVersions
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
}
