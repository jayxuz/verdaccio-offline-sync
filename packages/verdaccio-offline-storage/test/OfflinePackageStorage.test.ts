import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Callback, Logger, Manifest } from '@verdaccio/types';

import { OfflinePackageStorage } from '../src/OfflinePackageStorage';
import type { OfflineStorageConfig } from '../src/types';

const temporaryDirectories: string[] = [];

const logger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

async function createStorage(manifest: Manifest): Promise<{
  directory: string;
  storage: OfflinePackageStorage;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'offline-package-storage-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));

  return {
    directory,
    storage: new OfflinePackageStorage(directory, logger, {
      offline: false
    } as OfflineStorageConfig)
  };
}

function updateWithLegacyAttachment(storage: OfflinePackageStorage): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.updatePackage(
      '@opentelemetry/sdk-metrics',
      (data: Manifest, cb: Callback) => {
        try {
          (data._attachments as Record<string, unknown>)['sdk-metrics-2.2.0.tgz'] = {
            shasum: 'demo'
          };
          cb(null);
        } catch (error) {
          cb(error as Error);
        }
      },
      (name: string, data: Manifest, cb: Callback) => storage.savePackage(name, data, cb),
      (data: Manifest) => data,
      (error?: Error | null) => (error ? reject(error) : resolve())
    );
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe('OfflinePackageStorage manifest boundaries', () => {
  it('normalizes a legacy manifest before the updater mutates attachments', async () => {
    const { directory, storage } = await createStorage({
      name: '@opentelemetry/sdk-metrics',
      versions: {},
      'dist-tags': {}
    } as Manifest);

    await updateWithLegacyAttachment(storage);

    const stored = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(stored._attachments['sdk-metrics-2.2.0.tgz'], { shasum: 'demo' });
    assert.deepEqual(stored._distfiles, {});
    assert.deepEqual(stored._uplinks, {});
    assert.deepEqual(stored.time, {});
  });
});
