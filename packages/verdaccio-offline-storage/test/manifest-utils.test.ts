import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Manifest } from '@verdaccio/types';

import { normalizeLocalManifest } from '../src/manifest-utils';

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
