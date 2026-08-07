import { readFile } from 'fs/promises';
import path from 'path';
import { Logger, Manifest } from '@verdaccio/types';
import { MetadataPatcher } from './metadata-patcher';
import { ShasumCache } from './shasum-cache';
import { StorageScanner } from './storage-scanner';
import {
  HealerConfig,
  ImportRebuildProgressCallback,
  PackageRebuildResult
} from './types';

/**
 * Rebuilds imported package metadata and registers the package in Verdaccio's
 * local database. ImportHandler deliberately delegates this work because raw
 * file copies must be coordinated through Verdaccio's package storage API.
 */
export class ImportedPackageRefresher {
  private config: HealerConfig;
  private logger: Logger;
  private storagePath: string;
  private verdaccioStorage: any;
  private scanner: StorageScanner;
  private patcher: MetadataPatcher;
  private shasumCache: ShasumCache;

  constructor(
    config: HealerConfig,
    storagePath: string,
    logger: Logger,
    verdaccioStorage: any
  ) {
    this.config = config;
    this.storagePath = storagePath;
    this.logger = logger;
    this.verdaccioStorage = verdaccioStorage;
    this.scanner = new StorageScanner(config, storagePath, logger);
    this.patcher = new MetadataPatcher(config, logger);
    this.shasumCache = new ShasumCache(config, logger);
  }

  async refresh(
    packageNames: string[],
    onProgress?: ImportRebuildProgressCallback
  ): Promise<void> {
    const uniqueNames = Array.from(new Set(packageNames));
    const total = uniqueNames.length;
    if (total === 0) {
      return;
    }

    const concurrency = this.getConcurrency();
    let nextIndex = 0;
    let completed = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, total) },
      async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= total) {
            return;
          }

          const packageName = uniqueNames[index];
          await this.rebuildPackage(packageName);
          completed++;
          onProgress?.(completed, total, packageName);
        }
      }
    );

    await Promise.all(workers);
  }

  async rebuildPackage(packageName: string): Promise<PackageRebuildResult> {
    this.scanner.clearCache(packageName);
    const tarballs = await this.scanner.scanPackageTarballs(packageName);
    if (tarballs.length === 0) {
      this.logger.debug(
        { packageName },
        '[Import] Skipping metadata rebuild for @{packageName}: no local tarballs'
      );
      return {
        success: true,
        packageName,
        tarballs: 0,
        localVersions: 0,
        healedVersions: 0,
        skipped: true
      };
    }

    const manifest = await this.readLocalManifest(packageName) || {
      name: packageName,
      versions: {},
      'dist-tags': {}
    } as Manifest;
    const existingVersions = new Set(Object.keys(manifest.versions || {}));
    const missingVersions = tarballs.filter(({ version }) => !existingVersions.has(version));
    const rebuilt = missingVersions.length > 0
      ? await this.patcher.patchManifest(manifest, missingVersions, this.shasumCache)
      : manifest;
    const healedVersions = missingVersions.filter(
      ({ version }) => Boolean(rebuilt.versions?.[version])
    ).length;

    this.patcher.updateDistTags(rebuilt, tarballs.map(({ version }) => version));
    rebuilt.time = rebuilt.time || {};
    rebuilt.time.modified = new Date().toISOString();

    await this.persistManifest(packageName, rebuilt);
    await this.registerPackage(packageName);

    this.logger.info(
      { packageName, versions: tarballs.length, healed: healedVersions },
      '[Import] Rebuilt @{packageName}: @{versions} local versions, @{healed} healed'
    );

    const localVersionSet = new Set(tarballs.map(({ version }) => version));
    const localVersions = Object.keys(rebuilt.versions || {})
      .filter((version) => localVersionSet.has(version)).length;
    return {
      success: true,
      packageName,
      tarballs: tarballs.length,
      localVersions,
      healedVersions,
      latest: rebuilt['dist-tags']?.latest,
      skipped: false
    };
  }

  private async readLocalManifest(packageName: string): Promise<Manifest | null> {
    const manifestPath = path.join(this.storagePath, packageName, 'package.json');
    try {
      return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async persistManifest(packageName: string, manifest: Manifest): Promise<void> {
    const localStorage = this.verdaccioStorage?.localStorage;
    const getPackageStorage = localStorage?._getLocalStorage;
    const packageStorage = typeof getPackageStorage === 'function'
      ? getPackageStorage.call(localStorage, packageName)
      : undefined;

    if (!packageStorage || typeof packageStorage.upsertPackage !== 'function') {
      throw new Error(`Package storage for ${packageName} does not support upsertPackage`);
    }

    await new Promise<void>((resolve, reject) => {
      packageStorage.upsertPackage(
        packageName,
        manifest,
        (error?: Error | null) => error ? reject(error) : resolve()
      );
    });
  }

  private async registerPackage(packageName: string): Promise<void> {
    const storagePlugin = this.verdaccioStorage?.localStorage?.storagePlugin;
    const add = storagePlugin?.add;
    if (typeof add !== 'function') {
      throw new Error(`Verdaccio storage database does not support registering ${packageName}`);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };

      try {
        const result = add.call(storagePlugin, packageName, finish);
        if (result && typeof result.then === 'function') {
          result.then(() => finish(), finish);
        } else if (add.length < 2) {
          finish();
        }
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  private getConcurrency(): number {
    const configured = Number(this.config.syncConcurrency);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 5;
    }
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }
}
