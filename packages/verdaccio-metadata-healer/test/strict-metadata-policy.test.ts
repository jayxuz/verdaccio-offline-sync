import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import tar from 'tar';
import { OfflinePackageStorage } from '../../verdaccio-offline-storage/src/OfflinePackageStorage';
import { getReadCacheManager } from '../../verdaccio-offline-storage/src/read-cache';
import { MetadataPatcher } from '../src/metadata-patcher';
import { mergeLegacyMetadata } from '../src/mirror-core';

const logger: any = { debug(){}, info(){}, warn(){}, error(){}, trace(){} };
const read = (storage: any, name: string) => new Promise<any>((resolve, reject) => storage.readPackage(name, (e: any, m: any) => e ? reject(e) : resolve(m)));
const repo = path.resolve(__dirname, '../../..');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-metadata-'));
  const data = path.join(root, 'data'), state = path.join(root, 'state');
  await mkdir(data);
  return { root, data, state, config: { storage: data, offline: true, metadataPolicy: 'preserve', verifyChecksum: true, readCache: { stateDirectory: state } } as any };
}
async function artifact(root: string, name: string, version: string) {
  const stage = path.join(root, 'stage', name, version);
  await mkdir(path.join(stage, 'package'), { recursive: true });
  await writeFile(path.join(stage, 'package/package.json'), JSON.stringify({ name, version, dependencies: { dependency: '^1.0.0' }, scripts: { install: 'never-executed' } }));
  await mkdir(path.join(root, 'data', name), { recursive: true });
  const file = path.join(root, 'data', name, `${name}-${version}.tgz`);
  await tar.c({ cwd: stage, gzip: true, file }, ['package']);
  const bytes = await readFile(file);
  return { name, version, dist: { tarball: `http://localhost/${name}/-/${name}-${version}.tgz`, shasum: createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } };
}

test('strict read keeps tags, filters unavailable targets, separates cache modes and invalidates tag changes', async () => {
  const f = await fixture();
  try {
    const versions: any = {};
    for (const v of ['1.0.0', '2.0.0', '3.0.0-beta.1']) versions[v] = await artifact(f.root, 'demo', v);
    const manifest: any = { name: 'demo', versions, 'dist-tags': { latest: '1.0.0', private: '1.0.0', next: '3.0.0-beta.1', unavailable: '9.0.0' }, time: { '1.0.0': '2020-01-01T00:00:00Z' } };
    const file = path.join(f.data, 'demo/package.json');
    await writeFile(file, JSON.stringify(manifest));
    const strict = new OfflinePackageStorage(path.dirname(file), logger, f.config);
    const compatible = new OfflinePackageStorage(path.dirname(file), logger, { ...f.config, metadataPolicy: 'local-latest' });
    assert.equal((await read(compatible, 'demo'))['dist-tags'].latest, '2.0.0');
    const first = await read(strict, 'demo');
    assert.deepEqual(first['dist-tags'], { latest: '1.0.0', private: '1.0.0', next: '3.0.0-beta.1' });
    assert.deepEqual((await read(strict, 'demo')), first);
    manifest['dist-tags'] = {};
    await writeFile(file, JSON.stringify(manifest));
    assert.deepEqual((await read(strict, 'demo'))['dist-tags'], {});
    assert.deepEqual((await read(strict, 'demo')).time, manifest.time);
    await unlink(path.join(f.data, 'demo/demo-1.0.0.tgz'));
    manifest['dist-tags'] = { latest: '1.0.0', next: '3.0.0-beta.1' };
    await writeFile(file, JSON.stringify(manifest));
    assert.deepEqual((await read(strict, 'demo'))['dist-tags'], { next: '3.0.0-beta.1' });
  } finally { getReadCacheManager(f.config, f.data).close(); await rm(f.root, { recursive: true, force: true }); }
});

