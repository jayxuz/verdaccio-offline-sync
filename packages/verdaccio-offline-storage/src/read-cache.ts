import * as fs from 'fs/promises';
import { createReadStream, constants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { Worker } from 'worker_threads';
import type { OfflineStorageConfig, ReadCacheConfig } from './types';

const MiB = 1024 * 1024;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const limit = (n: unknown, fallback: number, min: number, max: number): number =>
  typeof n === 'number' && Number.isSafeInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
export const fileIdentity = (s: any): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':');

/** Select names only; this is not a resolver and never downloads or executes packages. */
export async function selectLockfilePackages(file: string, maxPackages = 32): Promise<string[]> {
  if (!path.isAbsolute(file)) throw new Error('Explicit absolute lockfile path required');
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 2 * MiB) throw new Error('Lockfile size limit (2 MiB)');
  const handle = await fs.open(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(2 * MiB + 1), result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > 2 * MiB) throw new Error('Lockfile size limit (2 MiB)');
    text = buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally { await handle.close(); }
  const names = new Set<string>();
  const add = (name: string) => {
    if (NAME.test(name) && !name.split('/').some(p => p.startsWith('.'))) names.add(name);
    if (names.size > limit(maxPackages, 32, 1, 128)) throw new Error('Lockfile exceeds warmup package limit; select explicit hotspots');
  };
  const descriptor = (raw: string) => {
    const value = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    const alias = /@npm:((?:@[^/]+\/)?[^@]+)@/.exec(value);
    const current = /^(@[^/]+\/[^@]+|[^@/]+)@/.exec(value);
    const oldPnpm = /^(@[^/]+\/[^/]+|[^/]+)\/[^/]+$/.exec(value);
    const name = alias?.[1] || current?.[1] || oldPnpm?.[1];
    if (name) add(name);
  };
  if (text.trimStart().startsWith('{')) {
    const value = JSON.parse(text);
    for (const [key, item] of Object.entries(value.packages || {}) as [string, any][]) {
      if (!key) continue;
      const name = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1];
      if (name) add(typeof item?.name === 'string' ? item.name : name);
    }
    const visit = (items: any, depth: number) => {
      if (depth > 32) throw new Error('Lockfile nesting limit');
      for (const [name, item] of Object.entries(items || {}) as [string, any][]) {
        const alias = typeof item?.version === 'string' && /^npm:((?:@[^/]+\/)?[^@]+)@/.exec(item.version);
        add(alias ? alias[1] : name); if (item?.dependencies) visit(item.dependencies, depth + 1);
      }
    };
    visit(value.dependencies, 0);
  } else {
    let pnpmSection = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^[^\s#]/.test(line)) pnpmSection = /^(?:packages|snapshots):\s*$/.test(line);
      if (pnpmSection && /^  [^\s#].*:\s*$/.test(line)) descriptor(line.trim().slice(0, -1));
      else if (/^[^\s#].*:\s*$/.test(line)) for (const value of line.slice(0, line.lastIndexOf(':')).split(/,\s*/)) descriptor(value);
    }
  }
  if (!names.size) throw new Error('No supported cached-package selectors in lockfile');
  return [...names].sort();
}
type Work = { background: boolean; force: boolean; epoch: number; started: number; bytes: number; oldestVerified: number; nextReadAt: number };
type Entry = { namespace: string; signature: string; json: string; bytes: number; verified: number };
type RecordValue = { key: string; logical: string; namespace: string; kind: string; signature: string; body: string; verified: number };
export type WarmResult = { package: string; namespace: string; logical: string; signature: string; json: string; verified: number };
type ReadValue = { json: string; proof?: Omit<WarmResult, 'package' | 'json'> };

/** One implementation shared by package readers, storage-plugin controls, and its worker. */
export class ReadCacheManager {
  private readonly options: ReadCacheConfig;
  private readonly metadataBytes: number;
  private readonly metadataEntries: number;
  private readonly hashEntries: number;
  private readonly diskBytes: number;
  private readonly diskEntries: number;
  private readonly maxAge: number;
  private readonly rebuildLimit: number;
  private readonly rebuildQueueLimit: number;
  private readonly reads = new Map<string, Entry>();
  private readonly hashes = new Map<string, { hash: string; verified: number }>();
  private readonly signatures = new Map<string, string>();
  private readonly reading = new Map<string, Promise<ReadValue>>();
  private readonly hashing = new Map<string, Promise<string>>();
  private readonly context = new AsyncLocalStorage<Work>();
  private readonly dirty = new Map<string, RecordValue>();
  private readonly touches = new Set<string>();
  private readonly counts: Record<string, number> = {};
  private bytes = 0;
  private dirtyBytes = 0;
  private namespaceBase?: Promise<string | undefined>;
  private lastNamespace?: string;
  private dbReady?: Promise<void>;
  private db: any;
  private backend = 'disabled';
  private stateError?: string;
  private persistentRows = 0;
  private persistentPageBytes = 0;
  private activeForeground = 0;
  private activeRebuilds = 0;
  private readonly rebuildQueue: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }> = [];
  private backgroundPaused = false;
  private backgroundCancelled = false;
  private backgroundEpoch = 0;
  private worker?: Worker;
  private workerTimer?: ReturnType<typeof setTimeout>;
  private job: any = { status: 'idle', completed: [], failed: [], preempted: [] };
  private finishedBackground: Record<string, number> = {};
  private jobBackground: Record<string, number> = {};

  constructor(readonly root: string, readonly config: OfflineStorageConfig) {
    this.root = path.resolve(root);
    this.options = config.readCache || {};
    this.metadataBytes = limit(this.options.metadataMaxBytes, 16 * MiB, 64 * 1024, 128 * MiB);
    this.metadataEntries = limit(this.options.metadataMaxEntries, 64, 1, 1024);
    this.hashEntries = limit(this.options.hashMaxEntries, 2048, 16, 32768);
    this.diskBytes = limit(this.options.persistentMaxBytes, 64 * MiB, 256 * 1024, 256 * MiB);
    this.diskEntries = limit(this.options.persistentMaxEntries, 4096, 8, 16384);
    this.maxAge = limit(this.options.persistentMaxAgeMs, 24 * 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000);
    this.rebuildLimit = limit(this.options.maxConcurrentRebuilds, 2, 1, 8);
    this.rebuildQueueLimit = limit(this.options.maxQueuedRebuilds, 32, 0, 128);
    if (this.options.stateDirectory) this.backend = 'pending';
    for (const name of ['metadataHits', 'metadataMisses', 'metadataEvictions', 'metadataInvalidations', 'metadataCoalesced', 'metadataRebuilds', 'hashHits', 'hashMisses', 'hashEvictions', 'hashCoalesced', 'hashComputations', 'hashBytes', 'metadataReadBytes', 'statCalls', 'directoryReads', 'identityErrors', 'namespaceInvalidations', 'persistentOpens', 'persistentMetadataHits', 'persistentHashHits', 'persistentMisses', 'persistentInvalidations', 'persistentNamespaceInvalidations', 'persistentCorrupt', 'persistentExpired', 'persistentErrors', 'persistentRebuilds', 'persistentWrites', 'persistentEvictions', 'persistentTouches', 'persistentTransactions', 'readRetries', 'warmAdoptions', 'rebuildQueued', 'rebuildRejected', 'rebuildQueueTimeouts']) this.counts[name] = 0;
  }

  private add(name: string, n = 1): void { this.counts[name] = (this.counts[name] || 0) + n; }
  async stat(file: string): Promise<any> { this.add('statCalls'); return fs.stat(file, { bigint: true }); }
  async statFile(file: string): Promise<any> { this.add('statCalls'); return fs.stat(file); }

  private async namespace(): Promise<string> {
    if (!this.namespaceBase) this.namespaceBase = (async () => {
      if (process.platform !== 'linux') return undefined;
      try {
        const [boot, pid, mount] = await Promise.all([
          fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
          fs.readlink('/proc/self/ns/pid'), fs.readlink('/proc/self/ns/mnt')
        ]);
        const adapter = require('./OfflinePackageStorage').OfflinePackageStorage;
        const utilities = require('./manifest-utils'), versions = require('./tarball-version');
        const methods = (type: any): string => Object.getOwnPropertyNames(type.prototype).sort().filter(n => n !== 'constructor' && typeof type.prototype[n] === 'function').map(n => n + ':' + type.prototype[n].toString()).join('\n');
        const code = digest([methods(ReadCacheManager), methods(adapter), methods(require('./OfflineStoragePlugin').default), Object.getPrototypeOf(adapter.prototype).readPackage.toString(), utilities.normalizeLocalManifest.toString(), utilities.mergeLocalManifests.toString(), versions.extractTarballVersion.toString(), fileIdentity.toString(), process.version, require('semver/package.json').version].join('\n'));
        return [boot.trim(), pid, mount, code].join(':');
      } catch { return undefined; }
    })();
    const [base, root] = await Promise.all([this.namespaceBase, this.stat(this.root)]);
    // Root mtime changes on unrelated package additions; device/inode identify this storage.
    const ns = digest(JSON.stringify(['verdaccio-read-cache-v1', base || 'process-' + process.pid, this.root, String(root.dev), String(root.ino)]));
    if (this.lastNamespace && this.lastNamespace !== ns) this.add('namespaceInvalidations');
    this.lastNamespace = ns;
    return ns;
  }

  async snapshot(directory: string): Promise<string> {
    const dir = await this.stat(directory), metadata = await this.stat(path.join(directory, 'package.json'));
    this.add('directoryReads');
    const names = (await fs.readdir(directory)).filter(f => f.endsWith('.tgz')).sort();
    const identities = [fileIdentity(dir), fileIdentity(metadata)];
    for (let i = 0; i < names.length; i += 8) {
      identities.push(...await Promise.all(names.slice(i, i + 8).map(async name =>
        name + ':' + fileIdentity(await this.stat(path.join(directory, name))))));
    }
    return identities.join('\n');
  }

  mode(config: OfflineStorageConfig, name: string): unknown[] {
    const proxy = typeof config.getMatchedPackagesSpec === 'function' ? config.getMatchedPackagesSpec(name)?.proxy : undefined;
    return [config.offline, proxy, config.verifyChecksum, config.minTarballSize, config.metadataPolicy || 'local-latest', typeof config.getMatchedPackagesSpec === 'function'];
  }
  private logical(directory: string, name: string, mode: unknown[]): string { return JSON.stringify([path.resolve(directory), name, mode]); }
  private key(namespace: string, logical: string, signature: string, kind: string): string { return digest(JSON.stringify([namespace, logical, signature, kind])); }
  private recordDigest(r: RecordValue): string { return digest(JSON.stringify([r.key, r.logical, r.namespace, r.kind, r.signature, r.body, r.verified])); }

  private async ensureDB(): Promise<void> {
    if (!this.options.stateDirectory) return;
    if (!this.dbReady) this.dbReady = (async () => {
      try {
        await this.namespace();
        if (!await this.namespaceBase) throw new Error('UNVERIFIED_NAMESPACE');
        const state = this.options.stateDirectory!;
        if (!path.isAbsolute(state)) throw new Error('STATE_PATH_NOT_ABSOLUTE');
        const destination = path.resolve(state);
        if (destination === this.root || destination.startsWith(this.root + path.sep)) throw new Error('STATE_INSIDE_PACKAGE_CACHE');
        const physicalRoot = await fs.realpath(this.root);
        if (destination === physicalRoot || destination.startsWith(physicalRoot + path.sep)) throw new Error('STATE_INSIDE_PACKAGE_CACHE');
        let ancestor = path.parse(destination).root;
        for (const part of destination.slice(ancestor.length).split(path.sep).filter(Boolean)) {
          ancestor = path.join(ancestor, part);
          try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('STATE_SYMLINK_COMPONENT'); }
          catch (e: any) { if (e.code === 'ENOENT') break; throw e; }
        }
        await fs.mkdir(destination, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(destination);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('UNSAFE_STATE_DIRECTORY');
        const directory = path.join(destination, 'verdaccio-read-cache-v1');
        await fs.mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const ds = await fs.lstat(directory);
        if (!ds.isDirectory() || ds.isSymbolicLink()) throw new Error('UNSAFE_STATE_DIRECTORY');
        const file = path.join(directory, 'index.sqlite');
        let existed = false;
        try { const s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > this.diskBytes / 2) throw new Error('UNSAFE_OR_OVERSIZE_INDEX'); existed = s.size > 0; }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        for (const suffix of ['-journal', '-wal', '-shm']) {
          try {
            const sidecar = await fs.lstat(file + suffix);
            if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.size > this.diskBytes / 2 || suffix !== '-journal' && sidecar.size > 0) throw new Error('UNSAFE_INDEX_SIDECAR');
          } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        }
        // Lazy built-in only. Node without node:sqlite retains memory caching and normal service.
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(file);
        try {
          db.exec('PRAGMA busy_timeout=25; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048;');
          if (existed && db.prepare('PRAGMA application_id').get().application_id !== 0x56535243) throw new Error('FOREIGN_OR_CORRUPT_INDEX');
          const version = db.prepare('PRAGMA user_version').get().user_version;
          if (version !== 0 && version !== 1) throw new Error('UNSUPPORTED_INDEX_SCHEMA');
          db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0;');
          // DB plus its rollback journal are bounded by the configured disk budget.
          db.exec('PRAGMA max_page_count=' + Math.floor(this.diskBytes / (2 * 4096)));
          db.exec('CREATE TABLE IF NOT EXISTS entries (k TEXT PRIMARY KEY, logical TEXT NOT NULL, ns TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, body TEXT NOT NULL, checksum TEXT NOT NULL, verified INTEGER NOT NULL, used INTEGER NOT NULL, bytes INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS entries_logical ON entries(logical,kind); CREATE INDEX IF NOT EXISTS entries_eviction ON entries(used,k);');
          db.exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, value TEXT NOT NULL)');
          const policy = JSON.stringify({ schema: 1, diskBytes: this.diskBytes, diskEntries: this.diskEntries });
          db.prepare("INSERT OR IGNORE INTO settings VALUES ('policy',?)").run(policy);
          if (db.prepare("SELECT value FROM settings WHERE k='policy'").get().value !== policy) throw new Error('CACHE_BUDGET_MISMATCH');
          db.exec('PRAGMA application_id=' + 0x56535243 + '; PRAGMA user_version=1;');
          await fs.chmod(file, 0o600);
          this.db = db; this.backend = 'sqlite'; this.add('persistentOpens'); this.refreshDBSize();
        } catch (error) { db.close(); throw error; }
      } catch (e: any) {
        this.backend = 'memory-fallback'; this.stateError = String(e.code || e.message || 'STATE_ERROR').slice(0, 100); this.add('persistentErrors');
      }
    })();
    await this.dbReady;
  }

  private refreshDBSize(): void {
    if (!this.db) return;
    this.persistentRows = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
    this.persistentPageBytes = this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size;
  }

  private async load(namespace: string, logical: string, signature: string, kind: string): Promise<{ body: string; verified: number } | undefined> {
    await this.ensureDB();
    if (!this.db) return undefined;
    const key = this.key(namespace, logical, signature, kind);
    try {
      const row = this.db.prepare('SELECT * FROM entries WHERE k=?').get(key);
      if (!row) {
        this.add('persistentMisses');
        const prior = this.db.prepare('SELECT ns FROM entries WHERE logical=? AND kind=? LIMIT 1').get(logical, kind);
        if (prior) this.add(prior.ns === namespace ? 'persistentInvalidations' : 'persistentNamespaceInvalidations');
        return undefined;
      }
      const r: RecordValue = { key: row.k, logical: row.logical, namespace: row.ns, kind: row.kind, signature: row.signature, body: row.body, verified: row.verified };
      if (r.namespace !== namespace || r.logical !== logical || r.signature !== signature || r.kind !== kind || row.checksum !== this.recordDigest(r) || this.recordCost(r) !== row.bytes) {
        this.add('persistentCorrupt'); return undefined;
      }
      if (Date.now() - r.verified > this.maxAge || r.verified > Date.now() + 60000) { this.add('persistentExpired'); return undefined; }
      if (kind === 'hash' && !/^[a-f0-9]{40}$/.test(r.body)) { this.add('persistentCorrupt'); return undefined; }
      // LRU recency is approximate, not a validity TTL. Never fsync per hash hit.
      if (Date.now() - row.used >= 5000) { this.touches.add(key); if (this.touches.size >= 128) this.flush(); }
      this.add(kind === 'metadata' ? 'persistentMetadataHits' : 'persistentHashHits');
      return { body: r.body, verified: r.verified };
    } catch { this.add('persistentErrors'); return undefined; }
  }

  private recordCost(r: RecordValue): number {
    return Buffer.byteLength(r.body) + Buffer.byteLength(r.logical) + Buffer.byteLength(r.signature) + 1024;
  }

  private queue(r: RecordValue): void {
    if (!this.db || this.recordCost(r) > this.diskBytes / 4 || Buffer.byteLength(r.body) > this.metadataBytes) return;
    const old = this.dirty.get(r.key); if (old) this.dirtyBytes -= this.recordCost(old);
    this.dirty.set(r.key, r); this.dirtyBytes += this.recordCost(r);
    if (this.dirty.size >= 128 || this.dirtyBytes >= 4 * MiB) this.flush();
  }

  flush(): void {
    if (!this.db || !this.dirty.size && !this.touches.size) return;
    const values = [...this.dirty.values()], touches = [...this.touches]; this.dirty.clear(); this.dirtyBytes = 0; this.touches.clear();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const touch = this.db.prepare('UPDATE entries SET used=? WHERE k=?'), now = Date.now();
      for (const key of touches) touch.run(now, key);
      const insert = this.db.prepare('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)');
      let total = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM entries').get();
      for (const r of values) {
        const previous = this.db.prepare('SELECT bytes FROM entries WHERE k=?').get(r.key);
        if (previous) { this.db.prepare('DELETE FROM entries WHERE k=?').run(r.key); total.n--; total.bytes -= previous.bytes; }
        const cost = this.recordCost(r);
        while (total.n + 1 > this.diskEntries || total.bytes + cost > this.diskBytes / 4) {
          const victim = this.db.prepare('SELECT k,bytes FROM entries ORDER BY used,k LIMIT 1').get();
          if (!victim) break;
          this.db.prepare('DELETE FROM entries WHERE k=?').run(victim.k);
          total.n--; total.bytes -= victim.bytes; this.add('persistentEvictions');
        }
        insert.run(r.key, r.logical, r.namespace, r.kind, r.signature, r.body, this.recordDigest(r), r.verified, now, cost);
        total.n++; total.bytes += cost;
      }
      this.db.exec('COMMIT'); this.add('persistentWrites', values.length); this.add('persistentTouches', touches.length); this.add('persistentTransactions'); this.refreshDBSize();
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* A failed cache write must not fail a registry read. */ }
      this.add('persistentErrors');
    }
  }

  private putMemory(key: string, entry: Entry): void {
    if (entry.bytes > this.metadataBytes) { this.add('metadataOversize'); return; }
    const old = this.reads.get(key); if (old) this.bytes -= old.bytes;
    this.reads.delete(key); this.reads.set(key, entry); this.bytes += entry.bytes;
    while (this.bytes > this.metadataBytes || this.reads.size > this.metadataEntries) {
      const victim = this.reads.keys().next().value!; this.bytes -= this.reads.get(victim)!.bytes;
      this.reads.delete(victim); this.add('metadataEvictions');
    }
  }
  private validateJSON(json: string, name: string): any {
    const value = JSON.parse(json);
    if (!value || value.name !== name || !value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions)) throw new Error('INVALID_METADATA_CACHE');
    return value;
  }
  private checkWork(work?: Work): void {
    if (work?.background && (this.backgroundCancelled || work.epoch !== this.backgroundEpoch)) throw Object.assign(new Error('Background cache work cancelled/preempted'), { code: 'CACHE_CANCELLED' });
  }
  private async acquireRebuild(): Promise<() => void> {
    if (this.activeRebuilds < this.rebuildLimit) { this.activeRebuilds++; return () => this.releaseRebuild(); }
    if (this.rebuildQueue.length >= this.rebuildQueueLimit) { this.add('rebuildRejected'); throw Object.assign(new Error('Read-cache rebuild capacity exhausted'), { code: 'CACHE_BUSY', status: 503, statusCode: 503 }); }
    this.add('rebuildQueued');
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      waiter.timer = setTimeout(() => {
        const i = this.rebuildQueue.indexOf(waiter);
        if (i >= 0) { this.rebuildQueue.splice(i, 1); this.add('rebuildQueueTimeouts'); reject(Object.assign(new Error('Read-cache rebuild queue deadline exceeded'), { code: 'CACHE_BUSY', status: 503, statusCode: 503 })); }
      }, 5000);
      this.rebuildQueue.push(waiter);
    });
  }
  private releaseRebuild(): void {
    this.activeRebuilds--;
    const waiter = this.rebuildQueue.shift();
    if (waiter) { if (waiter.timer) clearTimeout(waiter.timer); this.activeRebuilds++; waiter.resolve(() => this.releaseRebuild()); }
  }
  isBackground(): boolean { return this.context.getStore()?.background === true; }
  private async pace(work: Work | undefined, bytes: number): Promise<void> {
    this.checkWork(work);
    if (!work?.background) return;
    while (this.backgroundPaused) { this.checkWork(work); await sleep(20); }
    const rate = limit(this.options.warmup?.bytesPerSecond, 8 * MiB, 64 * 1024, 64 * MiB);
    work.nextReadAt = Math.max(work.nextReadAt, Date.now()) + bytes * 1000 / rate;
    for (let remaining = work.nextReadAt - Date.now(); remaining > 0; remaining = work.nextReadAt - Date.now()) {
      this.checkWork(work); await sleep(Math.min(20, remaining));
    }
    work.bytes += bytes;
  }
  async readBackgroundManifest(file: string): Promise<any> {
    const work = this.context.getStore();
    const before = fileIdentity(await this.stat(file)), chunks: Buffer[] = [];
    const stream = createReadStream(file, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW) as any, highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        await this.pace(work, chunk.length); chunks.push(chunk as Buffer); this.add('metadataReadBytes', chunk.length);
      }
    } finally { stream.destroy(); }
    if (fileIdentity(await this.stat(file)) !== before) throw Object.assign(new Error('Metadata changed during warmup read'), { code: 'CACHE_DRIFT' });
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async read(directory: string, name: string, mode: unknown[], rawRead: () => Promise<any>): Promise<any> {
    return this.validateJSON((await this.readVerified(directory, name, mode, rawRead)).json, name);
  }
  async readForWarmup(directory: string, name: string, mode: unknown[], rawRead: () => Promise<any>, force = false): Promise<WarmResult> {
    const result = await this.readVerified(directory, name, mode, rawRead, true, force);
    if (!result.proof) throw new Error('No verified warmup witness; source identity was unavailable');
    return { ...result.proof, json: result.json, package: name };
  }
  private async readVerified(directory: string, name: string, mode: unknown[], rawRead: () => Promise<any>, background = false, force = false): Promise<ReadValue> {
    if (!background) { this.activeForeground++; this.worker?.postMessage({ type: 'pause' }); }
    const work: Work = { background, force, epoch: this.backgroundEpoch, started: Date.now(), bytes: 0, oldestVerified: Date.now(), nextReadAt: Date.now() };
    try {
      return await this.context.run(work, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          this.checkWork(work);
          while (background && this.backgroundPaused) { this.checkWork(work); await sleep(20); }
          let namespace: string, signature: string;
          try { namespace = await this.namespace(); signature = await this.snapshot(directory); }
          catch { this.add('identityErrors'); return { json: JSON.stringify(await rawRead()) }; }
          await this.ensureDB();
          const logical = this.logical(directory, name, mode), key = this.key(namespace, logical, signature, 'metadata');
          const previous = this.signatures.get(logical);
          if (previous && previous !== signature) this.add('metadataInvalidations');
          this.signatures.delete(logical); this.signatures.set(logical, signature);
          while (this.signatures.size > this.metadataEntries) this.signatures.delete(this.signatures.keys().next().value!);
          const hit = this.reads.get(key);
          if (!force && hit && Date.now() - hit.verified <= this.maxAge) {
            this.reads.delete(key); this.reads.set(key, hit); this.add('metadataHits'); return { json: hit.json, proof: { namespace: hit.namespace, logical, signature: hit.signature, verified: hit.verified } };
          }
          this.add('metadataMisses');
          if (!force) {
            const persisted = await this.load(namespace, logical, signature, 'metadata');
            if (persisted !== undefined) {
              try {
                const result = this.validateJSON(persisted.body, name);
                if (signature === await this.snapshot(directory)) {
                  this.putMemory(key, { namespace, signature, json: persisted.body, bytes: Buffer.byteLength(persisted.body), verified: persisted.verified });
                  return { json: persisted.body, proof: { namespace, logical, signature, verified: persisted.verified } };
                }
                this.add('persistentInvalidations');
              } catch { this.add('persistentCorrupt'); }
            }
          }
          const flight = key + (force ? ':force' : '');
          let pending = this.reading.get(flight);
          if (pending) this.add('metadataCoalesced');
          else {
            pending = (async () => {
              const release = await this.acquireRebuild();
              try {
              const data = await rawRead(); this.checkWork(work);
              if (signature !== await this.snapshot(directory) || namespace !== await this.namespace()) throw Object.assign(new Error('Package changed during cache read'), { code: 'CACHE_DRIFT' });
              const json = JSON.stringify(data), verified = work.oldestVerified; this.validateJSON(json, name);
              this.putMemory(key, { namespace, signature, json, bytes: Buffer.byteLength(json), verified });
              this.queue({ key, logical, namespace, kind: 'metadata', signature, body: json, verified });
              this.add('metadataRebuilds'); if (this.db) this.add('persistentRebuilds'); return { json, proof: { namespace, logical, signature, verified } };
              } finally { release(); }
            })();
            this.reading.set(flight, pending);
          }
          try { return await pending; }
          catch (error: any) { if (error.code !== 'CACHE_DRIFT' || attempt) throw error; this.add('readRetries'); }
          finally { if (this.reading.get(flight) === pending) this.reading.delete(flight); }
        }
        throw new Error('Unstable package read');
      });
    } finally {
      this.flush();
      if (!background && --this.activeForeground === 0) this.worker?.postMessage({ type: 'resume' });
    }
  }

  async hash(file: string): Promise<string> {
    const work = this.context.getStore(); this.checkWork(work);
    const namespace = await this.namespace(), signature = fileIdentity(await this.stat(file));
    await this.ensureDB();
    const logical = path.resolve(file), key = this.key(namespace, logical, signature, 'hash');
    if (!work?.force) {
      const hit = this.hashes.get(key);
      if (hit && Date.now() - hit.verified <= this.maxAge) { this.hashes.delete(key); this.hashes.set(key, hit); this.add('hashHits'); if (work) work.oldestVerified = Math.min(work.oldestVerified, hit.verified); return hit.hash; }
      const stored = await this.load(namespace, logical, signature, 'hash');
      if (stored !== undefined && fileIdentity(await this.stat(file)) === signature) { this.rememberHash(key, stored.body, stored.verified); if (work) work.oldestVerified = Math.min(work.oldestVerified, stored.verified); return stored.body; }
    }
    this.add('hashMisses');
    const flight = key + (work?.force ? ':force' : ''); let pending = this.hashing.get(flight);
    if (pending) this.add('hashCoalesced');
    else {
      pending = (async () => {
        this.add('hashComputations'); const hash = createHash('sha1');
        // Runtime fs.open accepts numeric flags; older @types/node narrows this field to string.
        const stream = createReadStream(file, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW) as any, highWaterMark: 64 * 1024 });
        try {
          for await (const chunk of stream) {
            await this.pace(work, chunk.length);
            hash.update(chunk); this.add('hashBytes', chunk.length);
          }
        } finally { stream.destroy(); }
        if (fileIdentity(await this.stat(file)) !== signature) throw Object.assign(new Error('Tarball changed during checksum read'), { code: 'CACHE_DRIFT' });
        const actual = hash.digest('hex'); this.rememberHash(key, actual);
        this.queue({ key, logical, namespace, kind: 'hash', signature, body: actual, verified: Date.now() }); return actual;
      })();
      this.hashing.set(flight, pending);
    }
    try { return await pending; } finally { if (this.hashing.get(flight) === pending) this.hashing.delete(flight); }
  }
  private rememberHash(key: string, hash: string, verified = Date.now()): void {
    this.hashes.delete(key); this.hashes.set(key, { hash, verified });
    while (this.hashes.size > this.hashEntries) { this.hashes.delete(this.hashes.keys().next().value!); this.add('hashEvictions'); }
  }

  setBackgroundPaused(paused: boolean): void { this.backgroundPaused = paused; if (paused) this.backgroundEpoch++; }
  cancelBackground(): void { this.backgroundCancelled = true; }

  startWarmup(packages: string[], forceRehash = false): any {
    if (this.worker) return { ...this.job, busy: true };
    const max = limit(this.options.warmup?.maxPackages, 32, 1, 128);
    const names = [...new Set(packages)];
    if (!names.length || names.length > max || names.some(n => !NAME.test(n) || n.split('/').some(p => p.startsWith('.')))) throw new Error('Explicit valid hotspot package list required (within maxPackages)');
    const hasMatcher = typeof this.config.getMatchedPackagesSpec === 'function';
    const proxy = Object.fromEntries(names.map(n => [n, hasMatcher ? this.config.getMatchedPackagesSpec(n)?.proxy : undefined]));
    const config = { storage: this.root, offline: this.config.offline, metadataPolicy: this.config.metadataPolicy, verifyChecksum: this.config.verifyChecksum, minTarballSize: this.config.minTarballSize, readCache: this.options };
    let workerFile = path.join(__dirname, 'read-cache-worker.js');
    // Source tests may load TS; packaged runtime always uses build/read-cache-worker.js.
    try { require.resolve(workerFile); } catch { workerFile = path.join(__dirname, '../build/read-cache-worker.js'); }
    this.job = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), requested: names, completed: [], failed: [], preempted: [] };
    this.jobBackground = {};
    let worker: Worker;
    try { worker = new Worker(workerFile, { workerData: { root: this.root, config, packages: names, proxy, hasMatcher, forceRehash, paused: this.activeForeground > 0 }, resourceLimits: { maxOldGenerationSizeMb: 256 } }); }
    catch (error: any) { this.job.status = 'failed'; this.job.error = error.message; throw error; }
    this.worker = worker;
    const job = this.job, adoptions = new Set<Promise<void>>();
    worker.on('message', message => {
      if (this.worker !== worker) return;
      if (message.metrics) this.jobBackground = message.metrics;
      if (message.type === 'error') this.job.error = message.error;
      if (message.package) this.job.currentPackage = message.package;
      if (message.type === 'result') {
        if (message.error) this.job[message.preempted ? 'preempted' : 'failed'].push({ package: message.package, error: message.error });
        else {
          const adoption = (async () => {
          try {
              if (await this.adoptWarmResult(message)) {
              job.completed.push(message.package);
            } else job.preempted.push({ package: message.package, error: 'Source changed before warm adoption' });
          } catch { job.failed.push({ package: message.package, error: 'Warm result invalidated' }); }
          })();
          adoptions.add(adoption); void adoption.finally(() => adoptions.delete(adoption));
        }
      }
    });
    worker.on('error', e => { this.job.error = e.message; });
    worker.on('exit', async code => {
      if (this.workerTimer) clearTimeout(this.workerTimer);
      if (this.worker !== worker) return;
      await Promise.all([...adoptions]);
      this.worker = undefined;
      for (const [key, value] of Object.entries(this.jobBackground)) this.finishedBackground[key] = (this.finishedBackground[key] || 0) + value;
      this.jobBackground = {};
      this.job.status = this.job.status === 'cancelling' ? 'cancelled' : code || this.job.error || this.job.failed.length ? 'failed' : 'completed';
      this.job.finishedAt = new Date().toISOString();
    });
    return { ...this.job };
  }

  cancelWarmup(): any {
    if (this.worker) {
      this.job.status = 'cancelling'; const worker = this.worker; worker.postMessage({ type: 'cancel' });
      this.workerTimer = setTimeout(() => { if (this.worker === worker) void worker.terminate(); }, 500);
    }
    return { ...this.job };
  }

  stats(): any {
    const background: Record<string, number> = { ...this.finishedBackground };
    for (const [key, value] of Object.entries(this.jobBackground)) background[key] = (background[key] || 0) + value;
    return { schema: 1, backend: this.backend, stateError: this.stateError, namespace: this.lastNamespace, counters: { ...this.counts }, backgroundCounters: background, memory: { metadataEntries: this.reads.size, metadataBytes: this.bytes, hashEntries: this.hashes.size }, persistent: { rows: this.persistentRows, databaseBytes: this.persistentPageBytes }, inflight: { rebuilds: this.activeRebuilds, queued: this.rebuildQueue.length }, limits: { metadataBytes: this.metadataBytes, metadataEntries: this.metadataEntries, hashEntries: this.hashEntries, persistentBytes: this.diskBytes, persistentEntries: this.diskEntries, persistentMaxAgeMs: this.maxAge, rebuildConcurrency: this.rebuildLimit, rebuildQueue: this.rebuildQueueLimit, warmupConcurrency: 1 }, warmup: { ...this.job }, validationBasis: 'File identity reuse is an acceleration assumption, not cryptographic proof; imports and final acceptance must hash content.' };
  }

  async adoptWarmResult(result: WarmResult): Promise<boolean> {
    if (!result || typeof result.package !== 'string' || !NAME.test(result.package) || result.package.split('/').some(p => p.startsWith('.')) || typeof result.json !== 'string' || !Number.isSafeInteger(result.verified) || result.verified > Date.now() + 60000 || Date.now() - result.verified > this.maxAge) return false;
    const directory = path.join(this.root, result.package), namespace = await this.namespace();
    const logical = this.logical(directory, result.package, this.mode(this.config, result.package));
    if (result.namespace !== namespace || result.logical !== logical || result.signature !== await this.snapshot(directory)) return false;
    this.validateJSON(result.json, result.package);
    if (Buffer.byteLength(result.json) > this.metadataBytes) return false;
    const key = this.key(namespace, logical, result.signature, 'metadata');
    this.putMemory(key, { namespace, signature: result.signature, json: result.json, bytes: Buffer.byteLength(result.json), verified: result.verified });
    this.add('warmAdoptions'); return true;
  }
  async rebuildPersistent(): Promise<any> {
    await this.ensureDB();
    if (this.worker || this.activeForeground) return { rebuilt: false, busy: true };
    this.reads.clear(); this.hashes.clear(); this.signatures.clear(); this.bytes = 0;
    if (!this.db) return { rebuilt: false, backend: this.backend, reason: 'Persistence unavailable; stop users of the dedicated state directory before recreating a corrupt database.' };
    try {
      this.db.exec('BEGIN IMMEDIATE; DELETE FROM entries; COMMIT;'); this.refreshDBSize();
      return { rebuilt: true, nextRead: 'full verification' };
    } catch { try { this.db.exec('ROLLBACK'); } catch {} this.add('persistentErrors'); return { rebuilt: false, busy: true }; }
  }
  close(): void { this.flush(); if (this.db) { this.db.close(); this.db = undefined; } }
}

const managers = new Map<string, ReadCacheManager>();
export function getReadCacheManager(config: OfflineStorageConfig, root: string): ReadCacheManager {
  const key = JSON.stringify([path.resolve(root), config.readCache || {}, config.metadataPolicy || 'local-latest', config.offline, config.verifyChecksum, config.minTarballSize]);
  let manager = managers.get(key);
  if (!manager) { manager = new ReadCacheManager(root, config); managers.set(key, manager); }
  return manager;
}
