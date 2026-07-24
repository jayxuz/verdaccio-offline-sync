import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Logger, Manifest } from '@verdaccio/types';

import { normalizeLocalManifest } from '../../verdaccio-offline-storage/src/manifest-utils';
import { PackageDownloader } from '../src/package-downloader';
import type { PackumentPersistence } from '../src/packument-persistence';

const temporaryDirectories: string[] = [];

function createLogger(): { logger: Logger; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  return {
    errors,
    logger: {
      debug() {},
      error(context: Record<string, unknown>) { errors.push(context); },
      info() {},
      trace() {},
      warn() {}
    } as unknown as Logger
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe('PackageDownloader.savePackument', () => {
  it('uses the manifest-only persistence dependency', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'package-downloader-'));
    temporaryDirectories.push(storagePath);
    const { logger } = createLogger();
    const calls: Array<{ packageName: string; packument: unknown }> = [];
    const persistPackument: PackumentPersistence = async (_storage, packageName, packument) => {
      calls.push({ packageName, packument });
    };
    const downloader = new PackageDownloader(
      { enabled: true },
      storagePath,
      logger,
      {},
      persistPackument
    );
    const packument = { name: 'demo', versions: {}, 'dist-tags': {} };

    await downloader.savePackument('demo', packument);

    assert.deepEqual(calls, [{ packageName: 'demo', packument }]);
  });

  it('uses package storage upsert and leaves no directly-written package.json', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'package-downloader-'));
    temporaryDirectories.push(storagePath);
    const { logger } = createLogger();
    let stored: Manifest | undefined;
    let upsertCalls = 0;
    const packageStorage = {
      upsertPackage(_name: string, incoming: Manifest, callback: (error?: Error | null) => void) {
        upsertCalls++;
        stored = normalizeLocalManifest({ ...incoming } as Manifest);
        callback(null);
      }
    };
    const verdaccioStorage = {
      localStorage: {
        _getLocalStorage(packageName: string) {
          assert.equal(packageName, 'demo');
          return packageStorage;
        }
      }
    };
    const downloader = new PackageDownloader(
      { enabled: true },
      storagePath,
      logger,
      verdaccioStorage
    );
    const pacotePackument = {
      name: 'demo',
      versions: {},
      'dist-tags': {}
    };

    await downloader.savePackument('demo', pacotePackument);

    assert.equal(upsertCalls, 1);
    assert.deepEqual(stored?._attachments, {});
    assert.deepEqual(stored?._distfiles, {});
    assert.deepEqual(stored?._uplinks, {});
    assert.deepEqual(stored?.time, {});
    await assert.rejects(access(join(storagePath, 'demo', 'package.json')), { code: 'ENOENT' });
  });

  it('fails explicitly when Verdaccio package storage has no upsert capability', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'package-downloader-'));
    temporaryDirectories.push(storagePath);
    const { logger, errors } = createLogger();
    const downloader = new PackageDownloader(
      { enabled: true },
      storagePath,
      logger,
      { localStorage: { _getLocalStorage: () => ({}) } }
    );

    await assert.rejects(
      downloader.savePackument('demo', { name: 'demo', versions: {}, 'dist-tags': {} }),
      /Package storage for demo does not support upsertPackage/
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].packageName, 'demo');
    await assert.rejects(access(join(storagePath, 'demo', 'package.json')), { code: 'ENOENT' });
  });

  it('keeps the public three-argument constructor and reports missing storage by package name', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'package-downloader-'));
    temporaryDirectories.push(storagePath);
    const { logger, errors } = createLogger();
    const downloader = new PackageDownloader({ enabled: true }, storagePath, logger);

    await assert.rejects(
      downloader.savePackument('three-arg-demo', {
        name: 'three-arg-demo',
        versions: {},
        'dist-tags': {}
      }),
      /Package storage for three-arg-demo does not support upsertPackage/
    );
    assert.equal(errors[0].packageName, 'three-arg-demo');
  });
});
