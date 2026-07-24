import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Callback, Logger, Manifest } from '@verdaccio/types';

import { OfflinePackageStorage } from '../src/OfflinePackageStorage';
import type { OfflineStorageConfig } from '../src/types';

type LegacyStoragePrototype = {
  createPackage(name: string, value: Manifest, cb: Callback): void;
  updatePackage(
    name: string,
    updateHandler: (data: Manifest, cb: Callback) => void,
    onWrite: (name: string, data: Manifest, cb: Callback) => void,
    transformPackage: (data: Manifest) => Manifest,
    onEnd: Callback
  ): void;
};

const legacyStoragePrototype = Object.getPrototypeOf(
  OfflinePackageStorage.prototype
) as LegacyStoragePrototype;

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

async function createEmptyStorage(): Promise<{
  directory: string;
  storage: OfflinePackageStorage;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'offline-package-storage-'));
  temporaryDirectories.push(directory);

  return {
    directory,
    storage: new OfflinePackageStorage(directory, logger, {
      offline: false
    } as OfflineStorageConfig)
  };
}

function upsert(storage: OfflinePackageStorage, incoming: Manifest): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.upsertPackage(incoming.name, incoming, (error?: Error | null) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
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

  it('serializes concurrent upserts without losing attachments or versions', async () => {
    const { directory, storage } = await createEmptyStorage();
    const competingStorage = new OfflinePackageStorage(directory, logger, {
      offline: false
    } as OfflineStorageConfig);
    const attachmentUpdate = {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _attachments: {
        'demo-1.0.0.tgz': { shasum: 'local-sha' }
      }
    } as unknown as Manifest;
    const versionUpdate = {
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

    await Promise.all([
      upsert(storage, attachmentUpdate),
      upsert(competingStorage, versionUpdate)
    ]);

    const stored = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(stored._attachments['demo-1.0.0.tgz'], { shasum: 'local-sha' });
    assert.equal(stored.versions['2.0.0'].version, '2.0.0');
    assert.deepEqual(stored._distfiles['demo-2.0.0.tgz'], {
      url: 'https://registry.example/demo/-/demo-2.0.0.tgz',
      sha: 'remote-sha'
    });
  });

  it('does not persist invalid local identity fields during a real update', async () => {
    const { directory, storage } = await createStorage({
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '',
      _id: 42
    } as unknown as Manifest);

    await upsert(storage, {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: 'incoming-rev',
      _id: 'incoming-id'
    } as unknown as Manifest);

    const stored = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(stored, '_rev'), false);
    assert.equal(Object.hasOwn(stored, '_id'), false);
  });

  it('serializes concurrent upserts for an existing manifest', async () => {
    const { directory, storage } = await createStorage({
      name: 'demo',
      versions: {},
      'dist-tags': {}
    } as Manifest);
    const competingStorage = new OfflinePackageStorage(directory, logger, {
      offline: false
    } as OfflineStorageConfig);

    await Promise.all([
      upsert(storage, {
        name: 'demo',
        versions: {},
        'dist-tags': {},
        _attachments: {
          'demo-1.0.0.tgz': { shasum: 'local-sha' }
        }
      } as unknown as Manifest),
      upsert(competingStorage, {
        name: 'demo',
        versions: {
          '2.0.0': { name: 'demo', version: '2.0.0' }
        },
        'dist-tags': { latest: '2.0.0' }
      } as unknown as Manifest)
    ]);

    const stored = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(stored._attachments['demo-1.0.0.tgz'], { shasum: 'local-sha' });
    assert.equal(stored.versions['2.0.0'].version, '2.0.0');
  });
});

