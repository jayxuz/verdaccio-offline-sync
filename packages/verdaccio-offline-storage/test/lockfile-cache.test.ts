import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { selectLockfilePackages } from '../src/read-cache';
test('selects bounded names from existing npm, pnpm and Yarn locks without resolving packages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-lockfile-'));
  try {
    const file = path.join(root, 'lock');
    await writeFile(file, JSON.stringify({ packages: { '': { name: 'project' }, 'node_modules/demo': { name: 'real-demo' }, 'node_modules/@types/node': {} } }));
    assert.deepEqual(await selectLockfilePackages(file), ['@types/node', 'real-demo']);
    await writeFile(file, "lockfileVersion: '9.0'\npackages:\n  '@types/node@22.0.0':\n    resolution: {integrity: abc}\n  lodash@4.17.21:\nsnapshots:\n  lodash@4.17.21: {}\n");
    assert.deepEqual(await selectLockfilePackages(file), ['@types/node', 'lodash']);
    await writeFile(file, '# yarn lockfile v1\n"debug@^4.4.1", "debug@^4.0.0":\n  version "4.4.1"\n"alias@npm:ms@^2.1.3":\n  version "2.1.3"\n');
    assert.deepEqual(await selectLockfilePackages(file), ['debug', 'ms']);
    await assert.rejects(selectLockfilePackages(file, 1), /limit/);
    await assert.rejects(selectLockfilePackages('relative.lock'), /absolute/);
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(selectLockfilePackages(file), /size/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
