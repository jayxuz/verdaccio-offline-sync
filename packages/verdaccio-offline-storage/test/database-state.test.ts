import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import OfflineStoragePlugin from '../src/OfflineStoragePlugin';

const logger: any = { debug(){}, info(){}, warn(){}, error(){}, trace(){} };

test('repeated database initialization preserves secret, package list and parent database fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-db-state-'));
  try {
    const config: any = { storage: root, self_path: path.join(root, 'config.yaml'), offline: true, packages: {} };
    const secret = randomBytes(24).toString('hex');
    const databaseFile = path.join(root, '.verdaccio-db.json');
    await writeFile(databaseFile, JSON.stringify({ list: ['existing'], secret, retainedField: { format: 1 } }));
    for (let i = 0; i < 3; i++) {
      const plugin = new OfflineStoragePlugin(config, { config, logger });
      assert.equal(await plugin.getSecret() === secret, true, 'loaded secret stays available without logging its value');
      await new Promise<void>((resolve, reject) => plugin.add(`added-${i}`, (error: any) => error ? reject(error) : resolve()));
      const current = JSON.parse(await readFile(databaseFile, 'utf8'));
      assert.equal(current.secret === secret, true, 'writes keep the same secret');
      assert.deepEqual(current.retainedField, { format: 1 });
      assert.deepEqual(current.list, ['existing', ...Array.from({ length: i + 1 }, (_, n) => `added-${n}`)]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
