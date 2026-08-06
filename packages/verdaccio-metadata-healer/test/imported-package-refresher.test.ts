import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Logger, Manifest } from '@verdaccio/types';

import { ImportedPackageRefresher } from '../src/imported-package-refresher';

const temporaryDirectories: string[] = [];

const logger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe('ImportedPackageRefresher', () => {
  it('heals a newly imported version, advances latest, and registers the package list', async () => {
    const storagePath = await mkdtemp(path.join(tmpdir(), 'import-refresher-'));
    temporaryDirectories.push(storagePath);
    await mkdir(path.join(storagePath, 'demo'), { recursive: true });
    await writeFile(path.join(storagePath, 'demo', 'package.json'), JSON.stringify({
      name: 'demo',
      versions: { '1.0.0': { name: 'demo', version: '1.0.0' } },
      'dist-tags': { latest: '1.0.0' }
    }));

    let persisted: Manifest | undefined;
    const registered: string[] = [];
    const verdaccioStorage = {
      localStorage: {
        _getLocalStorage: () => ({
          upsertPackage(_name: string, manifest: Manifest, callback: (error?: Error | null) => void) {
            persisted = manifest;
            callback(null);
          }
        }),
        storagePlugin: {
          add(name: string, callback: (error?: Error | null) => void) {
            registered.push(name);
            callback(null);
          }
        }
      }
    };
    const refresher = new ImportedPackageRefresher(
      { enabled: true },
      storagePath,
      logger,
      verdaccioStorage
    );
    (refresher as any).scanner = {
      clearCache() {},
      scanPackageTarballs: async () => [
        { filename: 'demo-1.0.0.tgz', version: '1.0.0' },
        { filename: 'demo-2.0.0.tgz', version: '2.0.0' },
        { filename: 'demo-3.0.0.tgz', version: '3.0.0' }
      ]
    };
    (refresher as any).patcher.patchManifest = async (
      manifest: Manifest,
      missing: Array<{ version: string }>
    ) => {
      for (const { version } of missing) {
        // 模拟损坏的 3.0.0 tarball 被 MetadataPatcher 跳过。
        if (version !== '3.0.0') {
          manifest.versions[version] = { name: 'demo', version } as any;
        }
      }
      return manifest;
    };
    const progress: Array<{ processed: number; total: number; packageName: string }> = [];

    await refresher.refresh(['demo'], (processed, total, packageName) => {
      progress.push({ processed, total, packageName });
    });

    assert.equal(persisted?.versions['2.0.0'].version, '2.0.0');
    assert.equal(persisted?.['dist-tags'].latest, '2.0.0');
    assert.deepEqual(registered, ['demo']);
    assert.deepEqual(progress, [{ processed: 1, total: 1, packageName: 'demo' }]);
  });
});
