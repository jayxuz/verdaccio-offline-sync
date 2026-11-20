import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it, type TestContext } from 'node:test';
import { Script } from 'node:vm';
import type { Logger } from '@verdaccio/types';
import express from 'express';
import * as tar from 'tar';
import { ImportHandler } from '../../verdaccio-metadata-healer/src/import-handler';
import { DifferentialPacker } from '../src/differential-packer';
import { DifferentialScanner } from '../src/differential-scanner';
import IngestMiddleware from '../src/ingest-middleware';
import { extractLegacyArchive } from '../src/mirror-core';
import { StandaloneSnapshots } from '../src/standalone-snapshots';
import type { ExportManifest } from '../src/types';
import { getWebUIHTML } from '../src/web-ui';

const logger = { debug() {}, error() {}, info() {}, trace() {}, warn() {} } as unknown as Logger;
const target = 'nexus-prod';
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'v1-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'source');
  await mkdir(storage);
  const scanner = new DifferentialScanner(storage, logger);
  const packer = new DifferentialPacker(storage, logger);
  const open = () => new StandaloneSnapshots(storage, scanner, packer, 2);
  const snapshots = open();
  const put = async (relative: string, data: Buffer | string) => {
    const file = path.join(storage, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return file;
  };
  const tarball = async (name: string, version: string, contents: string) => {
    const staging = await mkdtemp(path.join(root, 'npm-'));
    const directory = path.join(staging, 'package');
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version }));
    await writeFile(path.join(directory, 'index.js'), contents);
    const filename = path.join(staging, 'package.tgz');
    await tar.c({ cwd: staging, file: filename, portable: true, mtime: new Date(0), gzip: { level: 0 } }, ['package']);
    return readFile(filename);
  };
  const create = (repo = snapshots, channel = target) => repo.create(channel, randomUUID(), () => {});
  const confirm = (result: Awaited<ReturnType<typeof create>>, repo = snapshots, channel = target) =>
    repo.confirm(channel, result.exportId, result.snapshot!.archiveSha256, 'complete', 'admin');
  return { root, storage, scanner, packer, open, snapshots, put, tarball, create, confirm };
}

it('uses only confirmed archives as the baseline, persists state and keeps target channels independent', async t => {
  const { snapshots, scanner, open, put, tarball, create, confirm } = await fixture(t);
  const one = '@astrojs/compiler-binding-linux-x64-gnu/compiler-binding-linux-x64-gnu-0.4.0.tgz';
  await put(one, await tarball('@astrojs/compiler-binding-linux-x64-gnu', '0.4.0', 'native dependency'));
  await put('demo/package.json', '{}');
  await scanner.addExportRecord({
    exportId: 'legacy', timestampMs: Date.now() + 60_000, timestamp: new Date().toISOString(),
    filename: 'legacy.tar.gz', type: 'full', fileCount: 1, totalSize: 1, summary: { packages: 1, versions: 1 }
  });
  assert.equal((await snapshots.preview(target)).type, 'full');
  const first = await create();
  await snapshots.download(target, first.exportId);
  assert.equal((await open().status(target)).records[0].status, 'pending');
  for (const outcome of ['partial', 'unknown', undefined]) {
    await assert.rejects(snapshots.confirm(target, first.exportId, first.snapshot!.archiveSha256, outcome, 'admin'),
      /outcome: complete/);
  }
  await assert.rejects(snapshots.confirm(target, first.exportId, '0'.repeat(64), 'complete', 'admin'), /does not match/);
  await assert.rejects(confirm(first, snapshots, 'nexus-test'), /not found/);
  const retry = await create(open());
  assert.equal(retry.snapshot?.baseSnapshotId, null);
  assert.equal(retry.stats.totalFiles, 1);
  await confirm(retry, open());
  assert.equal((await open().status(target)).snapshotId, retry.exportId);
  await assert.rejects(confirm(first), /already been advanced/);
  assert.deepEqual((await open().preview(target)).files, []);
  assert.equal((await create()).filename, null);
  assert.equal((await snapshots.preview('nexus-test')).files.length, 1);

  await put('demo/demo-1.0.0-rc.2.tgz', await tarball('demo', '1.0.0-rc.2', 'another version'));
  const preview = await open().preview(target);
  assert.equal(preview.type, 'incremental');
  assert.equal(preview.baseSnapshotId, retry.exportId);
  assert.deepEqual(preview.files.map(file => [file.packageName, file.version]), [['demo', '1.0.0-rc.2']]);
  const next = await create();
  await confirm(next);
  assert.equal((await confirm(retry)).exportId, retry.exportId);
  assert.equal((await open().status(target)).snapshotId, next.exportId);
});

