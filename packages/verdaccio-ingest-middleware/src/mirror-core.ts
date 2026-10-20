// Canonical source: scripts/mirror-core.ts. Run scripts/update-mirror-core.mjs after editing.
// Mirrored into both independently distributable plugins; no extra runtime dependency.
import { constants, createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import * as tar from 'tar';
import semver from 'semver';

export const SCOPE = 'verdaccio-artifacts-v2';
const SCHEMA = 2;
const HEX = /^[a-f0-9]{64}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const VERSION_FIELDS = ['name','version','description','main','module','types','typings','typesVersions','type','sideEffects','bin','man','directories','files','exports','imports','browser','scripts','config','gypfile','hasInstallScript','dependencies','devDependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','bundleDependencies','bundledDependencies','overrides','engines','devEngines','os','cpu','libc','repository','keywords','author','contributors','license','bugs','homepage','deprecated','funding','packageManager','workspaces'];
export function projectPackageFields(raw:any):any{const out:any={};for(const field of VERSION_FIELDS)if(raw[field]!==undefined)out[field]=raw[field];return out;}
export type Artifact = { package: string; version: string; path: string; sha256: string; sha1: string; integrity: string; size: number; aliases: string[] };
export type Snapshot = { schema: number; sequence: number; repo_id: string; scope_id: string; snapshot_id: string; started_at: string; ended_at: string; semantics: string; complete: boolean; errors: string[]; artifacts: Artifact[]; metadata: Record<string, any>; metadata_missing_artifacts: string[]; root: string; artifact_root: string };
export type Transfer = { schema: number; scope_id: string; transfer_id: string; source_repo_id: string; target_repo_id: string; base_root: string; source_root: string; expected_artifact_root: string; source: Snapshot; target: Snapshot; files: Artifact[]; metadata_adapter: string };
export type Receipt = { schema: number; scope_id: string; transfer_id: string; source_repo_id: string; target_repo_id: string; base_root: string; source_root: string; source_snapshot_seq: number; target_snapshot_seq: number; expected_artifact_root: string; target_root: string; target_snapshot_id: string; verified_at: string; status: string; receipt_hash: string };
type Journal = { transfer: Transfer; state: string; receipt?: Receipt; error?: string };
export type WriterIdentity={pid:number;boot_id:string;start_time:string;pid_namespace:string};
const validIdentity=(o:any):boolean=>o&&Number.isSafeInteger(o.pid)&&o.pid>0&&o.pid<=2147483647&&/^[a-f0-9-]{36}$/.test(o.boot_id)&&/^\d+$/.test(o.start_time)&&/^pid:\[\d+\]$/.test(o.pid_namespace);
async function processStart(pid:number):Promise<string>{const raw=await fs.readFile(`/proc/${pid}/stat`,'utf8'),start=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)[19];if(!/^\d+$/.test(start))throw new Error('Cannot verify process start identity');return start;}
export async function getWriterIdentity():Promise<WriterIdentity>{if(process.platform!=='linux')throw new Error('Mirror writer locking requires Linux boot/proc identity; this platform fails closed');const identity={pid:process.pid,boot_id:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),start_time:await processStart(process.pid),pid_namespace:await fs.readlink('/proc/self/ns/pid')};if(!validIdentity(identity))throw new Error('Cannot verify Linux writer identity');return identity;}
async function sameProcessAlive(owner:WriterIdentity,current:WriterIdentity):Promise<boolean>{if(owner.boot_id!==current.boot_id)return false;if(owner.pid_namespace!==current.pid_namespace)throw new Error('Writer record belongs to another PID namespace; verify ownership manually before sharing this cache');try{return await processStart(owner.pid)===owner.start_time;}catch(e:any){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw new Error('Cannot verify writer process identity; refusing takeover: '+e.message);}}
export type MirrorOptions = { registryURL?: string; maxBytes?: number; maxEntries?: number; maxFileBytes?: number; maxJSONBytes?: number; onImported?: (names:string[])=>Promise<void>; now?:()=>Date; hooks?: { afterWalk?: () => Promise<void>; beforeStage?: () => Promise<void>; afterArtifact?: () => Promise<void>; beforeReclaim?:()=>Promise<void>; afterSnapshotSaved?:()=>Promise<void>; afterWriterChoosing?:()=>Promise<void>; afterWriterTicket?:()=>Promise<void> } };

