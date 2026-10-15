import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import native from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OfflinePackageStorage as StorageType } from '../src/OfflinePackageStorage';
const { OfflinePackageStorage } = require('../build/OfflinePackageStorage');
import type { ReadCacheManager } from '../src/read-cache';
const { getReadCacheManager } = require('../build/read-cache');

const exec = promisify(execFile), roots: string[] = [], managers: ReadCacheManager[] = [];
const logger: any = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => { for (const c of managers.splice(0)) { c.cancelWarmup(); c.close(); } for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function fixture(size = 256, options: any = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-read-cache-')); roots.push(root);
  const data = path.join(root, 'data'), state = path.join(root, 'state'), directory = path.join(data, 'demo'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'demo-1.0.0.tgz'), meta = path.join(directory, 'package.json'), bytes = Buffer.alloc(size, 7);
  const manifest: any = { name: 'demo', versions: { '1.0.0': { name: 'demo', version: '1.0.0', exports: { '.': './index.js' }, dist: { tarball: 'http://old/demo/-/demo-1.0.0.tgz', shasum: sha(bytes) } } }, 'dist-tags': { latest: '1.0.0' } };
  await fs.writeFile(file, bytes); await fs.writeFile(meta, JSON.stringify(manifest));
  const config: any = { storage: data, offline: true, readCache: { stateDirectory: state, ...options } };
  const cache = getReadCacheManager(config, data); managers.push(cache);
  return { root, data, state, directory, file, meta, bytes, manifest, config, cache, storage: new OfflinePackageStorage(directory, logger, config) };
}
const read = (s: StorageType, name = 'demo') => new Promise<any>((resolve, reject) => s.readPackage(name, (e: any, m: any) => e ? reject(e) : resolve(m)));
const built = path.resolve(__dirname, '../build');
const childCode = `
const cfg=JSON.parse(process.argv[1]),name=process.argv[2]||'demo';
if(process.env.TEST_NO_SQLITE){const M=require('module'),load=M._load;M._load=function(n,...args){if(n==='node:sqlite')throw Object.assign(Error('unavailable'),{code:'MODULE_NOT_FOUND'});return load.call(this,n,...args)}}
const {OfflinePackageStorage}=require(${JSON.stringify(path.join(built, 'OfflinePackageStorage.js'))}),{getReadCacheManager}=require(${JSON.stringify(path.join(built, 'read-cache.js'))});
if(process.env.TEST_ADAPTER_REV){const old=OfflinePackageStorage.prototype.readPackageUncached;OfflinePackageStorage.prototype.readPackageUncached=function(...args){return old.apply(this,args)}}
const log={debug(){},info(){},warn(){},error(){},trace(){}},s=new OfflinePackageStorage(require('path').join(cfg.storage,name),log,cfg),cache=getReadCacheManager(cfg,cfg.storage);
s.readPackage(name,(e,m)=>{if(e){console.error(e);process.exit(1)}cache.close();console.log(JSON.stringify({metadata:m,metrics:cache.stats()}))});
`;
async function child(config: any, env: any = {}) { const p = await exec(process.execPath, ['-e', childCode, JSON.stringify(config)], { env: { ...process.env, ...env } }); return JSON.parse(p.stdout); }
const dbFile = (state: string) => path.join(state, 'verdaccio-read-cache-v1/index.sqlite');

test('loads a verified persistent metadata record in a new process without rereading tarballs', async () => {
  const f = await fixture(); const a = await child(f.config), b = await child(f.config);
  assert.equal(a.metrics.counters.hashBytes, 256); assert.equal(b.metrics.counters.hashBytes || 0, 0);
  assert.equal(b.metrics.counters.persistentMetadataHits, 1); assert(b.metrics.counters.statCalls >= 6); assert.deepEqual(a.metadata, b.metadata);
});
test('persistent snapshots invalidate same-size preserved-mtime changes; corrupt files are not removed', async () => {
  const f = await fixture(); await child(f.config); const before = await fs.stat(f.file);
  await fs.writeFile(f.file, Buffer.alloc(256, 8)); await fs.utimes(f.file, before.atime, before.mtime);
  const b = await child(f.config); assert.deepEqual(b.metadata.versions, {}); assert(b.metrics.counters.persistentInvalidations > 0); assert.equal(b.metrics.counters.hashBytes, 256); await fs.access(f.file);
});
test('metadata updates reuse actual hashes but changed expected hashes still reject', async () => {
  const f = await fixture(); await child(f.config); f.manifest.versions['1.0.0'].description = 'new'; await fs.writeFile(f.meta, JSON.stringify(f.manifest));
  const updated = await child(f.config); assert.equal(updated.metadata.versions['1.0.0'].description, 'new'); assert(updated.metrics.counters.persistentHashHits > 0); assert.equal(updated.metrics.counters.hashBytes || 0, 0);
  f.manifest.versions['1.0.0'].dist.shasum = '0'.repeat(40); await fs.writeFile(f.meta, JSON.stringify(f.manifest)); assert.deepEqual((await child(f.config)).metadata.versions, {});
});
test('artifact additions, deletion and storage migration invalidate persisted availability', async () => {
  const f = await fixture(); f.manifest.versions['2.0.0'] = { ...f.manifest.versions['1.0.0'], version: '2.0.0' }; await fs.writeFile(f.meta, JSON.stringify(f.manifest)); await child(f.config);
  const second = path.join(f.directory, 'demo-2.0.0.tgz'); await fs.writeFile(second, f.bytes); assert.equal(Object.keys((await child(f.config)).metadata.versions).length, 2);
  await fs.unlink(f.file); assert.deepEqual(Object.keys((await child(f.config)).metadata.versions), ['2.0.0']);
  await fs.rename(f.data, f.data + '-old'); await fs.mkdir(f.directory, { recursive: true }); await fs.writeFile(f.meta, JSON.stringify(f.manifest)); await fs.writeFile(second, f.bytes);
  const moved = await child(f.config); assert(moved.metrics.counters.persistentNamespaceInvalidations > 0); assert.equal(moved.metrics.counters.hashBytes, 256);
});
test('bad record checksums and corrupt/truncated SQLite state safely rebuild or fall back', async () => {
  const f = await fixture(); await child(f.config); const { DatabaseSync } = require('node:sqlite'); let db = new DatabaseSync(dbFile(f.state));
  db.prepare("UPDATE entries SET body='{}' WHERE kind='metadata'").run(); db.close();
  const rebuilt = await child(f.config); assert.equal(rebuilt.metrics.counters.persistentCorrupt, 1); assert(rebuilt.metadata.versions['1.0.0']);
  await fs.writeFile(dbFile(f.state), 'not a sqlite database'); const fallback = await child(f.config); assert.equal(fallback.metrics.backend, 'memory-fallback'); assert.equal(fallback.metrics.counters.hashBytes, 256); assert(fallback.metadata.versions['1.0.0']);
  await fs.truncate(dbFile(f.state), 0); const empty = await child(f.config); assert.equal(empty.metrics.backend, 'sqlite'); assert(empty.metrics.counters.persistentRebuilds > 0);
});
test('expired verification age forces full hashing without suppressing identity checks', async () => {
  const f = await fixture(256, { persistentMaxAgeMs: 1000 }); await child(f.config); await wait(1100); const expired = await child(f.config);
  assert(expired.metrics.counters.persistentExpired > 0); assert.equal(expired.metrics.counters.hashBytes, 256);
});
test('concurrent processes leave SQLite valid and never fail normal reads on cache contention', async () => {
  const f = await fixture(); const results = await Promise.all([0, 1, 2, 3].map(() => child(f.config))); assert(results.every(r => r.metadata.versions['1.0.0']));
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(dbFile(f.state)); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
});
test('memory and persistent quotas evict records rather than grow without bound', async () => {
  const f = await fixture(256, { metadataMaxEntries: 1, metadataMaxBytes: 64 * 1024, persistentMaxBytes: 256 * 1024, persistentMaxEntries: 8 });
  for (let i = 0; i < 12; i++) { const name = 'pkg' + i, directory = path.join(f.data, name); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, description: 'x'.repeat(12000), versions: {}, 'dist-tags': {} })); await read(new OfflinePackageStorage(directory, logger, f.config), name); }
  const m = f.cache.stats(); assert.equal(m.memory.metadataEntries, 1); assert(m.counters.metadataEvictions >= 11); assert(m.counters.persistentEvictions > 0); assert(m.persistent.databaseBytes <= 128 * 1024); assert(m.persistent.rows <= 8);
});
test('unsafe state placement and missing SQLite keep read-only service working', async () => {
  const f = await fixture(); const inside = { ...f.config, readCache: { stateDirectory: path.join(f.data, 'forbidden') } };
  assert.equal((await child(inside)).metrics.backend, 'memory-fallback'); await assert.rejects(fs.access(path.join(f.data, 'forbidden')));
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.data, alias); const linked = { ...f.config, readCache: { stateDirectory: path.join(alias, 'forbidden') } };
  assert.equal((await child(linked)).metrics.backend, 'memory-fallback'); await assert.rejects(fs.access(path.join(f.data, 'forbidden')));
  const oldNode = await child(f.config, { TEST_NO_SQLITE: '1' }); assert.equal(oldNode.metrics.backend, 'memory-fallback'); assert(oldNode.metadata.versions['1.0.0']);
});
test('changes during a read trigger a retry rather than persist the earlier response', async () => {
  const f = await fixture(); let first = true; const original = (f.storage as any).readPackageUncached.bind(f.storage);
  (f.storage as any).readPackageUncached = (name: string, callback: any) => original(name, (e: any, data: any) => {
    if (first) { first = false; f.manifest.versions['1.0.0'].description = 'during-read'; native.writeFileSync(f.meta, JSON.stringify(f.manifest)); } callback(e, data);
  });
  assert.equal((await read(f.storage)).versions['1.0.0'].description, 'during-read'); assert.equal(f.cache.stats().counters.readRetries, 1);
});
async function waitJob(cache: ReadCacheManager, timeout = 10000): Promise<any> { const start = Date.now(); for (;;) { const job = cache.stats().warmup; if (!['running', 'cancelling'].includes(job.status)) return job; if (Date.now() - start > timeout) throw new Error('Warmup did not finish'); await wait(20); } }
test('worker warmup shares the core, persists verified records and warms the parent LRU', async () => {
  const f = await fixture(); f.cache.startWarmup(['demo'], true); const job = await waitJob(f.cache); assert.equal(job.status, 'completed'); assert.deepEqual(job.completed, ['demo']);
  const before = f.cache.stats(); assert.equal(before.backgroundCounters.hashBytes, 256); await read(f.storage); assert(f.cache.stats().counters.metadataHits > 0); assert.equal((await child(f.config)).metrics.counters.hashBytes || 0, 0);
});
test('explicit cancellation and foreground preemption do not make requests wait for slow warmup', async () => {
  const f = await fixture(1024 * 1024, { warmup: { bytesPerSecond: 64 * 1024 } }); f.cache.startWarmup(['demo']); await wait(500); f.cache.cancelWarmup(); assert.equal((await waitJob(f.cache)).status, 'cancelled');
  f.cache.startWarmup(['demo'], true); await wait(500); const start = Date.now(); assert((await read(f.storage)).versions['1.0.0']); assert(Date.now() - start < 3000); const job = await waitJob(f.cache); assert(['completed', 'failed'].includes(job.status));
});