it('deduplicates scoped path and filename aliases and blocks same-size, same-mtime content changes after deletion', async t => {
  const { snapshots, put, tarball, create, confirm } = await fixture(t);
  const canonical = '@scope/pkg/pkg-1.2.3.tgz';
  const alias = '@scope%2Fpkg/scope-pkg-1.2.3.tgz';
  const original = await tarball('@scope/pkg', '1.2.3', 'original');
  const modified = await tarball('@scope/pkg', '1.2.3', 'modified');
  assert.equal(original.length, modified.length);
  const file = await put(canonical, original);
  await put(alias, original);
  const initial = await snapshots.preview(target);
  assert.equal(initial.files.length, 1);
  assert.equal(initial.files[0].packageName, '@scope/pkg');
  await put(alias, modified);
  assert.equal((await snapshots.preview(target)).conflicts[0].source, 'alias');
  await assert.rejects(create(), /content conflict/);
  await put(alias, original);
  const first = await create();
  await confirm(first);
  const timestamp = new Date('2025-01-01T00:00:00Z');
  await utimes(file, timestamp, timestamp);
  await rm(file);
  await rm(await put(alias, original));
  assert.deepEqual((await snapshots.preview(target)).files, []);
  assert.equal((await create()).filename, null);
  await put(canonical, modified);
  await utimes(file, timestamp, timestamp);
  const after = await stat(file);
  assert.equal(after.size, original.length);
  assert.equal(after.mtimeMs, timestamp.getTime());
  const conflict = (await snapshots.preview(target)).conflicts[0];
  assert.equal(conflict.source, 'confirmed');
  assert.deepEqual(conflict.expected, { size: original.length, checksum: sha256(original) });
  assert.deepEqual(conflict.actual, { size: modified.length, checksum: sha256(modified) });
  await assert.rejects(create(), /content conflict/);
  assert.equal((await snapshots.status(target)).confirmedVersions, 1);
});

it('saves failure without a candidate when scanning fails or staged bytes differ from the fresh plan', async t => {
  const { snapshots, put, tarball, packer, scanner, open, create } = await fixture(t);
  const file = await put('demo/demo-1.0.0.tgz', await tarball('demo', '1.0.0', 'abcdef'));
  const oldPlan = await snapshots.preview(target);
  await put('demo/demo-1.0.0.tgz', await tarball('demo', '1.0.0', 'ghijkl'));
  const fresh = await create();
  const artifact = await snapshots.download(target, fresh.exportId);
  const digest = sha256(await readFile(artifact.path));
  assert.equal(digest, fresh.snapshot?.archiveSha256);
  assert.notEqual((await snapshots.preview(target)).files[0].checksum, oldPlan.files[0].checksum);

  const pack = packer.createExportPackage.bind(packer);
  const replacement = await tarball('demo', '1.0.0', 'mnopqr');
  const timestamp = new Date('2025-01-01T00:00:00Z');
  await utimes(file, timestamp, timestamp);
  const packing = t.mock.method(packer, 'createExportPackage', async (...args: Parameters<typeof pack>) => {
    await writeFile(file, replacement);
    await utimes(file, timestamp, timestamp);
    return pack(...args);
  });
  await assert.rejects(create(), /Tarball content changed after snapshot scan/);
  packing.mock.restore();
  const scan = t.mock.method(scanner, 'scanModifiedFiles', async () => { throw new Error('Scan unavailable'); });
  await assert.rejects(create(), /Scan unavailable/);
  scan.mock.restore();
  const restart = await open().status(target);
  assert.equal(restart.snapshotId, null);
  assert.equal(restart.records.filter(record => record.status === 'failed').length, 2);
  const failed = restart.records.find(record => record.status === 'failed')!;
  await assert.rejects(snapshots.confirm(target, failed.exportId, digest, 'complete', 'admin'), /not ready/);
  await writeFile(artifact.path, 'corrupt archive');
  await assert.rejects(snapshots.confirm(target, fresh.exportId, digest, 'complete', 'admin'), /no longer matches/);
  assert.equal((await open().status(target)).snapshotId, null);
});