test('strict upsert and legacy sidecars preserve target tags/time and do not invent absent values', async () => {
  const f = await fixture();
  try {
    const one = await artifact(f.root, 'demo', '1.0.0'), two = await artifact(f.root, 'demo', '2.0.0');
    const file = path.join(f.data, 'demo/package.json');
    const original: any = { name: 'demo', versions: { '1.0.0': one }, 'dist-tags': { latest: '1.0.0', private: '1.0.0' }, time: { created: '2020-01-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z' } };
    await writeFile(file, JSON.stringify(original));
    const incoming: any = { name: 'demo', versions: { '2.0.0': two }, 'dist-tags': { latest: '2.0.0', next: '2.0.0' }, time: { created: '2021-01-01T00:00:00Z', '2.0.0': '2021-01-01T00:00:00Z' } };
    const source = path.join(f.root, 'sidecar.json'); await writeFile(source, JSON.stringify(incoming));
    await mergeLegacyMetadata(source, file, 'demo');
    const s = new OfflinePackageStorage(path.dirname(file), logger, f.config);
    for (let i=0; i<2; i++) await new Promise<void>((resolve, reject) => s.upsertPackage('demo', incoming, e => e ? reject(e) : resolve()));
    const result = await read(s, 'demo');
    assert.deepEqual(result['dist-tags'], { latest: '1.0.0', private: '1.0.0', next: '2.0.0' });
    assert.deepEqual(result.time, { ...incoming.time, ...original.time });
    const empty: any = { name: 'empty', versions: {}, 'dist-tags': {}, time: {} };
    const patcher = new MetadataPatcher({ enabled: true, metadataPolicy: 'preserve' }, logger);
    const patched = await patcher.patchManifest(empty, [], {} as any);
    patcher.updateDistTags(patched, ['1.0.0']);
    assert.deepEqual(patched.time, {}); assert.deepEqual(patched['dist-tags'], {});
  } finally { getReadCacheManager(f.config, f.data).close(); await rm(f.root, { recursive: true, force: true }); }
});