describe('OfflinePackageStorage upsert coordination', () => {
  it('shares an in-flight create and retries the waiting upsert only once', async () => {
    const { storage } = await createEmptyStorage();
    const originalCreatePackage = legacyStoragePrototype.createPackage;
    const originalUpdatePackage = legacyStoragePrototype.updatePackage;
    let stored: Manifest | undefined;
    let pendingCreate: Callback | undefined;
    let createCalls = 0;
    let updateCalls = 0;
    const callbackCalls = [0, 0];

    legacyStoragePrototype.updatePackage = (
      _name,
      updateHandler,
      _onWrite,
      transformPackage,
      onEnd
    ) => {
      updateCalls++;
      if (!stored) {
        onEnd(Object.assign(new Error('missing'), { statusCode: 404 }));
        return;
      }
      updateHandler(stored, (error?: Error | null) => {
        if (error) {
          onEnd(error);
          return;
        }
        stored = transformPackage(stored!);
        onEnd(null);
      });
    };
    legacyStoragePrototype.createPackage = (_name, value, cb) => {
      createCalls++;
      stored = value;
      pendingCreate = cb;
    };

    try {
      const first = new Promise<void>((resolve, reject) => {
        storage.upsertPackage('demo', {
          name: 'demo',
          versions: {},
          'dist-tags': {},
          _attachments: { 'demo-1.0.0.tgz': { shasum: 'local-sha' } }
        } as unknown as Manifest, (error?: Error | null) => {
          callbackCalls[0]++;
          error ? reject(error) : resolve();
        });
      });
      const second = new Promise<void>((resolve, reject) => {
        storage.upsertPackage('demo', {
          name: 'demo',
          versions: { '2.0.0': { name: 'demo', version: '2.0.0' } },
          'dist-tags': { latest: '2.0.0' }
        } as unknown as Manifest, (error?: Error | null) => {
          callbackCalls[1]++;
          error ? reject(error) : resolve();
        });
      });

      assert.equal(createCalls, 1);
      assert.equal(updateCalls, 1);
      pendingCreate!(null);
      await Promise.all([first, second]);

      assert.equal(updateCalls, 2);
      assert.deepEqual(callbackCalls, [1, 1]);
      assert.deepEqual(stored?._attachments, {
        'demo-1.0.0.tgz': { shasum: 'local-sha' }
      });
      assert.equal(stored?.versions['2.0.0'].version, '2.0.0');
    } finally {
      legacyStoragePrototype.createPackage = originalCreatePackage;
      legacyStoragePrototype.updatePackage = originalUpdatePackage;
    }
  });

  it('waits for complete metadata after EEXISTS before the single retry', async () => {
    const { directory, storage } = await createEmptyStorage();
    const originalCreatePackage = legacyStoragePrototype.createPackage;
    const originalUpdatePackage = legacyStoragePrototype.updatePackage;
    const packagePath = join(directory, 'package.json');
    const conflict = Object.assign(new Error('exists'), { code: 'EEXISTS' });
    let updateCalls = 0;
    await writeFile(packagePath, '');

    legacyStoragePrototype.updatePackage = (
      _name,
      _updateHandler,
      _onWrite,
      _transformPackage,
      onEnd
    ) => {
      updateCalls++;
      onEnd(updateCalls === 1 ? Object.assign(new Error('missing'), { status: 404 }) : null);
    };
    legacyStoragePrototype.createPackage = (_name, _value, cb) => cb(conflict);

    try {
      const result = upsert(storage, {
        name: 'demo',
        versions: {},
        'dist-tags': {}
      } as Manifest);

      assert.equal(updateCalls, 1);
      await writeFile(packagePath, '{}');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updateCalls, 1);
      await writeFile(packagePath, JSON.stringify({
        name: 'demo',
        versions: {},
        'dist-tags': {}
      }));
      await result;

      assert.equal(updateCalls, 2);
    } finally {
      legacyStoragePrototype.createPackage = originalCreatePackage;
      legacyStoragePrototype.updatePackage = originalUpdatePackage;
    }
  });

  it('returns non-not-found update errors unchanged and calls back once', async () => {
    const { storage } = await createEmptyStorage();
    const originalCreatePackage = legacyStoragePrototype.createPackage;
    const originalUpdatePackage = legacyStoragePrototype.updatePackage;
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    let createCalls = 0;
    let callbackCalls = 0;

    legacyStoragePrototype.updatePackage = (
      _name,
      _updateHandler,
      _onWrite,
      _transformPackage,
      onEnd
    ) => {
      onEnd(failure);
      onEnd(failure);
    };
    legacyStoragePrototype.createPackage = () => {
      createCalls++;
    };

    try {
      await new Promise<void>((resolve) => {
        storage.upsertPackage('demo', {
          name: 'demo',
          versions: {},
          'dist-tags': {}
        } as Manifest, (error?: Error | null) => {
          callbackCalls++;
          assert.equal(error, failure);
          resolve();
        });
      });

      assert.equal(createCalls, 0);
      assert.equal(callbackCalls, 1);
    } finally {
      legacyStoragePrototype.createPackage = originalCreatePackage;
      legacyStoragePrototype.updatePackage = originalUpdatePackage;
    }
  });

  it('returns non-conflict create errors unchanged and calls back once', async () => {
    const { storage } = await createEmptyStorage();
    const originalCreatePackage = legacyStoragePrototype.createPackage;
    const originalUpdatePackage = legacyStoragePrototype.updatePackage;
    const failure = Object.assign(new Error('read only'), { code: 'EROFS' });
    let callbackCalls = 0;

    legacyStoragePrototype.updatePackage = (
      _name,
      _updateHandler,
      _onWrite,
      _transformPackage,
      onEnd
    ) => onEnd(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    legacyStoragePrototype.createPackage = (_name, _value, cb) => {
      cb(failure);
      cb(failure);
    };

    try {
      await new Promise<void>((resolve) => {
        storage.upsertPackage('demo', {
          name: 'demo',
          versions: {},
          'dist-tags': {}
        } as Manifest, (error?: Error | null) => {
          callbackCalls++;
          assert.equal(error, failure);
          resolve();
        });
      });

      assert.equal(callbackCalls, 1);
    } finally {
      legacyStoragePrototype.createPackage = originalCreatePackage;
      legacyStoragePrototype.updatePackage = originalUpdatePackage;
    }
  });
});
