import { join } from 'path';
import { readdir } from 'fs/promises';
import { Logger, Callback } from '@verdaccio/types';
import { pluginUtils } from '@verdaccio/core';
import { OfflineStorageConfig, PluginOptions } from './types';
import { OfflinePackageStorage } from './OfflinePackageStorage';

// Import LocalDatabase - try multiple package names for compatibility
let LocalDatabase: any;
try {
  // Try @verdaccio/local-storage-legacy first (used by Verdaccio 6.x)
  LocalDatabase = require('@verdaccio/local-storage-legacy').LocalDatabase ||
                  require('@verdaccio/local-storage-legacy').default;
} catch {
  try {
    // Fallback to @verdaccio/local-storage (newer versions)
    LocalDatabase = require('@verdaccio/local-storage').LocalDatabase ||
                    require('@verdaccio/local-storage').default;
  } catch (e) {
    console.error('[verdaccio-offline-storage] Failed to load LocalDatabase:', e);
    throw new Error('Could not load LocalDatabase from @verdaccio/local-storage-legacy or @verdaccio/local-storage');
  }
}

/**
 * Verdaccio storage plugin that provides only the locally available versions of
 * packages cached in a local-storage storage.
 *
 * This is just like local-storage but modifying on the fly the available packages list
 * and the packages definitions without altering the original files in the local-storage storage.
 *
 * @see https://verdaccio.org/docs/en/plugin-storage
 */
export default class OfflineStoragePlugin extends LocalDatabase {
  protected config: OfflineStorageConfig;
  protected logger: Logger;
  protected data: { list: string[] };

  constructor(config: OfflineStorageConfig, options: PluginOptions) {
    super(config, options.logger);
    this.config = config;
    this.logger = options.logger;
    this.data = { list: [] };

    if (config.offline) {
      this.logger.warn(
        {},
        '[verdaccio-offline-storage] Offline mode set explicitly in config. All packages will be resolved in offline mode.'
      );
    } else {
      this.logger.warn(
        {},
        '[verdaccio-offline-storage] Offline mode NOT set explicitly in config. Only packages with no `proxy` will be resolved in offline mode.'
      );
    }
  }

  /**
   * Retrieves all the locally available packages names.
   * Packages with no cached versions (only package.json file in the directory) are ignored.
   */
  get(callback: Callback): void {
    const packages: string[] = [];

    this.search(
      (item: { name: string; path: string }, cb: (err?: Error | null) => void) => {
        this.logger.debug(
          { packageName: item.name },
          '[verdaccio-offline-storage/get] Discovering local versions for package: @{packageName}'
        );

        readdir(item.path)
          .then((items) => {
            const hasTgz = items.some((file) => file.endsWith('.tgz'));
            if (hasTgz) {
              packages.push(item.name);
              this.logger.trace(
                { packageName: item.name },
                '[verdaccio-offline-storage/get] Found locally available package: "@{packageName}"'
              );
            } else {
              this.logger.trace(
                { packageName: item.name },
                '[verdaccio-offline-storage/get] No locally available version found for package: "@{packageName}"'
              );
            }
            cb();
          })
          .catch((err) => {
            this.logger.trace(
              { err: err.message, packageName: item.name },
              '[verdaccio-offline-storage/get] Error discovering package "@{packageName}\" files: @{err}'
            );
            cb(err);
          });
      },
      () => {
        this.data.list = packages;
        callback(null, packages);
        this.logger.debug(
          { totalItems: packages.length },
          '[verdaccio-offline-storage/get] Full list of packages (@{totalItems}) has been fetched'
        );
      },
      (name: string) => !name.startsWith('.') // Ignore .verdaccio-db.json etc.
    );
  }

  /**
   * Returns the IPackageStorage used internally for packages I/O operations.
   */
  getPackageStorage(packageName: string): pluginUtils.StorageHandler {
    const storagePath = join(this.config.storage as string, packageName);

    this.logger.warn(
      { packageName, storagePath },
      '[verdaccio-offline-storage/getPackageStorage] Creating storage for package @{packageName} at @{storagePath}'
    );

    return new OfflinePackageStorage(storagePath, this.logger, this.config) as unknown as pluginUtils.StorageHandler;
  }
}