export function stable(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + (k==='exports'||k==='imports'?JSON.stringify(value[k]):stable(value[k]))).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (v: any): string => createHash('sha256').update(stable(v)).digest('hex');
const key = (a: Artifact): string => `${a.package}@${a.version}`;
const canonical = (name: string, version: string): string => `${name}/${name.split('/').pop()}-${version}.tgz`;
const artifactRoot = (as: Artifact[]): string => digest(as.map(a => ({ package: a.package, version: a.version, sha256: a.sha256, size: a.size })).sort((a,b) => stable(a).localeCompare(stable(b))));
const semantic = (s: Snapshot): any => ({ schema: s.schema, repo_id: s.repo_id, scope_id: s.scope_id, artifacts: s.artifacts, metadata: s.metadata });
const safeID = (s: string): string => { if (typeof s !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(s)) throw new Error('Invalid identifier'); return s; };
function safeRelative(s: string): string {
  if (typeof s !== 'string' || s.length > 1024 || s.includes('\\') || /[%\x00-\x1f:]/.test(s.replace(/%2f/gi,'/')) || s.startsWith('/') || s.replace(/%2f/gi,'/').split('/').some(x => x === '.' || x === '..' || x === '')) throw new Error(`Unsafe path: ${s}`);
  return s;
}
function normalizedDirectory(s: string): string {
  const n = s.replace(/%2f/gi, '/');
  if (!NAME.test(n) || n.split('/').some(x => x.startsWith('.'))) throw new Error(`Invalid package directory: ${s}`);
  return n;
}
const fingerprint = (s: any): string => [s.dev,s.ino,s.size,s.mtimeNs ?? s.mtimeMs,s.ctimeNs ?? s.ctimeMs,s.mode].join(':');
async function exists(p: string): Promise<boolean> { try { await fs.lstat(p); return true; } catch(e: any) { if(e.code === 'ENOENT') return false; throw e; } }
async function json(p: string): Promise<any> { return JSON.parse(await fs.readFile(p, 'utf8')); }
function expansionCap(max:number):Transform {
  let total=0,started=false,head=Buffer.alloc(0);
  return new Transform({transform(chunk,_e,cb){
    total+=chunk.length;if(total>max){cb(new Error('Archive expansion limit'));return;}
    if(!started){head=Buffer.concat([head,chunk]);if(head.length<2){cb();return;}started=true;chunk=head;if(chunk[0]===0x1f&&chunk[1]===0x8b){cb(new Error('Nested compression forbidden'));return;}}
    cb(null,chunk);
  }});
}
async function atomic(p: string, value: any): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  const f = await fs.open(tmp, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(value, null, 2)); await f.sync(); } finally { await f.close(); }
  await fs.rename(tmp, p);
  const d = await fs.open(path.dirname(p), 'r'); try { await d.sync(); } finally { await d.close(); }
}
async function safeParents(root: string, relative: string): Promise<string> {
  const parts = safeRelative(relative).split('/');
  let p = root;
  const rootStat = await fs.lstat(p);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Storage root must be a real directory');
  for (const part of parts.slice(0,-1)) {
    const parent=p;p = path.join(p, part);
    try { await fs.mkdir(p);const d=await fs.open(parent,'r');try{await d.sync();}finally{await d.close();} } catch(e: any) { if(e.code !== 'EEXIST') throw e; }
    const s = await fs.lstat(p); if(!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Symlink/non-directory destination: ${p}`);
  }
  const dest = path.join(root, relative);
  if (await exists(dest)) { const s = await fs.lstat(dest); if(!s.isFile() || s.isSymbolicLink()) throw new Error(`Unsafe destination: ${relative}`); }
  return dest;
}

/** Read once, hash that stream, optionally stage those exact bytes, then verify source identity. */
export async function stableRead(p: string, dest?: string): Promise<{ sha256: string; sha1: string; integrity: string; size: number }> {
  const handle = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Not a regular file: ${p}`);
    const h = createHash('sha256'), h1 = createHash('sha1'), h512 = createHash('sha512'); let size = 0;
    const tap = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; h.update(chunk); h1.update(chunk); h512.update(chunk); callback(null, chunk); } });
    const input = handle.createReadStream({ autoClose: false });
    if(dest) { await fs.mkdir(path.dirname(dest), { recursive: true }); await pipeline(input, tap, createWriteStream(dest, { flags: 'wx', mode: 0o600 })); const f = await fs.open(dest, 'r'); try { await f.sync(); } finally { await f.close(); } }
    else { await pipeline(input, tap, new Transform({ transform(_c,_e,cb) { cb(); } })); }
    const after = await handle.stat({ bigint: true }), named = await fs.lstat(p, { bigint: true });
    if (fingerprint(before) !== fingerprint(after) || fingerprint(after) !== fingerprint(named) || BigInt(size) !== after.size) throw new Error(`Source changed while reading: ${p}`);
    return { sha256: h.digest('hex'), sha1: h1.digest('hex'), integrity: 'sha512-' + h512.digest('base64'), size };
  } finally { await handle.close(); }
}
function publicMetadata(raw: any, name: string): any {
  if (!raw || typeof raw !== 'object' || (raw.name && normalizedDirectory(raw.name) !== name) || !raw.versions || typeof raw.versions !== 'object') throw new Error(`Unsupported Verdaccio metadata: ${name}`);
  const versions: any = Object.create(null);
  for(const [v, value] of Object.entries(raw.versions) as [string, any][]) {
    if(!semver.valid(v) || !value || typeof value !== 'object') throw new Error(`Invalid metadata version: ${name}@${v}`);
    const out: any = Object.create(null);
    for(const field of VERSION_FIELDS) if(value[field] !== undefined) out[field] = value[field];
    out.name = name; out.version = v;
    versions[v] = out;
  }
  const tags: any = Object.create(null);
  for(const [tag,v] of Object.entries(raw['dist-tags'] || {})) if(typeof v === 'string' && versions[v]) tags[tag] = v;
  const time: any = Object.create(null);
  for (const [key, value] of Object.entries(raw.time || {})) if ((key === 'created' || key === 'modified' || versions[key]) && typeof value === 'string' && Number.isFinite(Date.parse(value))) time[key] = value;
  return { name, versions, 'dist-tags': tags, ...(Object.keys(time).length ? { time } : {}) };
}
async function tarballIdentity(file:string,artifact:Artifact,maxBytes:number):Promise<void>{
  let found:any, count=0;
  const parser=new (tar as any).Parser({strict:true,gzip:false,brotli:false,zstd:false,maxMetaEntrySize:1024*1024,onReadEntry:(e:any)=>{
    const p=e.path.replace(/^(\.\/)+/,'');
    if(p!=='package/package.json'){e.resume();return;}
    if(++count>1||e.type!=='File'||e.size>1024*1024){parser.abort(new Error('Invalid/duplicate package manifest inside tgz'));return;}
    const chunks:Buffer[]=[];e.on('data',(c:Buffer)=>chunks.push(c));e.on('end',()=>{try{found=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(err){parser.abort(err);}});
  }});
  await pipeline(createReadStream(file),createGunzip(),expansionCap(maxBytes),parser);
  if(!found||found.name!==artifact.package||found.version!==artifact.version)throw new Error(`Tarball identity mismatch: ${key(artifact)}`);
}
function validateArtifact(a: Artifact): void {
  if(!a || !NAME.test(a.package) || a.package.split('/').some(x=>x.startsWith('.')) || !semver.valid(a.version) || a.path !== canonical(a.package,a.version) || !HEX.test(a.sha256) || !/^[a-f0-9]{40}$/.test(a.sha1) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(a.integrity) || !Number.isSafeInteger(a.size) || a.size < 0 || !Array.isArray(a.aliases)) throw new Error('Invalid artifact record');
  safeRelative(a.path); a.aliases.forEach(safeRelative);
}
export function validateSnapshot(s: Snapshot): void {
  if(!s || s.schema !== SCHEMA || !Number.isSafeInteger(s.sequence) || s.sequence<1 || s.scope_id !== SCOPE || !s.complete || s.errors?.length || !Array.isArray(s.artifacts) || !HEX.test(s.root) || !HEX.test(s.artifact_root)) throw new Error('Incomplete, legacy or unsupported inventory; run a full v2 scan');
  safeID(s.repo_id); safeID(s.snapshot_id);
  if(s.artifacts.length > 500000) throw new Error('Inventory entry limit');
  s.artifacts.forEach(validateArtifact);
  const seen = new Set();
  for(const a of s.artifacts) { const k = key(a) + ':' + a.sha256; if(seen.has(k)) throw new Error('Duplicate inventory record'); seen.add(k); }
  if(digest(semantic(s)) !== s.root || artifactRoot(s.artifacts) !== s.artifact_root) throw new Error('Inventory root mismatch');
  for(const [n,m] of Object.entries(s.metadata)) { if(!NAME.test(n) || stable(publicMetadata(m,n)) !== stable(m)) throw new Error('Unsupported metadata adapter'); }
}
export function reconcile(source: Snapshot, target: Snapshot): any {
  validateSnapshot(source); validateSnapshot(target);
  if(source.repo_id === target.repo_id) throw new Error('Source and target repo_id must differ; cloned repositories must reset their mirror identity');
  const sm = new Map<string,Artifact[]>(), tm = new Map<string,Artifact[]>();
  for(const a of source.artifacts) sm.set(key(a), [...(sm.get(key(a))||[]),a]);
  for(const a of target.artifacts) tm.set(key(a), [...(tm.get(key(a))||[]),a]);
  const missing: Artifact[] = [], conflicts: any[] = [], aliases: any[] = [], targetOnly: Artifact[] = [];
  for(const [k,as] of sm) {
    const bs = tm.get(k)||[], hashes = new Set([...as,...bs].map(a=>a.sha256));
    if(hashes.size > 1) conflicts.push({ package_version:k, source:as, target:bs });
    else if(!bs.length) missing.push(as[0]);
    else if(stable(as[0].aliases) !== stable(bs[0].aliases)) aliases.push({ package_version:k, sha256:as[0].sha256, source:as[0].aliases, target:bs[0].aliases });
  }
  for(const [k,bs] of tm) if(!sm.has(k)) {targetOnly.push(...bs);if(new Set(bs.map(a=>a.sha256)).size>1)conflicts.push({package_version:k,source:[],target:bs});}
  return { source_root:source.root, target_root:target.root, missing, target_only:targetOnly, conflicts, aliases, metadata_only:source.metadata_missing_artifacts, cleanup:{ dry_run:true, candidates: [...source.artifacts,...target.artifacts].filter(a=>a.aliases.length>1).map(a=>({ repo_id:source.artifacts.includes(a)?source.repo_id:target.repo_id, package_version:key(a), sha256:a.sha256, paths:a.aliases, action:'quarantine-backup-plan-only' })), instructions:'先停止写入并重新校验全部别名 hash；隔离复制并验证备份与引用后再人工审批。此插件不执行删除。' } };
}

export class MirrorRepository {
  readonly state: string;
  readonly options: Required<Pick<MirrorOptions,'maxBytes'|'maxEntries'|'maxFileBytes'|'maxJSONBytes'>> & MirrorOptions;
  constructor(readonly storage: string, options: MirrorOptions = {}) {
    this.storage = path.resolve(storage); this.state = path.join(this.storage,'.mirror-sync');
    this.options = { maxBytes:20*1024**3,maxEntries:500000,maxFileBytes:2*1024**3,maxJSONBytes:64*1024**2,...options };
    if(options.registryURL){const u=new URL(options.registryURL);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('registryURL must be an HTTP(S) base URL without credentials/query/fragment');}
  }
  async init(): Promise<string> {
    const s = await fs.lstat(this.storage); if(!s.isDirectory() || s.isSymbolicLink()) throw new Error('Storage root must be a real directory');
    await fs.mkdir(this.state,{recursive:true}); if((await fs.lstat(this.state)).isSymbolicLink()) throw new Error('Unsafe mirror state directory');
    for(const child of ['snapshots','transfers','archives','staging','imports','uploads','conflicts','writers']){const p=path.join(this.state,child);await fs.mkdir(p,{recursive:true});const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Unsafe mirror state subdirectory: '+child);}
    const file = path.join(this.state,'repository.json');
    if(!await exists(file)) { try { const f=await fs.open(file,'wx',0o600); try{await f.writeFile(JSON.stringify({schema:SCHEMA,repo_id:randomUUID(),scope_id:SCOPE})); await f.sync();} finally{await f.close();} }catch(e:any){if(e.code!=='EEXIST')throw e;} }
    for(const p of [this.state,this.storage]){const d=await fs.open(p,'r');try{await d.sync();}finally{await d.close();}}
    const id=await json(file); safeID(id.repo_id); if(id.scope_id!==SCOPE)throw new Error('Unsupported repository scope'); return id.repo_id;
  }
  private async locked<T>(action:()=>Promise<T>):Promise<T> {
    // Unique immutable tickets avoid compare-then-unlink on a shared stale lock.
    // A choosing flag is visible before selecting max(ticket)+1; ties use the unique owner id.
    // Contenders fail closed instead of waiting. Dead owners' immutable records never block entry.
    const identity=await getWriterIdentity();await this.init();const dir=path.join(this.state,'writers'),id=`${process.pid}-${randomUUID()}`,record=path.join(dir,'owner-'+id),temp=path.join(this.state,'.writer-ticket-'+id);let ownState=JSON.stringify({...identity,state:'choosing'});
    const readState=async(file:string):Promise<string|undefined>=>{try{return await fs.readlink(file);}catch(e:any){if(e.code==='ENOENT')return undefined;throw e;}};
    const parseState=(value:string):any=>{const o=JSON.parse(value);if(!validIdentity(o)||!['choosing','ticket'].includes(o.state)||o.state==='ticket'&&(!/^\d+$/.test(o.number)||BigInt(o.number)<1n))throw new Error('Invalid writer startup identity');return o;};
    await fs.symlink(ownState,record);
    try{
      await this.options.hooks?.afterWriterChoosing?.();
      let number=0n;for(const entry of await fs.readdir(dir)){const value=await readState(path.join(dir,entry));if(!value)continue;const state=parseState(value);if(state.state==='ticket'&&await sameProcessAlive(state,identity)&&BigInt(state.number)>number)number=BigInt(state.number);}number++;
      // Replace the target of one persistent participant record atomically: no disappearing choosing flag.
      const selected=JSON.stringify({...identity,state:'ticket',number:number.toString()});await fs.symlink(selected,temp);await fs.rename(temp,record);ownState=selected;await this.options.hooks?.afterWriterTicket?.();
      for(const entry of await fs.readdir(dir)){
        if(path.join(dir,entry)===record)continue;
        const owner=/^owner-(\d+)-([a-f0-9-]+)$/.exec(entry);if(!owner)throw new Error('Unknown writer coordination record');
        const target=await readState(path.join(dir,entry));if(target===undefined)continue;const state=parseState(target),otherID=`${owner[1]}-${owner[2]}`;if(state.pid!==Number(owner[1]))throw new Error('Writer record PID mismatch');if(!await sameProcessAlive(state,identity))continue;
        if(state.state==='choosing'||BigInt(state.number)<number||BigInt(state.number)===number&&otherID<id)throw new Error('Mirror operation already running');
      }
      return await this.legacyLocked(action,identity);
    }finally{if(await readState(record)===ownState)await fs.unlink(record);try{await fs.unlink(temp);}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  }
  private async legacyLocked<T>(action:()=>Promise<T>,identity:WriterIdentity):Promise<T> {
    await this.init();const lock=path.join(this.state,'writer.lock'),token=JSON.stringify({...identity,token:randomUUID()});
    for(let attempt=0;;attempt++){
      try{await fs.symlink(token,lock);break;}catch(e:any){if(e.code!=='EEXIST'||attempt>2)throw e;}
      const s=await fs.lstat(lock,{bigint:true});let pid:number|undefined,priorIdentity:WriterIdentity|undefined;
      if(s.isSymbolicLink()){const owner=await fs.readlink(lock);try{const parsed=JSON.parse(owner);if(validIdentity(parsed)){priorIdentity=parsed;pid=parsed.pid;}}catch{}if(!priorIdentity){const m=/^pid-(\d+)-[a-f0-9-]+$/.exec(owner);if(!m)throw new Error('Unknown writer lock format; ownership must be checked manually');pid=Number(m[1]);}}
      else{
        try{const parsed=await json(lock);pid=parsed.pid;if(validIdentity(parsed))priorIdentity=parsed;}catch{/* Recover malformed legacy locks only after proving no live file descriptor holds them. */}
        if(!Number.isSafeInteger(pid)||!pid){
          if(process.platform!=='linux')throw new Error('Cannot verify incomplete legacy lock ownership on this platform');
          for(const entry of await fs.readdir('/proc')){
            if(!/^\d+$/.test(entry))continue;
            try{
              if((await fs.stat('/proc/'+entry,{bigint:true})).uid!==s.uid)continue;
              // systemd --user cannot run this JS writer in its own PID; its Node service is a separate PID.
              // WSL protects the manager's descriptors even from the same uid.
              if(['systemd','(sd-pam)'].includes((await fs.readFile('/proc/'+entry+'/comm','utf8')).trim()))continue;
              for(const fd of await fs.readdir('/proc/'+entry+'/fd')){try{const open=await fs.stat('/proc/'+entry+'/fd/'+fd,{bigint:true});if(open.dev===s.dev&&open.ino===s.ino)throw new Error('Mirror operation already running: incomplete legacy lock is held open');}catch(err:any){if(!['ENOENT','ESRCH'].includes(err.code))throw err;}}
            }catch(err:any){if(!['ENOENT','ESRCH'].includes(err.code))throw err;}
          }
          if(fingerprint(await fs.lstat(lock,{bigint:true}))!==fingerprint(s))throw new Error('Legacy lock changed while checking ownership; retry');
          await this.options.hooks?.beforeReclaim?.();await fs.rename(lock,lock+'.recovered-'+randomUUID());continue;
        }
      }
      let alive=true;if(priorIdentity)alive=await sameProcessAlive(priorIdentity,identity);else try{process.kill(pid!,0);}catch(e:any){if(e.code==='ESRCH')alive=false;else throw e;}
      if(alive)throw new Error('Mirror operation already running');await this.options.hooks?.beforeReclaim?.();await fs.unlink(lock);
    }
    try{return await action();}finally{try{if(await fs.readlink(lock)===token)await fs.unlink(lock);}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  }
  private async nextSequence():Promise<number>{
    const p=path.join(this.state,'clock.json');let sequence=0;
    try{const c=await json(p);if(!Number.isSafeInteger(c.sequence)||c.checksum!==digest(c.sequence))throw new Error('Invalid clock');sequence=c.sequence;}catch{for(const f of await fs.readdir(path.join(this.state,'snapshots'))){if(f.endsWith('.json'))sequence=Math.max(sequence,(await json(path.join(this.state,'snapshots',f))).sequence||0);}}
    sequence++;await atomic(p,{sequence,checksum:digest(sequence)});return sequence;
  }
  private async walk(): Promise<Map<string,string>> {
    const found=new Map<string,string>();
    const visit=async(relative:string):Promise<void>=> {
      for(const e of await fs.readdir(path.join(this.storage,relative),{withFileTypes:true})) {
        if(e.name.startsWith('.'))continue;
        const rel=relative?`${relative}/${e.name}`:e.name; const p=path.join(this.storage,rel);
        const s=await fs.lstat(p,{bigint:true});
        if(s.isSymbolicLink())throw new Error(`Symlink in inventory scope: ${rel}`);
        if(s.isDirectory()) { if(rel.split('/').length>2)throw new Error(`Unexpected nested package directory: ${rel}`); await visit(rel); }
        else if(s.isFile() && (e.name.endsWith('.tgz')||e.name==='package.json')) { if(s.size>BigInt(this.options.maxFileBytes))throw new Error('Inventory file size limit: '+rel);found.set(rel,fingerprint(s)); if(found.size>this.options.maxEntries)throw new Error('Inventory entry limit'); }
      }
    };
    await visit(''); return found;
  }
  /** A verified scan interval, never an instantaneous filesystem snapshot. Rehash every artifact. */
  async scan():Promise<Snapshot> { return this.locked(()=>this.scanUnlocked()); }
  private async scanUnlocked():Promise<Snapshot> {
    const repo_id=await this.init(), sequence=await this.nextSequence(), started_at=new Date().toISOString();
    const artifacts:Artifact[]=[], grouped=new Map<string,Artifact>(), metadata:any=Object.create(null), errors:string[]=[];
    let before=new Map<string,string>();
    try {
      before=await this.walk(); await this.options.hooks?.afterWalk?.();
      for(const [rel,fp] of before) {
        const dir=path.posix.dirname(rel), name=normalizedDirectory(dir), file=path.posix.basename(rel);
        if(file==='package.json') {
          if(Number((await fs.lstat(path.join(this.storage,rel))).size)>this.options.maxJSONBytes)throw new Error('Metadata size limit');
          await stableRead(path.join(this.storage,rel));
          const m=publicMetadata(await json(path.join(this.storage,rel)),name);
          if(fingerprint(await fs.lstat(path.join(this.storage,rel),{bigint:true}))!==fp)throw new Error(`Metadata changed: ${rel}`);
          if(metadata[name] && stable(metadata[name])!==stable(m))throw new Error(`Conflicting metadata aliases: ${name}`);
          metadata[name]=m; continue;
        }
        let version:string|null=null; const base=file.slice(0,-4);
        for(let i=base.lastIndexOf('-');i>=0;i=base.lastIndexOf('-',i-1)) {if(semver.valid(base.slice(i+1))){version=base.slice(i+1);break;} if(i===0)break;}
        if(!version)throw new Error(`Unidentified tarball version: ${rel}`);
        const h=await stableRead(path.join(this.storage,rel));
        await tarballIdentity(path.join(this.storage,rel),{package:name,version} as Artifact,this.options.maxBytes);
        if(fingerprint(await fs.lstat(path.join(this.storage,rel),{bigint:true}))!==fp)throw new Error(`Source changed during scan: ${rel}`);
        const groupKey=`${name}@${version}:${h.sha256}`, existing=grouped.get(groupKey);
        if(existing)existing.aliases.push(rel); else {const a={package:name,version,path:canonical(name,version),...h,aliases:[rel]};artifacts.push(a);grouped.set(groupKey,a);}
      }
      const after=await this.walk();
      if(stable([...before].sort())!==stable([...after].sort()))throw new Error('Inventory changed during scan; rerun full scan');
    }catch(e:any){errors.push(e.message);}
    artifacts.forEach(a=>a.aliases.sort()); artifacts.sort((a,b)=>(key(a)+a.sha256).localeCompare(key(b)+b.sha256));
    const present=new Set(artifacts.map(key)), missing:string[]=[];
    for(const [n,m]of Object.entries(metadata) as [string,any][])for(const v of Object.keys(m.versions))if(!present.has(`${n}@${v}`))missing.push(`${n}@${v}`);
    const s:Snapshot={schema:SCHEMA,sequence,repo_id,scope_id:SCOPE,snapshot_id:randomUUID(),started_at,ended_at:new Date().toISOString(),semantics:'verified-scan-interval',complete:errors.length===0,errors,artifacts,metadata,metadata_missing_artifacts:missing.sort(),root:'',artifact_root:artifactRoot(artifacts)};
    s.root=digest(semantic(s));
    await atomic(path.join(this.state,'snapshots',s.snapshot_id+'.json'),s);
    await this.options.hooks?.afterSnapshotSaved?.();
    if(s.complete)await this.updateIndex(s);
    return s;
  }
  async snapshots():Promise<any[]> {await this.init();const dir=path.join(this.state,'snapshots');if(!await exists(dir))return[]; const out=[];for(const f of await fs.readdir(dir)){if(!f.endsWith('.json'))continue;const s=await json(path.join(dir,f));out.push({snapshot_id:s.snapshot_id,sequence:s.sequence,started_at:s.started_at,ended_at:s.ended_at,complete:s.complete,root:s.root,files:s.artifacts.length,errors:s.errors});}return out.sort((a,b)=>(b.sequence||0)-(a.sequence||0));}
  async snapshot(id:string):Promise<Snapshot>{await this.init();return json(path.join(this.state,'snapshots',safeID(id)+'.json'));}
  private indexObservation(index:any,s:Snapshot):void{
    const current=new Map<string,any>();
    for(const a of s.artifacts){const k=JSON.stringify([a.package,a.version]);const item=current.get(k)||{package:a.package,version:a.version,hashes:[],paths:[],metadata_present:!!s.metadata[a.package]?.versions[a.version],metadata_hash:s.metadata[a.package]?.versions[a.version]?digest(s.metadata[a.package].versions[a.version]):null};item.hashes.push(a.sha256);item.paths.push(...a.aliases);current.set(k,item);}
    for(const [name,m]of Object.entries(s.metadata) as [string,any][])for(const v of Object.keys(m.versions)){const k=JSON.stringify([name,v]);if(!current.has(k))current.set(k,{package:name,version:v,hashes:[],paths:[],metadata_present:true,metadata_hash:digest(m.versions[v])});}
    for(const k of new Set([...Object.keys(index.by_identity),...current.keys()])){
      const old=index.by_identity[k],item=current.get(k)||{package:old.package,version:old.version,hashes:[],paths:[],metadata_present:false,metadata_hash:null};item.hashes.sort();item.paths.sort();
      if(old&&stable(old.last)===stable(item))continue;
      const change=!old?(item.hashes.length?'added':'metadata-only'):old.last.hashes.length&&!item.hashes.length?'removed':!old.last.hashes.length&&item.hashes.length?'added':stable(old.last.hashes)!==stable(item.hashes)?'hash-changed':stable(old.last.paths)!==stable(item.paths)?'aliases-changed':'metadata-changed';
      const event={sequence:s.sequence,snapshot_id:s.snapshot_id,started_at:s.started_at,ended_at:s.ended_at,change,...item};
      index.by_identity[k]={package:item.package,version:item.version,last:item,events:[...(old?.events||[]),event]};
    }
    index.head={snapshot_id:s.snapshot_id,sequence:s.sequence,root:s.root,artifact_root:s.artifact_root};index.snapshot_id=s.snapshot_id;index.seen_snapshot_ids=index.seen_snapshot_ids||[];if(!index.seen_snapshot_ids.includes(s.snapshot_id))index.seen_snapshot_ids.push(s.snapshot_id);
  }
  private async rebuiltIndex():Promise<any>{
    const repo_id=await this.init(),index:any={schema:SCHEMA,repo_id,kind:'package-version-observation-index',by_identity:{},head:null,seen_snapshot_ids:[]};const snapshots:Snapshot[]=[];
    for(const f of await fs.readdir(path.join(this.state,'snapshots'))){if(!f.endsWith('.json'))continue;const s=await json(path.join(this.state,'snapshots',f));index.seen_snapshot_ids.push(s.snapshot_id);if(s.repo_id===repo_id&&s.complete&&Number.isSafeInteger(s.sequence)){validateSnapshot(s);snapshots.push(s);}}
    for(const s of snapshots.sort((a,b)=>a.sequence-b.sequence))this.indexObservation(index,s);return index;
  }
  private async index():Promise<any>{
    let body:any;try{const {checksum,...value}=await json(path.join(this.state,'index.json'));if(value.repo_id!==await this.init()||value.kind!=='package-version-observation-index'||!Array.isArray(value.seen_snapshot_ids)||checksum!==digest(value))throw new Error('Index drift');body=value;}catch{return this.rebuiltIndex();}
    // A valid old checksum does not prove all durable snapshots were indexed. Inspect every unknown id.
    const seen=new Set(body.seen_snapshot_ids),pending:Snapshot[]=[];
    for(const file of await fs.readdir(path.join(this.state,'snapshots'))){if(!file.endsWith('.json')||seen.has(file.slice(0,-5)))continue;const s=await json(path.join(this.state,'snapshots',file));body.seen_snapshot_ids.push(s.snapshot_id);if(s.repo_id===body.repo_id&&s.complete){validateSnapshot(s);if(body.head&&s.sequence<=body.head.sequence)return this.rebuiltIndex();pending.push(s);}}
    for(const s of pending.sort((a,b)=>a.sequence-b.sequence))this.indexObservation(body,s);return body;
  }
  private async updateIndex(s:Snapshot):Promise<void>{const index=await this.index();if(!index.head||index.head.sequence<s.sequence)this.indexObservation(index,s);await atomic(path.join(this.state,'index.json'),{...index,checksum:digest(index)});}
  async rebuildHistoryIndex():Promise<any>{return this.locked(async()=>{const index=await this.rebuiltIndex();await atomic(path.join(this.state,'index.json'),{...index,checksum:digest(index)});return {head:index.head,identities:Object.keys(index.by_identity).length,semantics:'saved-successful-scan-observations'};});}
  async changes(query:{package?:string;version?:string;from_sequence?:number;to_sequence?:number;from_time?:string;to_time?:string;limit?:number}={}):Promise<any>{
    await this.init();if(query.package&&!NAME.test(query.package))throw new Error('Invalid package query');if(query.version&&!semver.valid(query.version))throw new Error('Invalid version query');
    const from=query.from_sequence??0,to=query.to_sequence??Number.MAX_SAFE_INTEGER,limit=Math.min(50000,Math.max(1,query.limit||1000));if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from)throw new Error('Invalid observation sequence range');
    for(const t of [query.from_time,query.to_time])if(t&&Number.isNaN(Date.parse(t)))throw new Error('Invalid saved observation time');
    const index=await this.index(),events=[];
    for(const item of Object.values(index.by_identity) as any[]){if(query.package&&item.package!==query.package||query.version&&item.version!==query.version)continue;for(const e of item.events)if(e.sequence>=from&&e.sequence<=to&&(!query.from_time||Date.parse(e.ended_at)>=Date.parse(query.from_time))&&(!query.to_time||Date.parse(e.ended_at)<=Date.parse(query.to_time)))events.push(e);}
    events.sort((a,b)=>a.sequence-b.sequence||a.package.localeCompare(b.package));return {semantics:'saved-successful-scan-observations',index_head:index.head,total:events.length,truncated:events.length>limit,events:events.slice(0,limit),limitation:'Changes between saved successful scans only; no strict historical filesystem timepoint is reconstructed.'};
  }
  private async saveJournal(j:Journal):Promise<void>{await atomic(path.join(this.state,'transfers',safeID(j.transfer.transfer_id)+'.json'),j);}
  async status():Promise<any>{const repo_id=await this.init();const dir=path.join(this.state,'transfers');const transfers=[];if(await exists(dir))for(const f of await fs.readdir(dir)){if(f.endsWith('.json')){const j=await json(path.join(dir,f));transfers.push({transfer_id:j.transfer.transfer_id,state:j.state,source_repo_id:j.transfer.source_repo_id,target_repo_id:j.transfer.target_repo_id,base_root:j.transfer.base_root,source_root:j.transfer.source_root,receipt:j.receipt,error:j.error});}}const base=path.join(this.state,'baselines.json');return {repo_id,scope_id:SCOPE,transfers,baselines:await exists(base)?await json(base):{},legacy_baseline:'untrusted-mtime-history; v2 requires full inventories',recovery:'Retry the same archive after interruption; a lost receipt can be downloaded again. Reconcile complete inventories after a broken chain.'};}
  async export(sourceID:string,target:Snapshot):Promise<any>{return this.locked(async()=>{
    const source=await this.snapshot(sourceID);if(source.repo_id!==await this.init())throw new Error('Snapshot repository mismatch');
    const plan=reconcile(source,target);if(plan.conflicts.length)throw new Error('Hash conflicts: export blocked; isolate and resolve conflicts first');
    const transfer_id=randomUUID(), union=[...target.artifacts,...plan.missing];
    for(const a of union)if(!source.metadata[a.package]?.versions?.[a.version]&&!target.metadata[a.package]?.versions?.[a.version])throw new Error(`Metadata missing for artifact ${key(a)}; recover metadata before transfer`);
    const t:Transfer={schema:SCHEMA,scope_id:SCOPE,transfer_id,source_repo_id:source.repo_id,target_repo_id:target.repo_id,base_root:target.root,source_root:source.root,expected_artifact_root:artifactRoot(union),source,target,files:plan.missing,metadata_adapter:'verdaccio-5-6-public-v1'};
    const manifestBytes=Buffer.byteLength(JSON.stringify(t,null,2));if(manifestBytes>this.options.maxJSONBytes)throw new Error('Transfer manifest size limit');
    const blobs=[...new Map(t.files.map(a=>[a.sha256,a])).values()];if(blobs.reduce((n,a)=>n+512+Math.ceil(a.size/512)*512,1536+Math.ceil(manifestBytes/512)*512)>this.options.maxBytes)throw new Error('Transfer expansion limit; use a narrower scope or raise both endpoints limits');
    const dir=path.join(this.state,'staging',transfer_id); await fs.mkdir(dir,{recursive:true});
    const j:Journal={transfer:t,state:'preparing'};await this.saveJournal(j);
    try{
      await this.options.hooks?.beforeStage?.();
      for(const a of t.files){validateArtifact(a);const blob=path.join(dir,'blobs',a.sha256);if(!await exists(blob)){const p=await this.sourcePath(a.aliases[0]);const h=await stableRead(p,blob);if(stable(h)!==stable({sha256:a.sha256,sha1:a.sha1,integrity:a.integrity,size:a.size}))throw new Error(`Snapshot drift: ${a.path}`);}await tarballIdentity(blob,a,this.options.maxBytes);}
      // Even unselected source artifacts and metadata must still match this saved observation.
      const current=await this.scanUnlocked();if(!current.complete || current.root!==source.root)throw new Error('Source inventory drifted since saved snapshot; rescan and reconcile');
      await atomic(path.join(dir,'.mirror-manifest.json'),t);
      const output=path.join(this.state,'archives');await fs.mkdir(output,{recursive:true});const archive=path.join(output,transfer_id+'.tar.gz'), temp=archive+'.tmp';
      await tar.create({file:temp,cwd:dir,gzip:true,portable:true,noMtime:true},['.mirror-manifest.json',...new Set(t.files.map(a=>'blobs/'+a.sha256))]);
      await fs.rename(temp,archive);j.state='exported-awaiting-receipt';await this.saveJournal(j);
      return {transfer_id,files:t.files.length,plan,archive,checksum:(await stableRead(archive)).sha256,baseline_advanced:false};
    }catch(e:any){j.state='export-failed';j.error=e.message;await this.saveJournal(j);throw e;}
    finally{await fs.rm(dir,{recursive:true,force:true});}
  });}
  private async sourcePath(relative:string):Promise<string>{const parts=safeRelative(relative).split('/');let p=this.storage;for(const part of parts){p=path.join(p,part);const s=await fs.lstat(p);if(s.isSymbolicLink())throw new Error('Source symlink');}return p;}
  archive(id:string):string{return path.join(this.state,'archives',safeID(id)+'.tar.gz');}
  /** Preflight a private stable archive before tar extraction; hardlinks and symlinks are forbidden. */
  private async extract(archive:string,dir:string):Promise<Transfer>{
    const seen=new Set<string>();let bytes=0,entries=0;
    const parser=new (tar as any).Parser({strict:true,gzip:false,brotli:false,zstd:false,maxMetaEntrySize:1024*1024,onReadEntry:(e:any)=>{
      try{
        const p=safeRelative(e.path);if(++entries>this.options.maxEntries||seen.has(p))throw new Error('Duplicate archive entry or entry limit');seen.add(p);
        if(e.type!=='File'||(!/^blobs\/[a-f0-9]{64}$/.test(p)&&p!=='.mirror-manifest.json')||e.linkpath)throw new Error('Unexpected archive entry type/path');
        if(!Number.isSafeInteger(e.size)||e.size<0||e.size>this.options.maxFileBytes||(p==='.mirror-manifest.json'&&e.size>this.options.maxJSONBytes))throw new Error('Archive file size limit');
        e.resume();
      }catch(err){parser.abort(err);}
    }});
    const cap=expansionCap(this.options.maxBytes);
    await pipeline(createReadStream(archive),createGunzip(),cap,parser);
    await tar.extract({file:archive,cwd:dir,strict:true,preservePaths:false,noChmod:true,noMtime:true});
    const t=await json(path.join(dir,'.mirror-manifest.json')) as Transfer;
    if(t.schema!==SCHEMA||t.scope_id!==SCOPE||t.metadata_adapter!=='verdaccio-5-6-public-v1')throw new Error('Unsupported transfer protocol');
    safeID(t.transfer_id);validateSnapshot(t.source);validateSnapshot(t.target);
    const plan=reconcile(t.source,t.target);
    if(plan.conflicts.length||t.source_repo_id!==t.source.repo_id||t.target_repo_id!==t.target.repo_id||t.base_root!==t.target.root||t.source_root!==t.source.root||stable(t.files)!==stable(plan.missing)||t.expected_artifact_root!==artifactRoot([...t.target.artifacts,...plan.missing]))throw new Error('Transfer chain/selection mismatch');
    const expected=new Set(['.mirror-manifest.json',...t.files.map(a=>'blobs/'+a.sha256)]);
    if(expected.size!==seen.size||[...seen].some(p=>!expected.has(p)))throw new Error('Archive contents do not match manifest');
    for(const a of t.files){const blob=path.join(dir,'blobs',a.sha256),h=await stableRead(blob);if(h.sha256!==a.sha256||h.sha1!==a.sha1||h.integrity!==a.integrity||h.size!==a.size)throw new Error(`Blob checksum mismatch: ${a.path}`);await tarballIdentity(blob,a,this.options.maxBytes);}
    return t;
  }
  async import(archive:string):Promise<Receipt>{return this.locked(async()=>{
    if((await fs.stat(archive)).size>this.options.maxBytes)throw new Error('Compressed archive size limit');
    const dir=path.join(this.state,'imports',randomUUID());await fs.mkdir(dir,{recursive:true});let j:Journal|undefined;
    try{
      const stableArchive=path.join(dir,'input.tar.gz');await stableRead(archive,stableArchive);const t=await this.extract(stableArchive,dir);
      if(t.target_repo_id!==await this.init())throw new Error('Wrong target repo_id; export against this repository inventory');
      const jp=path.join(this.state,'transfers',t.transfer_id+'.json');
      const prior:Journal|undefined=await exists(jp)?await json(jp):undefined;
      if(prior&&stable(prior.transfer)!==stable(t))throw new Error('transfer_id reused with different content');
      if(prior?.receipt){
        // A replay may repair lost metadata, but may never bless a changed artifact set.
        const observed=await this.scanUnlocked();
        if(!observed.complete||observed.artifact_root!==t.expected_artifact_root)throw new Error('Replay target artifacts changed; no receipt/baseline');
        await this.mergeMetadata(t);
        await this.options.onImported?.([...new Set([...t.target.artifacts,...t.files].map(a=>a.package))]);
        const after=await this.verifyExpected(t);
        if(after.root!==prior.receipt.target_root)throw new Error('Replay target metadata changed; exchange full inventories for a new receipt');
        return prior.receipt;
      }
      if(!prior){const before=await this.scanUnlocked();if(!before.complete||before.root!==t.base_root)throw new Error('Target chain changed; exchange full inventories and export again');}
      const observed=await this.scanUnlocked();if(!observed.complete)throw new Error('Incomplete target scan before apply');
      for(const a of t.files)if(observed.artifacts.some(b=>key(a)===key(b)&&a.sha256!==b.sha256)){
        const q=path.join(this.state,'conflicts',t.transfer_id,a.sha256);await fs.mkdir(path.dirname(q),{recursive:true});if(!await exists(q))await fs.copyFile(path.join(dir,'blobs',a.sha256),q);throw new Error(`Hash conflict quarantined; target preserved: ${key(a)}`);
      }
      j={transfer:t,state:'applying'};await this.saveJournal(j);
      // Atomic no-overwrite publication. Retry verifies already published bytes; target-only artifacts stay.
      for(const a of t.files){
        const dest=await safeParents(this.storage,a.path);
        if(await exists(dest)){const h=await stableRead(dest);if(h.sha256!==a.sha256) {const q=path.join(this.state,'conflicts',t.transfer_id,a.sha256);await fs.mkdir(path.dirname(q),{recursive:true});if(!await exists(q))await fs.copyFile(path.join(dir,'blobs',a.sha256),q);throw new Error(`Hash conflict quarantined; target preserved: ${a.path}`);}}
        else {await fs.link(path.join(dir,'blobs',a.sha256),dest);}
        await this.options.hooks?.afterArtifact?.();
      }
      await this.mergeMetadata(t);
      await this.options.onImported?.([...new Set([...t.target.artifacts,...t.files].map(a=>a.package))]);
      j.state='verifying';await this.saveJournal(j);
      const after=await this.verifyExpected(t);
      const body:any={schema:SCHEMA,scope_id:SCOPE,transfer_id:t.transfer_id,source_repo_id:t.source_repo_id,target_repo_id:t.target_repo_id,base_root:t.base_root,source_root:t.source_root,source_snapshot_seq:t.source.sequence,target_snapshot_seq:after.sequence,expected_artifact_root:t.expected_artifact_root,target_root:after.root,target_snapshot_id:after.snapshot_id,verified_at:(this.options.now?.()||new Date()).toISOString(),status:'verified'};
      const receipt:Receipt={...body,receipt_hash:digest(body)};
      j.state='verified-awaiting-ack';j.receipt=receipt;await this.saveJournal(j);return receipt;
    }catch(e:any){if(j){j.state='interrupted';j.error=e.message;await this.saveJournal(j);}throw e;}
    finally{await fs.rm(dir,{recursive:true,force:true});}
  });}
  private async mergeMetadata(t:Transfer):Promise<void>{
    const all=[...t.target.artifacts,...t.files];
    for(const name of new Set(all.map(a=>a.package))){
      const incoming=t.source.metadata[name]||t.target.metadata[name];if(!incoming)throw new Error(`Metadata missing: ${name}; recover package metadata before transfer`);
      const dest=await safeParents(this.storage,name+'/package.json');
      const aliasMetadata=new Set(all.filter(a=>a.package===name).flatMap(a=>a.aliases.map(p=>path.posix.dirname(p)+'/package.json')));
      let existing=await exists(dest)?dest:undefined;
      for(const rel of aliasMetadata)if(!existing&&await exists(path.join(this.storage,rel)))existing=await this.sourcePath(rel);
      const raw=existing?await json(existing):{name,versions:{},'dist-tags':{},_attachments:{},_distfiles:{},_uplinks:{},_rev:'0-0000000000000000',time:{}};
      const original=stable(raw); publicMetadata(raw,name);
      raw.time={...(incoming.time||{}),...(raw.time||{})};raw.versions={...raw.versions};raw['dist-tags']={...(incoming['dist-tags']||{}),...(raw['dist-tags']||{})};raw._attachments={...(raw._attachments||{})};raw._distfiles={...(raw._distfiles||{})};
      for(const a of all.filter(a=>a.package===name)){
        const sourceVersion=t.source.metadata[name]?.versions?.[a.version]||t.target.metadata[name]?.versions?.[a.version];
        let v=raw.versions[a.version]||sourceVersion;if(!v)throw new Error(`Metadata missing for artifact ${key(a)}`);
        // Fill absent installation fields while preserving target-owned values and extras.
        v=JSON.parse(JSON.stringify({...sourceVersion,...v}));
        const filename=path.posix.basename(a.aliases.find(p=>p===a.path)||a.aliases[0]||a.path);
        // New artifacts are always written to their canonical path; retained target artifacts keep their serving filename.
        const actual=t.files.some(f=>key(f)===key(a))?path.posix.basename(a.path):filename;
        const serving=await safeParents(this.storage,name+'/'+actual);
        if(!await exists(serving)){
          const retained=await this.sourcePath(a.aliases[0]);if((await stableRead(retained)).sha256!==a.sha256)throw new Error('Alias drift before canonical publication');await fs.link(retained,serving);
        }
        const url=`${(this.options.registryURL||'http://localhost:4873').replace(/\/$/,'')}/${name}/-/${actual}`;
        v.name=name;v.version=a.version;v.dist={tarball:url,shasum:a.sha1,integrity:a.integrity};raw.versions[a.version]=v;
        raw._attachments[actual]={...(raw._attachments[actual]||{}),shasum:a.sha1,version:a.version};raw._distfiles[actual]={url,sha:a.sha1};
      }
      raw['dist-tags']=Object.fromEntries(Object.entries(raw['dist-tags']).filter(([,v])=>typeof v==='string'&&raw.versions[v]));
      if(existing&&stable(await json(existing))!==original)throw new Error(`Target metadata concurrently changed: ${name}`);
      await atomic(dest,raw);
      for(const rel of aliasMetadata)if(rel!==name+'/package.json'&&await exists(path.join(this.storage,rel)))await atomic(await this.sourcePath(rel),raw);
    }
  }
  private async verifyExpected(t:Transfer):Promise<Snapshot>{
    const after=await this.scanUnlocked();if(!after.complete||after.artifact_root!==t.expected_artifact_root)throw new Error('Post-import union verification failed; no receipt/baseline');
    for(const a of [...t.target.artifacts,...t.files]){const m=await json(await this.sourcePath(a.package+'/package.json'));const v=m.versions?.[a.version];if(!v||v.dist?.shasum!==a.sha1||v.dist?.integrity!==a.integrity)throw new Error(`Metadata integrity verification failed: ${key(a)}`);const basename=path.posix.basename(new URL(v.dist.tarball).pathname);const h=await stableRead(await this.sourcePath(a.package+'/'+basename));if(h.sha256!==a.sha256)throw new Error(`Metadata download path verification failed: ${key(a)}`);}
    return after;
  }
  async acceptReceipt(receipt:Receipt):Promise<any>{return this.locked(async()=>{
    const {receipt_hash,...body}=receipt;if(digest(body)!==receipt_hash||receipt.status!=='verified')throw new Error('Invalid verification receipt');
    const j:Journal=await json(path.join(this.state,'transfers',safeID(receipt.transfer_id)+'.json')), t=j.transfer;
    if(t.source_repo_id!==await this.init()||!['exported-awaiting-receipt','acknowledged'].includes(j.state))throw new Error('Receipt does not reference a successful local export');
    for(const field of ['scope_id','transfer_id','source_repo_id','target_repo_id','base_root','source_root','expected_artifact_root'] as const)if(receipt[field]!==t[field])throw new Error(`Receipt chain mismatch: ${field}`);
    if(!HEX.test(receipt.target_root))throw new Error('Invalid verified target root');
    if(j.receipt&&j.receipt.receipt_hash!==receipt.receipt_hash)throw new Error('Different receipt already accepted');
    if(receipt.source_snapshot_seq!==t.source.sequence||!Number.isSafeInteger(receipt.target_snapshot_seq)||receipt.target_snapshot_seq<1)throw new Error('Receipt observation sequence mismatch');
    const advanced=j.state==='acknowledged'?false:await this.baseline(t.target_repo_id,receipt);
    j.state='acknowledged';j.receipt=receipt;await this.saveJournal(j);
    return {schema:SCHEMA,scope_id:SCOPE,transfer_id:t.transfer_id,receipt_hash:receipt.receipt_hash,source_repo_id:t.source_repo_id,target_repo_id:t.target_repo_id,status:'receipt-accepted',baseline_advanced:advanced};
  });}
  async acceptAck(ack:any):Promise<any>{return this.locked(async()=>{
    const j:Journal=await json(path.join(this.state,'transfers',safeID(ack.transfer_id)+'.json'));
    if(!j.receipt||ack.schema!==SCHEMA||ack.scope_id!==SCOPE||ack.target_repo_id!==await this.init()||ack.target_repo_id!==j.transfer.target_repo_id||ack.source_repo_id!==j.transfer.source_repo_id||ack.receipt_hash!==j.receipt.receipt_hash||ack.status!=='receipt-accepted')throw new Error('Acknowledgment chain mismatch');
    const advanced=j.state==='acknowledged'?false:await this.baseline(j.transfer.source_repo_id,j.receipt);j.state='acknowledged';await this.saveJournal(j);return {status:'acknowledged',baseline_advanced:advanced};
  });}
  private async baseline(peer:string,receipt:Receipt):Promise<boolean>{
    const p=path.join(this.state,'baselines.json'),b=await exists(p)?await json(p):{},self=await this.init(),isSource=self===receipt.source_repo_id;
    const next={local_root:isSource?receipt.source_root:receipt.target_root,peer_root:isSource?receipt.target_root:receipt.source_root,local_sequence:isSource?receipt.source_snapshot_seq:receipt.target_snapshot_seq,peer_sequence:isSource?receipt.target_snapshot_seq:receipt.source_snapshot_seq};
    const old=b[peer];if(old?.receipt_hash===receipt.receipt_hash)return false;
    if(old){for(const side of ['local','peer']){const root=side+'_root',seq=side+'_sequence';if(old[root]!==next[root as keyof typeof next]&&old[seq]>next[seq as keyof typeof next])return false;}}
    b[peer]={...next,local_sequence:Math.max(old?.local_sequence||0,next.local_sequence),peer_sequence:Math.max(old?.peer_sequence||0,next.peer_sequence),receipt_hash:receipt.receipt_hash,transfer_id:receipt.transfer_id,source_root:receipt.source_root,target_root:receipt.target_root,scope_id:SCOPE,verified_at:receipt.verified_at};await atomic(p,b);return true;
  }
}

/** v1 compatibility: preflight the whole stable archive, then extract only bounded regular files. */
export async function extractLegacyArchive(archive:string,dir:string,limits:Partial<MirrorOptions>={}):Promise<any>{
  const maxBytes=limits.maxBytes||20*1024**3,maxEntries=limits.maxEntries||500000,maxFileBytes=limits.maxFileBytes||2*1024**3;
  if((await fs.stat(archive)).size>maxBytes)throw new Error('Legacy compressed archive size limit');
  const privateArchive=path.join(dir,'.validated-input.tar.gz');await stableRead(archive,privateArchive);
  const seen=new Set<string>(),files=new Set<string>();let bytes=0,entries=0;
  const normalize=(p:string):string=>p.replace(/^(\.\/)+/,'').replace(/\/$/,'');
  const parser=new (tar as any).Parser({strict:true,gzip:false,brotli:false,zstd:false,maxMetaEntrySize:1024*1024,onReadEntry:(e:any)=>{
    try{
      const p=normalize(e.path);
      if(++entries>maxEntries)throw new Error('Legacy archive entry limit');
      if(p===''&&e.type==='Directory'){e.resume();return;}
      safeRelative(p);const n=p.replace(/%2f/gi,'/');
      if(e.type==='Directory'){if(!NAME.test(n)&&!(n.startsWith('@')&&!n.includes('/')))throw new Error('Unexpected legacy directory');e.resume();return;}
      if(e.type!=='File'||e.linkpath)throw new Error('Legacy archive links/nonregular files forbidden');
      if(seen.has(n))throw new Error('Duplicate/conflicting legacy archive path');seen.add(n);
      if(!Number.isSafeInteger(e.size)||e.size<0||e.size>maxFileBytes)throw new Error('Legacy file size limit');
      if(p!=='.export-manifest.json'){
        if(!NAME.test(path.posix.dirname(n))||!(p.endsWith('.tgz')||path.posix.basename(p)==='package.json'))throw new Error('Unexpected legacy archive file');
        files.add(p);
      }else if(e.size>(limits.maxJSONBytes||64*1024**2))throw new Error('Legacy manifest size limit');
      e.resume();
    }catch(err){parser.abort(err);}
  }});
  const cap=expansionCap(maxBytes);
  await pipeline(createReadStream(privateArchive),createGunzip(),cap,parser);
  if(!seen.has('.export-manifest.json'))throw new Error('Legacy manifest missing');
  await tar.extract({file:privateArchive,cwd:dir,strict:true,preservePaths:false,noChmod:true,noMtime:true});
  const m=await json(path.join(dir,'.export-manifest.json'));
  if(m.version!==1||!Array.isArray(m.files)||m.files.length>maxEntries||!m.stats||typeof m.exportId!=='string')throw new Error('Unsupported legacy manifest; expected v1');
  const manifestPaths=new Set<string>();
  for(const f of m.files){
    const p=safeRelative(f.path),n=p.replace(/%2f/gi,'/');
    if(manifestPaths.has(n)||!files.has(p)||!NAME.test(path.posix.dirname(n))||!HEX.test(f.checksum)||!Number.isSafeInteger(f.size)||f.size<0||f.packageName!==path.posix.dirname(n)||!['metadata','tarball'].includes(f.type)||(f.type==='metadata'?path.posix.basename(n)!=='package.json':!n.endsWith('.tgz')))throw new Error('Invalid/conflicting legacy manifest entry');
    manifestPaths.add(n);const h=await stableRead(path.join(dir,p));if(h.sha256!==f.checksum||h.size!==f.size)throw new Error(`Legacy checksum/size mismatch: ${p}`);
    if(f.type==='metadata')publicMetadata(await json(path.join(dir,p)),f.packageName);
  }
  if(manifestPaths.size!==files.size)throw new Error('Unlisted legacy archive content');
  return m;
}

/** Imported business metadata never replaces local private versions, local identity or tags. */
export async function mergeLegacyMetadata(source:string,dest:string,name:string):Promise<void>{
  const incoming=legacyPublicMetadata(await json(source),name);
  let local:any={name,versions:{},'dist-tags':{},_rev:'0-0000000000000000',_attachments:{},_distfiles:{},_uplinks:{},time:{}};
  if(await exists(dest))local=await json(dest);
  publicMetadata(local,name);
  local.versions={...incoming.versions,...local.versions};
  local['dist-tags']={...incoming['dist-tags'],...local['dist-tags']};
  local.time={...incoming.time,...local.time};
  await atomic(dest,local);
}

export async function safeLegacyDestination(root:string,relative:string):Promise<string>{return safeParents(path.resolve(root),relative.replace(/%2f/gi,'/'));}

export function legacyPublicMetadata(raw:any,name:string):any{
  const clean=publicMetadata(raw,name);
  for(const [version,v] of Object.entries(clean.versions) as [string,any][]){
    const d=raw.versions[version]?.dist;if(!d?.tarball)continue;
    try{const u=new URL(d.tarball);if(!['http:','https:'].includes(u.protocol))continue;v.dist={tarball:u.origin+u.pathname};if(/^[a-f0-9]{40}$/i.test(d.shasum||''))v.dist.shasum=d.shasum;if(/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(d.integrity||''))v.dist.integrity=d.integrity;}catch{ /* unusable incoming URLs are not persisted */ }
  }
  return clean;
}
export async function finalizeLegacyMetadata(root:string,names:string[],registryURL='http://localhost:4873'):Promise<void>{
  for(const name of names){
    const dest=await safeParents(root,name+'/package.json');if(!await exists(dest))continue;
    const raw=await json(dest);publicMetadata(raw,name);raw._attachments={...raw._attachments};raw._distfiles={...raw._distfiles};
    for(const file of await fs.readdir(path.dirname(dest))){
      if(!file.endsWith('.tgz'))continue;const base=file.slice(0,-4);let version:string|undefined;
      for(let i=base.lastIndexOf('-');i>=0;i=base.lastIndexOf('-',i-1)){if(semver.valid(base.slice(i+1))){version=base.slice(i+1);break;}if(i===0)break;}
      if(!version||!raw.versions[version])continue;
      const h=await stableRead(await safeParents(root,name+'/'+file)),url=registryURL.replace(/\/$/,'')+'/'+name+'/-/'+file;
      raw.versions[version].dist={tarball:url,shasum:h.sha1,integrity:h.integrity};raw._attachments[file]={...(raw._attachments[file]||{}),shasum:h.sha1,version};raw._distfiles[file]={url,sha:h.sha1};
    }
    await atomic(dest,raw);
  }
}
export async function restoreLegacyTags(root:string,name:string,tags:any):Promise<void>{const dest=await safeParents(root,name+'/package.json');if(!await exists(dest))return;const m=await json(dest);m['dist-tags']={...m['dist-tags'],...tags};await atomic(dest,m);}

export async function preflightLegacyConflicts(root:string,manifest:any):Promise<void>{
  const version=(file:string):string|undefined=>{const base=path.posix.basename(file).slice(0,-4);for(let i=base.lastIndexOf('-');i>=0;i=base.lastIndexOf('-',i-1)){if(semver.valid(base.slice(i+1)))return base.slice(i+1);if(i===0)break;}return undefined;};
  const incoming=new Map<string,any>();
  for(const f of manifest.files.filter((f:any)=>f.type==='tarball')){const v=version(f.path);if(!v||f.version&&f.version!==v)throw new Error('Invalid legacy tarball version identity');const k=f.packageName+'@'+v;if(incoming.has(k)&&incoming.get(k).checksum!==f.checksum)throw new Error('Same-version hash conflict inside legacy archive');incoming.set(k,{...f,version:v});}
  const top=await fs.readdir(root);
  for(const name of new Set([...incoming.values()].map(f=>f.packageName)) as Set<string>){
    const dirs=new Set([name,...top.filter(p=>p.replace(/%2f/gi,'/')===name)]);
    for(const rel of dirs){const dir=path.join(root,rel);if(!await exists(dir))continue;const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Symlink/non-directory legacy destination');
      for(const file of await fs.readdir(dir)){if(!file.endsWith('.tgz'))continue;const v=version(file),f=incoming.get(name+'@'+v);if(!f)continue;const h=await stableRead(path.join(dir,file));if(h.sha256!==f.checksum)throw new Error(`Same-version hash conflict across aliases; target preserved: ${name}@${v}`);}
    }
  }
}

/** Known Verdaccio 5/6 package-storage adapters; never fall back to silent direct persistence. */
export async function persistVerdaccioMetadata(storage:any,name:string,raw:any):Promise<void>{
  const local=storage?.localStorage,ps=typeof local?._getLocalStorage==='function'?local._getLocalStorage(name):undefined;
  if(typeof ps?.upsertPackage==='function')await new Promise<void>((resolve,reject)=>ps.upsertPackage(name,raw,(e:any)=>e?reject(e):resolve()));
  else if(typeof local?._updatePackage==='function'){
    const update=()=>new Promise<void>((resolve,reject)=>local._updatePackage(name,(current:any,done:(e?:any)=>void)=>{
      try{const versions={...current.versions};for(const [v,value]of Object.entries(raw.versions||{}) as [string,any][])versions[v]={...value,...versions[v],dist:value.dist||versions[v]?.dist,...(value.hasInstallScript!==undefined?{hasInstallScript:value.hasInstallScript}:{})};const merged={...current,...raw,versions,'dist-tags':{...raw['dist-tags'],...current['dist-tags']},time:{...current.time,...raw.time},_attachments:{...current._attachments,...raw._attachments},_distfiles:{...current._distfiles,...raw._distfiles},_uplinks:current._uplinks||{},_rev:current._rev,_id:current._id};Object.assign(current,merged);done();}catch(e){done(e);}
    },(e:any)=>e?reject(e):resolve()));
    try{await update();}catch(e:any){
      if(![404,'ENOENT'].includes(e.code)&&e.status!==404&&e.statusCode!==404)throw e;
      if(typeof ps?.createPackage!=='function')throw new Error(`Package storage for ${name} cannot create a missing package safely`);
      const initial={_rev:'0-0000000000000000',_id:name,_uplinks:{},_attachments:{},_distfiles:{},time:{},...raw};
      try{await new Promise<void>((resolve,reject)=>ps.createPackage(name,initial,(err:any)=>err?reject(err):resolve()));}catch(createError:any){if(![409,'EEXIST'].includes(createError.code)&&createError.status!==409&&createError.statusCode!==409)throw createError;await update();}
    }
  }
  else throw new Error(`Package storage for ${name} does not support upsertPackage or a known Verdaccio update adapter`);
}
