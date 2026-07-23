import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Manifest } from '@verdaccio/types';

import { mergeLocalManifests, normalizeLocalManifest } from '../src/manifest-utils';

describe('normalizeLocalManifest', () => {
  it('adds every required local map field', () => {
    const raw = { name: 'broken' } as Manifest;

    const normalized = normalizeLocalManifest(raw);

    assert.deepEqual(normalized.versions, {});
    assert.deepEqual(normalized['dist-tags'], {});
    assert.deepEqual(normalized._attachments, {});
    assert.deepEqual(normalized._distfiles, {});
    assert.deepEqual(normalized._uplinks, {});
    assert.deepEqual(normalized.time, {});
  });

  it('preserves existing local map objects and their contents', () => {
    const attachments = { 'broken-1.0.0.tgz': { shasum: 'demo' } };
    const distfiles = { 'broken-1.0.0.tgz': { url: 'https://example.test/broken.tgz' } };
    const raw = {
      name: 'broken',
      versions: {},
      'dist-tags': {},
      _attachments: attachments,
      _distfiles: distfiles
    } as unknown as Manifest;

    const normalized = normalizeLocalManifest(raw);

    assert.equal(normalized._attachments, attachments);
    assert.equal(normalized._distfiles, distfiles);
    assert.deepEqual(normalized._attachments, attachments);
    assert.deepEqual(normalized._distfiles, distfiles);
  });

  it('rejects non-object manifests', () => {
    assert.throws(
      () => normalizeLocalManifest(null as unknown as Manifest),
      /manifest must be an object/
    );
  });
});

describe('mergeLocalManifests', () => {
  it('prefers remote business fields while preserving local storage metadata', () => {
    const local = {
      name: 'demo',
      description: 'local description',
      versions: {
        '1.0.0': {
          name: 'demo',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.example/demo/-/demo-1.0.0.tgz',
            shasum: 'local-sha'
          }
        }
      },
      'dist-tags': { latest: '1.0.0' },
      _attachments: {
        'demo-1.0.0.tgz': { shasum: 'local-sha' }
      },
      _distfiles: {
        'demo-1.0.0.tgz': { url: 'https://local.example/demo-1.0.0.tgz', sha: 'local-sha' }
      },
      _uplinks: { npmjs: { etag: 'local-etag' } },
      _rev: '7-local',
      _id: 'demo'
    } as unknown as Manifest;
    const remote = {
      name: 'demo',
      description: 'remote description',
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
      'dist-tags': { latest: '2.0.0' },
      time: { '2.0.0': '2026-07-23T00:00:00.000Z' }
    } as unknown as Manifest;

    const merged = mergeLocalManifests(local, remote);

    assert.equal(merged.description, 'remote description');
    assert.deepEqual(Object.keys(merged.versions).sort(), ['1.0.0', '2.0.0']);
    assert.equal(merged['dist-tags'].latest, '2.0.0');
    assert.deepEqual(merged._attachments, local._attachments);
    assert.deepEqual(merged._distfiles['demo-1.0.0.tgz'], local._distfiles['demo-1.0.0.tgz']);
    assert.deepEqual(merged._distfiles['demo-2.0.0.tgz'], {
      url: 'https://registry.example/demo/-/demo-2.0.0.tgz',
      sha: 'remote-sha'
    });
    assert.deepEqual(merged._uplinks, local._uplinks);
    assert.equal(merged._rev, '7-local');
    assert.equal(merged._id, 'demo');
  });

  it('removes incoming identity fields when the local manifest has no identity', () => {
    const merged = mergeLocalManifests({
      name: 'demo',
      versions: {},
      'dist-tags': {}
    } as Manifest, {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '9-incoming',
      _id: 'incoming-id'
    } as unknown as Manifest);

    assert.equal(Object.hasOwn(merged, '_rev'), false);
    assert.equal(Object.hasOwn(merged, '_id'), false);
  });

  it('removes incoming identity fields when the local identity is invalid', () => {
    const merged = mergeLocalManifests({
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '',
      _id: 42
    } as unknown as Manifest, {
      name: 'demo',
      versions: {},
      'dist-tags': {},
      _rev: '9-incoming',
      _id: 'incoming-id'
    } as unknown as Manifest);

    assert.equal(Object.hasOwn(merged, '_rev'), false);
    assert.equal(Object.hasOwn(merged, '_id'), false);
  });
});