it('atomically advances a predecessor once and handles simultaneous duplicate requests', async t => {
  const { snapshots, open, put, tarball, create, confirm } = await fixture(t);
  await put('demo/demo-1.0.0.tgz', await tarball('demo', '1.0.0', 'v1'));
  const [a, b] = await Promise.all([create(), create(open())]);
  const race = await Promise.allSettled([confirm(a), confirm(b, open())]);
  const winners = race.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const [winner] = winners;
  const head = (await open().status(target)).snapshotId;
  assert.equal(head, winner.value.exportId);
  const loser = (await snapshots.status(target)).records.find(record => record.status === 'superseded');
  assert.ok(loser);
  await put('demo/demo-2.0.0.tgz', await tarball('demo', '2.0.0', 'v2'));
  const next = await create();
  const duplicates = await Promise.all([confirm(next), confirm(next, open())]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  assert.equal((await open().status(target)).snapshotId, next.exportId);
});

it('rejects a tgz whose actual npm identity disagrees with its storage path', async t => {
  const { snapshots, put, tarball, create } = await fixture(t);
  await put('demo/demo-1.0.0.tgz', await tarball('different-package', '1.0.0', 'mismatched'));
  await assert.rejects(create(), /Tarball identity mismatch: demo@1.0.0/);
  const status = await snapshots.status(target);
  assert.equal(status.snapshotId, null);
  assert.equal(status.records[0].status, 'failed');
  await assert.rejects(snapshots.download(target, status.records[0].exportId), /not ready/);
});

it('keeps V1 manifest and import compatibility for full and incremental tarball-only archives', async t => {
  const { root, snapshots, put, tarball, create, confirm } = await fixture(t);
  const name = '@scope/pkg';
  const relative = name + '/pkg-1.0.0.tgz';
  const contents = await tarball(name, '1.0.0', 'tarball content used by the V1 importer');
  await put(relative, contents);
  const first = await create();
  const importedStorage = path.join(root, 'imported');
  await mkdir(importedStorage);
  const handler = new ImportHandler(importedStorage, logger);
  const full = (await snapshots.download(target, first.exportId)).path;
  const result = await handler.importPackage(full, { rebuildMetadata: false });
  assert.equal(result.success, true);
  assert.deepEqual(await readFile(path.join(importedStorage, relative)), contents);
  await confirm(first);
  const secondContents = await tarball(name, '2.0.0', 'tarball content used by the V1 importer');
  await put(name + '/pkg-2.0.0.tgz', secondContents);
  const delta = await create();
  const archive = (await snapshots.download(target, delta.exportId)).path;
  const extracted = path.join(root, 'extracted');
  await mkdir(extracted);
  const manifest = await extractLegacyArchive(archive, extracted) as ExportManifest;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.type, 'incremental');
  assert.equal(manifest.baseTimestamp, undefined);
  assert.deepEqual(manifest.snapshot, {
    mode: 'standalone-snapshot', target, baseSnapshotId: first.exportId, snapshotId: delta.exportId
  });
  assert.deepEqual(manifest.files.map(file => [file.path, file.checksum, file.size]), [
    [name + '/pkg-2.0.0.tgz', sha256(secondContents), secondContents.length]
  ]);
  assert.equal((await handler.importPackage(archive, { rebuildMetadata: false })).success, true);
});

