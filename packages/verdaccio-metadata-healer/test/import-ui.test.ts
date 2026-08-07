import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getImportUIHTML } from '../src/import-ui';

describe('healer import UI', () => {
  it('exposes the repeatable local cache rebuild controls and endpoints', () => {
    const html = getImportUIHTML('Offline Sync');

    assert.match(html, /重建本地缓存索引/);
    assert.match(html, /id="rebuildIndexBtn"/);
    assert.match(html, /\/_\/healer\/rebuild-index/);
    assert.match(html, /\/_\/healer\/rebuild\/status\//);
    assert.match(html, /不会访问上游/);

    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  });
});