test('real Verdaccio HTTP keeps the original authenticated token and metadata through warmup, persistent restarts and repeated v1 import', { timeout: 90000 }, async t => {
  let modulePath: string;
  try { modulePath = require.resolve('verdaccio'); } catch {
    const dir = (await readdir(path.join(repo, 'node_modules/.pnpm'))).find(n => n.startsWith('verdaccio@6.2.4_'));
    if (!dir) { t.skip('Install Verdaccio 6.2.4 for the real HTTP compatibility test'); return; }
    modulePath = path.join(repo, 'node_modules/.pnpm', dir, 'node_modules/verdaccio');
  }
  const f = await fixture(); let child: any;
  try {
    const plugins = path.join(f.root, 'plugins'); await mkdir(path.join(plugins, '@jayxuz'), { recursive: true });
    await symlink(path.join(repo, 'packages/verdaccio-offline-storage'), path.join(plugins, '@jayxuz/verdaccio-offline-storage'));
    await symlink(path.join(repo, 'packages/verdaccio-metadata-healer'), path.join(plugins, 'verdaccio-metadata-healer'));
    const htpasswdPath = path.dirname(require.resolve('verdaccio-htpasswd/package.json', { paths: [modulePath] }));
    await symlink(htpasswdPath, path.join(plugins, 'verdaccio-htpasswd'));
    const versions: any = {};
    for (const v of ['1.0.0', '2.0.0', '3.0.0-beta.1']) versions[v] = await artifact(f.root, 'demo', v);
    const tags = { latest: '1.0.0', private: '1.0.0', next: '3.0.0-beta.1' }, time = { created: '2020-01-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z' };
    await writeFile(path.join(f.data, 'demo/package.json'), JSON.stringify({ name: 'demo', versions, 'dist-tags': tags, time }));
    const names = ['demo', 'blank', 'pre', ...Array.from({ length: 5 }, (_, i) => `minimal-${i}`)];
    for (const name of names.slice(1)) {
      const v = name === 'pre' ? '1.0.0-beta.1' : '1.0.0'; const entry = await artifact(f.root, name, v);
      await writeFile(path.join(f.data, name, 'package.json'), JSON.stringify({ name, versions: { [v]: entry }, 'dist-tags': name === 'pre' ? { next: v } : {} }));
    }
    const cfg: any = { storage: f.data, plugins, self_path: path.join(f.root, 'config.yaml'), uplinks: {}, packages: { '**': { access: '$authenticated', publish: '$authenticated' } }, store: { '@jayxuz/verdaccio-offline-storage': { ...f.config, storage: undefined } }, middlewares: { 'metadata-healer': { enabled: true, enableImportUI: true, metadataPolicy: 'preserve', autoUpdateLatest: false, autoSaveMetadata: false } }, log: { type: 'stdout', format: 'json', level: 'fatal' }, web: { enable: false }, auth: { htpasswd: { file: path.join(f.root, 'htpasswd') } } };
    const cfgFile = path.join(f.root, 'config.json'); await writeFile(cfgFile, JSON.stringify(cfg));
    const launcher = path.join(f.root, 'server.cjs');
    await writeFile(launcher, `const fs=require('fs'),cfg=JSON.parse(fs.readFileSync(process.argv[2]));
const {getReadCacheManager}=require(${JSON.stringify(path.join(repo, 'packages/verdaccio-offline-storage/build/read-cache.js'))});
const cache=getReadCacheManager({...cfg.store['@jayxuz/verdaccio-offline-storage'],storage:cfg.storage},cfg.storage);
require(${JSON.stringify(modulePath)}).runServer(cfg).then(server=>{server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));process.on('message',async m=>{try{if(m==='warm'){cache.startWarmup(${JSON.stringify(names)});while(['running','pending'].includes(cache.stats().warmup.status))await new Promise(r=>setTimeout(r,20));process.send({warm:cache.stats().warmup});}if(m==='stop'){cache.close();server.close(()=>process.exit(0));}}catch(e){process.send({error:e.stack})}})}).catch(e=>{console.error(e);process.exit(1)});`);
    const start = () => new Promise<number>((resolve, reject) => { child = fork(launcher, [cfgFile], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let logs = ''; child.stdout.on('data', (b: Buffer) => logs += b); child.stderr.on('data', (b: Buffer) => logs += b); child.once('error', reject); child.once('exit', (code: any) => reject(new Error(`HTTP child exit ${code}: ${logs}`))); child.once('message', (m: any) => m.port ? resolve(m.port) : reject(new Error(JSON.stringify(m)))); });
    const stop = () => new Promise<void>(resolve => { child.once('exit', () => { child = undefined; resolve(); }); child.send('stop'); });
    let port = await start();
    const registration = await fetch(`http://127.0.0.1:${port}/-/user/org.couchdb.user:restart-test`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'restart-test', password: randomBytes(24).toString('base64url') }) });
    assert.equal(registration.status, 201, 'isolated test registration succeeds');
    const credentials: any = await registration.json();
    assert.equal(typeof credentials.token === 'string' && credentials.token.length > 0, true, 'initial API token issued');
    const authorization = `Bearer ${credentials.token}`;
    const databaseFile = path.join(f.data, '.verdaccio-db.json');
    const initialSecret = JSON.parse(await readFile(databaseFile, 'utf8')).secret;
    assert.equal(typeof initialSecret === 'string' && initialSecret.length > 0, true, 'database has signing secret');
    const assertSameSecret = async () => { const current = JSON.parse(await readFile(databaseFile, 'utf8')); assert.equal(current.secret === initialSecret, true, 'database signing secret unchanged'); };
    const warm = new Promise<any>(resolve => child.once('message', resolve)); child.send('warm'); assert.equal((await warm).warm.status, 'completed');
    const check = async () => {
      assert.equal((await fetch(`http://127.0.0.1:${port}/demo`)).status, 401, 'anonymous metadata access remains denied');
      for (const name of names) {
        for (const accept of ['application/json', 'application/vnd.npm.install-v1+json']) {
          const response = await fetch(`http://127.0.0.1:${port}/${name}`, { headers: { accept, authorization } }); assert.equal(response.status, 200, await response.clone().text());
          const m: any = await response.json();
          assert.deepEqual(m['dist-tags'], name === 'demo' ? tags : name === 'pre' ? { next: '1.0.0-beta.1' } : {}, name);
          if (accept === 'application/json') assert.deepEqual(m.time, name === 'demo' ? time : {}, name);
          for (const value of Object.values(m.versions) as any[]) { const download = await fetch(value.dist.tarball, { headers: { authorization } }); assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(createHash('sha1').update(bytes).digest('hex'), value.dist.shasum); assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), value.dist.integrity); }
        }
      }
    };
    await check(); await check();
    const stats = await (await fetch(`http://127.0.0.1:${port}/_/healer/cache/performance`)).json() as any;
    assert(stats.counters.metadataHits > 0); assert(stats.counters.warmAdoptions > 0);
    await stop(); port = await start(); await check(); await assertSameSecret();
    const persisted = await (await fetch(`http://127.0.0.1:${port}/_/healer/cache/performance`)).json() as any;
    assert(persisted.counters.persistentMetadataHits > 0); assert.equal(persisted.counters.hashBytes, 0);
    // Tarball-only legacy bundle exercises new/minimal metadata and a target-only demo version.
    const archiveRoot = path.join(f.root, 'export'); await mkdir(archiveRoot);
    const entries: any[] = [];
    for (const name of names) {
      for (const file of await readdir(path.join(f.data, name))) if (file.endsWith('.tgz')) {
        if (name === 'demo' && file !== 'demo-2.0.0.tgz') continue;
        await mkdir(path.join(archiveRoot, name), { recursive: true }); const bytes = await readFile(path.join(f.data, name, file));
        await writeFile(path.join(archiveRoot, name, file), bytes);
        entries.push({ path: `${name}/${file}`, type: 'tarball', packageName: name, version: name === 'demo' ? '2.0.0' : name === 'pre' ? '1.0.0-beta.1' : '1.0.0', size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), mtime: '2020-01-01T00:00:00Z' });
      }
    }
    await writeFile(path.join(archiveRoot, '.export-manifest.json'), JSON.stringify({ version: 1, exportId: 'strict-test', timestamp: '2020-01-01T00:00:00Z', type: 'full', files: entries, stats: { totalFiles: entries.length, totalSize: entries.reduce((a,b)=>a+b.size,0), packages: names.length, versions: entries.length } }));
    const archive = path.join(f.root, 'import.tar.gz'); await tar.c({ cwd: archiveRoot, gzip: true, file: archive }, ['.export-manifest.json', ...names]);
    for (const name of names.filter(n => n === 'blank' || n.startsWith('minimal-'))) await unlink(path.join(f.data, name, 'package.json'));
    await rm(path.join(f.data, 'minimal-4'), { recursive: true });
    for (let i=0; i<2; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/_/healer/import/local`, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify({ path: archive, rebuildMetadata: true, validateChecksum: true }) });
      assert.equal(response.status, 200, await response.clone().text()); const task: any = await response.json();
      let status: any; for (let n=0; n<200; n++) { status = await (await fetch(`http://127.0.0.1:${port}/_/healer/import/status/${task.taskId}`)).json(); if (['completed', 'failed'].includes(status.status)) break; await new Promise(r=>setTimeout(r,25)); }
      assert.equal(status.status, 'completed', JSON.stringify(status)); assert.equal(status.result.failed, 0); assert.equal(status.result.metadataRebuilt, true); assert.equal(status.result.imported, i === 0 ? 1 : 0); assert.equal(status.result.skipped, entries.length - (i === 0 ? 1 : 0)); await check();
      for (const name of names.filter(n => n.startsWith('minimal-'))) { const disk = JSON.parse(await readFile(path.join(f.data, name, 'package.json'), 'utf8')); assert.deepEqual(disk['dist-tags'], {}); assert.deepEqual(disk.time, {}); assert.equal(disk.versions['1.0.0'].hasInstallScript, true); assert.deepEqual(disk.versions['1.0.0'].dependencies, { dependency: '^1.0.0' }); }
    }
    await stop(); port = await start(); await check(); await assertSameSecret(); await stop();
  } finally { if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } await rm(f.root, { recursive: true, force: true }); }
});