it('routes V1 and snapshot workflows and authorizes snapshot operations through Verdaccio auth', async t => {
  const { root, storage, put, tarball, snapshots } = await fixture(t);
  const stored = await put('demo/demo-1.0.0.tgz', await tarball('demo', '1.0.0', 'demo'));
  await utimes(stored, new Date(0), new Date(0));
  await put('demo/package.json', JSON.stringify({ name: 'demo', versions: { '1.0.0': {} } }));
  const app = express();
  const middleware = new IngestMiddleware({ enabled: true, standaloneSnapshotAdmins: ['release-admin'] },
    { config: { storage }, logger } as any);
  middleware.register_middlewares(app, {
    apiJWTmiddleware: () => (req: any, _res: any, next: () => void) => {
      const credentials: Record<string, string> = { 'Bearer admin-token': 'release-admin', 'Bearer user-token': 'user' };
      req.remote_user = { name: credentials[req.headers.authorization] };
      next();
    }
  }, {});
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = (route: string, body?: object, token?: string) => fetch(
    `http://127.0.0.1:${address.port}/_/ingest${route}`,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body && JSON.stringify(body)
    }
  );
  const poll = async (id: string, token?: string) => {
    for (let i = 0; i < 100; i++) {
      const response = await request('/status/' + id, undefined, token);
      assert.equal(response.status, 200);
      const task = await response.json() as any;
      if (task.status === 'completed' || task.status === 'failed') return task;
      await delay(25);
    }
    throw new Error('export task timed out');
  };
  const options = { mode: 'standalone-snapshot', target, since: 'last' };
  const admin = 'admin-token';
  const route = '/export/snapshot/' + target;
  const mirrorBefore = await (await request('/mirror/status')).json();
  assert.equal((await request('/export/preview', options)).status, 401);
  assert.equal((await request('/export/create', options, 'user-token')).status, 403);
  for (const since of ['last', '2025-01-01T00:00:00.000Z']) {
    const response = await request('/export/preview', { since });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.stats.totalFiles, 2);
    assert.match(result.warning, /full scope/);
  }
  assert.equal((await request('/export/create', { ...options, since: '2025-01-01' }, admin)).status, 400);
  assert.equal((await request('/export/preview', { ...options, target: '../nexus' }, admin)).status, 400);
  const legacyTask = await (await request('/export/create', { since: '2025-01-01T00:00:00.000Z' })).json() as any;
  assert.match(legacyTask.warning, /full scope/);
  const legacy = await poll(legacyTask.taskId);
  assert.equal(legacy.status, 'completed', legacy.error);
  assert.equal(legacy.result.stats.totalFiles, 2);
  assert.equal((await snapshots.status(target)).records.length, 0);
  const legacyDownload = await request('/export/download/' + legacy.result.exportId);
  assert.equal(legacyDownload.status, 200);
  const legacyArchive = path.join(root, 'legacy.tar.gz');
  await writeFile(legacyArchive, Buffer.from(await legacyDownload.arrayBuffer()));
  const unpacked = path.join(root, 'legacy-unpacked');
  await mkdir(unpacked);
  const legacyManifest = await extractLegacyArchive(legacyArchive, unpacked);
  assert.equal(legacyManifest.type, 'full');
  assert.equal(legacyManifest.baseTimestamp, undefined);
  assert.equal(legacyManifest.snapshot, undefined);
  const preview = await (await request('/export/preview', options, admin)).json() as any;
  assert.equal(preview.type, 'full');
  assert.equal(preview.stats.totalFiles, 1);
  const started = await (await request('/export/create', options, admin)).json() as any;
  assert.equal((await request('/status/' + started.taskId)).status, 401);
  const task = await poll(started.taskId, admin);
  assert.equal(task.status, 'completed', task.error);
  const archive = route + '/' + started.exportId;
  assert.equal((await request(archive + '/download')).status, 401);
  const downloaded = await request(archive + '/download', undefined, admin);
  assert.equal(downloaded.status, 200);
  const archiveSha256 = sha256(Buffer.from(await downloaded.arrayBuffer()));
  const status = await (await request(route, undefined, admin)).json() as any;
  assert.equal(status.snapshotId, null);
  assert.equal(status.records[0].archive.checksum, archiveSha256);
  assert.equal((await request(archive + '/confirm', { outcome: 'complete', archiveSha256 }, 'user-token')).status, 403);
  assert.equal((await request(archive + '/confirm', { outcome: 'partial', archiveSha256 }, admin)).status, 400);
  assert.equal((await request(archive + '/confirm', { outcome: 'complete', archiveSha256 }, admin)).status, 200);
  assert.equal((await snapshots.status(target)).snapshotId, started.exportId);
  assert.deepEqual(await (await request('/mirror/status')).json(), mirrorBefore);
});

it('renders snapshot mode and confirmation controls with valid browser script', () => {
  const html = getWebUIHTML({ standaloneSnapshotAdmins: ['admin'] });
  assert.match(html, /class="option-row ">\s*<label><input[^>]*value="snapshot"/);
  assert.match(html, /确认已完整导入/);
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotThrow(() => new Script(source));
});
