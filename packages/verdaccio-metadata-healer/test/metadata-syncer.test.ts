import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger, Manifest } from '@verdaccio/types';

import { MetadataSyncer } from '../src/metadata-syncer';
import type { SyncResult } from '../src/metadata-syncer';

const logger = {
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {}
} as unknown as Logger;

describe('MetadataSyncer.mergeMetadata', () => {
  it('prefers remote business data and preserves local internal metadata', () => {
    const syncer = new MetadataSyncer({ enabled: true }, '/unused', logger);
    const local = {
      name: 'demo',
      description: 'local',
      versions: { '1.0.0': { name: 'demo', version: '1.0.0' } },
      'dist-tags': { latest: '1.0.0' },
      _attachments: { 'demo-1.0.0.tgz': { shasum: 'local-sha' } },
      _distfiles: { 'demo-1.0.0.tgz': { url: 'https://local/demo.tgz' } },
      _uplinks: { npmjs: { etag: 'local' } },
      _rev: '4-local',
      _id: 'demo'
    } as unknown as Manifest;
    const remote = {
      name: 'demo',
      description: 'remote',
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

    const merged = syncer.mergeMetadata(local, remote);

    assert.equal(merged.description, 'remote');
    assert.deepEqual(Object.keys(merged.versions).sort(), ['1.0.0', '2.0.0']);
    assert.deepEqual(merged._attachments, local._attachments);
    assert.deepEqual(merged._distfiles['demo-1.0.0.tgz'], local._distfiles['demo-1.0.0.tgz']);
    assert.deepEqual(merged._distfiles['demo-2.0.0.tgz'], {
      url: 'https://registry.example/demo/-/demo-2.0.0.tgz',
      sha: 'remote-sha'
    });
    assert.deepEqual(merged._uplinks, local._uplinks);
    assert.equal(merged._rev, '4-local');
    assert.equal(merged._id, 'demo');
    assert.deepEqual(merged.time, {});
  });

  it('removes incoming identity fields when local identities are invalid', () => {
    const syncer = new MetadataSyncer({ enabled: true }, '/unused', logger);
    const local = {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '',
      _id: 42
    } as unknown as Manifest;
    const remote = {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '9-incoming',
      _id: 'incoming-id'
    } as unknown as Manifest;

    const merged = syncer.mergeMetadata(local, remote);

    assert.equal(Object.hasOwn(merged, '_rev'), false);
    assert.equal(Object.hasOwn(merged, '_id'), false);
  });
});

describe('MetadataSyncer.preparePackage', () => {
  it('returns the prepared manifest without claiming persistence success', async () => {
    const syncer = new MetadataSyncer({ enabled: true }, '/unused', logger);
    const remote = {
      name: 'demo',
      versions: { '2.0.0': { name: 'demo', version: '2.0.0' } },
      'dist-tags': { latest: '2.0.0' }
    } as unknown as Manifest;
    syncer.fetchRemoteMetadata = async () => remote;
    syncer.readLocalMetadata = async () => null;

    const prepared = await syncer.preparePackage('demo');

    assert.equal(prepared.packageName, 'demo');
    assert.equal(prepared.manifest.name, 'demo');
    assert.equal(prepared.versionsCount, 1);
    assert.equal(Object.hasOwn(prepared, 'success'), false);
  });

  it('keeps deprecated syncPackage success compatibility and marks it unpersisted', async () => {
    const syncer = new MetadataSyncer({ enabled: true }, '/unused', logger);
    const remote = {
      name: 'demo',
      versions: {},
      'dist-tags': {}
    } as unknown as Manifest;
    syncer.fetchRemoteMetadata = async () => remote;
    syncer.readLocalMetadata = async () => null;

    const compatiblePromise: Promise<SyncResult> = syncer.syncPackage('demo');
    const result = await compatiblePromise;

    assert.equal(result.success, true);
    assert.equal(result.packageName, 'demo');
    assert.equal((result as any).persisted, false);
    assert.equal((result as any).manifest?.name, remote.name);
  });

  it('keeps deprecated syncPackage failure as a result instead of rejecting', async () => {
    const syncer = new MetadataSyncer({ enabled: true }, '/unused', logger);
    syncer.fetchRemoteMetadata = async () => {
      throw new Error('registry unavailable');
    };

    const result = await syncer.syncPackage('broken');

    assert.equal(result.success, false);
    assert.equal(result.packageName, 'broken');
    assert.equal(result.persisted, false);
    assert.match(result.error || '', /registry unavailable/);
  });

  it('keeps deprecated syncPackages collecting compatible success and failure results', async () => {
    const syncer = new MetadataSyncer(
      { enabled: true, syncConcurrency: 2 },
      '/unused',
      logger
    );
    syncer.fetchRemoteMetadata = async (packageName: string) => {
      if (packageName === 'broken') {
        throw new Error('storage was never reached');
      }
      return {
        name: packageName,
        versions: {},
        'dist-tags': {}
      } as unknown as Manifest;
    };
    syncer.readLocalMetadata = async () => null;

    const compatiblePromise: Promise<SyncResult[]> = syncer.syncPackages(['working', 'broken']);
    const results = await compatiblePromise;

    assert.deepEqual(results.map(result => result.packageName), ['working', 'broken']);
    assert.deepEqual(results.map(result => result.success), [true, false]);
    assert.deepEqual(results.map(result => (result as any).persisted), [false, false]);
  });
});