test('warm results retain the original witness across a deterministic post-read deletion barrier', async()=>{
  const f=await fixture();const before=await f.cache.snapshot(f.directory);const result=await f.storage.warmRead('demo');
  assert.equal(result.signature,before);const verified=result.verified;await fs.unlink(f.file);
  assert.equal(await f.cache.adoptWarmResult(result),false);assert.equal(result.signature,before);assert.equal(result.verified,verified);
  assert.deepEqual((await read(f.storage)).versions,{});
});
test('warm results cannot re-stamp old JSON after metadata changes or omit original verification time',async()=>{
  const f=await fixture();const result=await f.storage.warmRead('demo');f.manifest.versions['1.0.0'].description='after-warm-read';await fs.writeFile(f.meta,JSON.stringify(f.manifest));
  assert.equal(await f.cache.adoptWarmResult(result),false);assert.equal((await read(f.storage)).versions['1.0.0'].description,'after-warm-read');
  assert.equal(await f.cache.adoptWarmResult({...result,verified:undefined} as any),false);
});

test('runtime adapter migration invalidates persisted records even if file identities stay equal',async()=>{
 const f=await fixture();await child(f.config);const migrated=await child(f.config,{TEST_ADAPTER_REV:'1'});assert(migrated.metrics.counters.persistentNamespaceInvalidations>0);assert.equal(migrated.metrics.counters.hashBytes,256);
});
test('persistent hash LRU hits batch recency writes instead of one synchronous transaction per artifact',async()=>{
 const f=await fixture();for(let i=2;i<=12;i++){f.manifest.versions[i+'.0.0']={...f.manifest.versions['1.0.0'],version:i+'.0.0'};await fs.writeFile(path.join(f.directory,'demo-'+i+'.0.0.tgz'),f.bytes)}await fs.writeFile(f.meta,JSON.stringify(f.manifest));await child(f.config);await wait(5100);f.manifest.versions['1.0.0'].description='touch-all-hashes';await fs.writeFile(f.meta,JSON.stringify(f.manifest));const next=await child(f.config);assert.equal(next.metrics.counters.persistentHashHits,12);assert(next.metrics.counters.persistentTransactions<=2);assert.equal(next.metrics.counters.hashBytes,0);
});
test('an explicit index rebuild clears derived records but never touches package content',async()=>{
 const f=await fixture();await read(f.storage);assert.equal((await f.cache.rebuildPersistent()).rebuilt,true);const before=f.cache.stats().counters.hashBytes;await read(f.storage);assert.equal(f.cache.stats().counters.hashBytes-before,256);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});

test('cold rebuild admission is bounded while an identical request can still coalesce',async()=>{
 const f=await fixture(256,{maxConcurrentRebuilds:1,maxQueuedRebuilds:0});let release:any,entered:any;const barrier=new Promise<void>(r=>entered=r),original=(f.storage as any).readPackageUncached.bind(f.storage);
 (f.storage as any).readPackageUncached=(name:string,cb:any)=>original(name,(e:any,v:any)=>{release=()=>cb(e,v);entered()});
 const other=path.join(f.data,'other');await fs.mkdir(other);await fs.writeFile(path.join(other,'package.json'),JSON.stringify({name:'other',versions:{},'dist-tags':{}}));
 const first=read(f.storage);await barrier;const duplicate=read(new OfflinePackageStorage(f.directory,logger,f.config));
 await assert.rejects(read(new OfflinePackageStorage(other,logger,f.config),'other'),(e:any)=>e.code==='CACHE_BUSY');release();await first;await duplicate;
 assert.equal(f.cache.stats().inflight.rebuilds,0);assert(f.cache.stats().counters.metadataCoalesced>0);assert.equal(f.cache.stats().counters.rebuildRejected,1);
});
