import { getReadCacheManager, ReadCacheManager, selectLockfilePackages } from './read-cache';
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
  private readCache!: ReadCacheManager;
  protected config: OfflineStorageConfig;
  protected logger: Logger;
  protected data: { list: string[] };

  constructor(config: OfflineStorageConfig, options: PluginOptions) {
    if (config.metadataPolicy && !['preserve', 'local-latest'].includes(config.metadataPolicy)) throw new Error('Unknown metadataPolicy');
    if (config.metadataPolicy === 'preserve') {
      const middleware = Object.entries((options.config as any).middlewares || {}).find(([name]) => name.endsWith('metadata-healer'))?.[1] as any;
      if (config.offline !== true || middleware?.metadataPolicy !== 'preserve') throw new Error('metadataPolicy preserve requires offline: true and middlewares.metadata-healer.metadataPolicy: preserve');
    }
    super(config, options.logger);
    this.config = config;
    this.logger = options.logger;
    this.data = { list: [] };
    this.readCache = getReadCacheManager(config, config.storage as string);
    const warmup = config.readCache?.warmup;
    if (warmup?.packages?.length || warmup?.lockfile) setImmediate(async () => {
      try {
        const names = [...(warmup.packages || []), ...(warmup.lockfile ? await selectLockfilePackages(warmup.lockfile, warmup.maxPackages) : [])];
        this.readCache.startWarmup(names);
      } catch (error: any) { this.logger.warn({ error: error.message }, 'Read-cache warmup was not started'); }
    });


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
  getMetadataPolicy(): string { return this.config.metadataPolicy || 'local-latest'; }
  /** Read through the verified cache again after Verdaccio's own response normalization. */
  async preserveResponseMetadata(name: string, result: any, abbreviated = false): Promise<any> {
    const local: any = await new Promise((resolve, reject) => (this.getPackageStorage(name) as any).readPackage(name, (error: any, value: any) => error ? reject(error) : resolve(value)));
    result['dist-tags'] = Object.fromEntries(Object.entries(local['dist-tags']).filter(([, version]) => typeof version === 'string' && result.versions?.[version]));
    if (!abbreviated || Object.prototype.hasOwnProperty.call(result, 'time')) result.time = { ...local.time };
    return result;
  }
  rebuildReadCache(): Promise<any> { return this.readCache.rebuildPersistent(); }
  getReadCacheMetrics(): any { return { ...this.readCache.stats(), metadataPolicy: this.getMetadataPolicy() }; }
  warmReadCache(packages: string[], forceRehash = false): any { return this.readCache.startWarmup(packages, forceRehash); }
  async warmReadCacheFromLockfile(file: string, forceRehash = false): Promise<any> {
    return this.readCache.startWarmup(await selectLockfilePackages(file, this.config.readCache?.warmup?.maxPackages), forceRehash);
  }
  cancelReadCacheWarmup(): any { return this.readCache.cancelWarmup(); }


}
