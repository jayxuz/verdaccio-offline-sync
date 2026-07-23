import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Logger, Manifest } from '@verdaccio/types';

import MetadataHealerFilter from '../src/healer-filter';
import { MetadataSyncer } from '../src/metadata-syncer';

const temporaryDirectories: string[] = [];

function createLogger(): {
  logger: Logger;
  warnings: Array<Record<string, unknown>>;
} {
  const warnings: Array<Record<string, unknown>> = [];
  return {
    warnings,
    logger: {
      debug() {},
      error() {},
      info() {},
      trace() {},
      warn(context: Record<string, unknown>) { warnings.push(context); }
    } as unknown as Logger
  };
}

async function createFilter(verdaccioStorage?: any): Promise<{
  filter: MetadataHealerFilter;
  storagePath: string;
  warnings: Array<Record<string, unknown>>;
}> {
  const storagePath = await mkdtemp(join(tmpdir(), 'metadata-healer-'));
  temporaryDirectories.push(storagePath);
  const { logger, warnings } = createLogger();
  const filter = new MetadataHealerFilter(
    { enabled: true, autoSaveMetadata: true, enableImportUI: false },
    { logger, config: { storage: storagePath } } as any
  );
  if (verdaccioStorage) {
    filter.register_middlewares({} as any, {}, verdaccioStorage);
  }
  return { filter, storagePath, warnings };
}

function remoteManifest(): Manifest {
  return {
    name: 'demo',
    versions: {
      '2.0.0': {
        name: 'demo',
        version: '2.0.0',
        dist: {
          tarball: 'https://registry.example/demo/-/demo-2.0.0.tgz',
          shasum: 'remote-sha'
        }
      }
    },
    'dist-tags': { latest: '2.0.0' }
  } as unknown as Manifest;
}

function localManifest(): Manifest {
  return {
    name: 'demo',
    versions: { '1.0.0': { name: 'demo', version: '1.0.0' } },
    'dist-tags': { latest: '1.0.0' },
    _attachments: { 'demo-1.0.0.tgz': { shasum: 'local-sha' } }
  } as unknown as Manifest;
}

function injectSyncer(filter: MetadataHealerFilter, storagePath: string): void {
  const syncer = new MetadataSyncer({ enabled: true }, storagePath, (filter as any).logger);
  syncer.fetchRemoteMetadata = async () => remoteManifest();
  syncer.readLocalMetadata = async () => localManifest();
  (filter as any).syncer = syncer;
  (filter as any).initialized = true;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe('MetadataHealerFilter storage persistence', () => {
  it('returns filter metadata without writing package.json when middleware storage is absent', async () => {
    const { filter, storagePath, warnings } = await createFilter();
    const manifest = remoteManifest();

    const result = await filter.filter_metadata(manifest);
    await new Promise((resolve) => setTimeout(resolve, 75));

    assert.equal(result, manifest);
    await assert.rejects(access(join(storagePath, 'demo', 'package.json')), { code: 'ENOENT' });
    assert.equal(warnings.some((entry) => entry.packageName === 'demo'), true);
  });

  it('uses upsertPackage for sync and preserves local attachments', async () => {
    let upserted: Manifest | undefined;
    const packageStorage = {
      upsertPackage(_name: string, manifest: Manifest, callback: (error?: Error | null) => void) {
        upserted = manifest;
        callback(null);
      }
    };
    const verdaccioStorage = {
      localStorage: { _getLocalStorage: () => packageStorage }
    };
    const { filter, storagePath } = await createFilter(verdaccioStorage);
    injectSyncer(filter, storagePath);

    const result = await (filter as any).syncPackageViaStorage('demo');

    assert.equal(result.success, true);
    assert.deepEqual(upserted?._attachments, localManifest()._attachments);
    assert.equal(upserted?.versions['2.0.0'].version, '2.0.0');
    await assert.rejects(access(join(storagePath, 'demo', 'package.json')), { code: 'ENOENT' });
  });

  it('reports storage errors without falling back to direct file writes', async () => {
    const packageStorage = {
      upsertPackage(_name: string, _manifest: Manifest, callback: (error?: Error | null) => void) {
        callback(new Error('storage failed'));
      }
    };
    const { filter, storagePath } = await createFilter({
      localStorage: { _getLocalStorage: () => packageStorage }
    });
    injectSyncer(filter, storagePath);

    const result = await (filter as any).syncPackageViaStorage('demo');

    assert.equal(result.success, false);
    assert.match(result.error, /storage failed/);
    await assert.rejects(access(join(storagePath, 'demo', 'package.json')), { code: 'ENOENT' });
  });

  it('marks sync-all failed after continuing past individual package failures', async () => {
    const { filter } = await createFilter();
    const attempted: string[] = [];
    (filter as any).syncer = { clearRemoteMetadataCache() {} };
    (filter as any).syncTasks.set('sync-task', {
      taskId: 'sync-task',
      status: 'pending'
    });
    (filter as any).syncPackageViaStorage = async (packageName: string) => {
      attempted.push(packageName);
      if (packageName === 'broken') {
        return {
          success: false,
          packageName,
          versionsCount: 0,
          distTags: {},
          error: 'storage failed'
        };
      }
      return {
        success: true,
        packageName,
        versionsCount: 1,
        distTags: { latest: '1.0.0' }
      };
    };

    await (filter as any).executeSyncAll('sync-task', ['broken', 'working']);

    const task = (filter as any).syncTasks.get('sync-task');
    assert.deepEqual(attempted.sort(), ['broken', 'working']);
    assert.equal(task.status, 'failed');
    assert.equal(task.progress, 100);
    assert.match(task.error, /broken: storage failed/);
    assert.equal(task.results.length, 2);
  });
});
