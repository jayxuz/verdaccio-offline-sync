// Canonical source: scripts/mirror-core.ts. Run scripts/update-mirror-core.mjs after editing.
// Mirrored into both independently distributable plugins; no extra runtime dependency.
import { constants, createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import tar from 'tar';
import semver from 'semver';

export const SCOPE = 'verdaccio-artifacts-v2';
const SCHEMA = 2;
const HEX = /^[a-f0-9]{64}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const VERSION_FIELDS = ['name','version','description','main','module','types','typings','bin','files','exports','imports','browser','scripts','dependencies','devDependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','bundleDependencies','bundledDependencies','engines','os','cpu','libc','repository','keywords','author','license','bugs','homepage','deprecated','funding'];
export type Artifact = { package: string; version: string; path: string; sha256: string; sha1: string; integrity: string; size: number; aliases: string[] };
export type Snapshot = { schema: number; repo_id: string; scope_id: string; snapshot_id: string; started_at: string; ended_at: string; semantics: string; complete: boolean; errors: string[]; artifacts: Artifact[]; metadata: Record<string, any>; metadata_missing_artifacts: string[]; root: string; artifact_root: string };
export type Transfer = { schema: number; scope_id: string; transfer_id: string; source_repo_id: string; target_repo_id: string; base_root: string; source_root: string; expected_artifact_root: string; source: Snapshot; target: Snapshot; files: Artifact[]; metadata_adapter: string };
export type Receipt = { schema: number; scope_id: string; transfer_id: string; source_repo_id: string; target_repo_id: string; base_root: string; source_root: string; expected_artifact_root: string; target_root: string; target_snapshot_id: string; verified_at: string; status: string; receipt_hash: string };
type Journal = { transfer: Transfer; state: string; receipt?: Receipt; error?: string };
export type MirrorOptions = { registryURL?: string; maxBytes?: number; maxEntries?: number; maxFileBytes?: number; maxJSONBytes?: number; onImported?: (names:string[])=>Promise<void>; hooks?: { afterWalk?: () => Promise<void>; beforeStage?: () => Promise<void>; afterArtifact?: () => Promise<void> } };

export function stable(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
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
    p = path.join(p, part);
    try { await fs.mkdir(p); } catch(e: any) { if(e.code !== 'EEXIST') throw e; }
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
  return { name, versions, 'dist-tags': tags };
}
async function tarballIdentity(file:string,artifact:Artifact,maxBytes:number):Promise<void>{
  let found:any, count=0;
  const parser=new (tar as any).Parse({strict:true,brotli:false,maxMetaEntrySize:1024*1024,onentry:(e:any)=>{
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
  if(!s || s.schema !== SCHEMA || s.scope_id !== SCOPE || !s.complete || s.errors?.length || !Array.isArray(s.artifacts) || !HEX.test(s.root) || !HEX.test(s.artifact_root)) throw new Error('Incomplete, legacy or unsupported inventory; run a full v2 scan');
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
  }
  async init(): Promise<string> {
    const s = await fs.lstat(this.storage); if(!s.isDirectory() || s.isSymbolicLink()) throw new Error('Storage root must be a real directory');
    await fs.mkdir(this.state,{recursive:true}); if((await fs.lstat(this.state)).isSymbolicLink()) throw new Error('Unsafe mirror state directory');
    const file = path.join(this.state,'repository.json');
    if(!await exists(file)) { try { const f=await fs.open(file,'wx',0o600); try{await f.writeFile(JSON.stringify({schema:SCHEMA,repo_id:randomUUID(),scope_id:SCOPE})); await f.sync();} finally{await f.close();} }catch(e:any){if(e.code!=='EEXIST')throw e;} }
    const id=await json(file); safeID(id.repo_id); if(id.scope_id!==SCOPE)throw new Error('Unsupported repository scope'); return id.repo_id;
  }
  private async locked<T>(action:()=>Promise<T>):Promise<T> {
    await this.init(); const lock=path.join(this.state,'writer.lock');
    let f;
    try { f=await fs.open(lock,'wx',0o600); } catch(e:any) {
      if(e.code!=='EEXIST') throw e;
      const owner=await json(lock); let alive=true; try { process.kill(owner.pid,0); } catch(err:any) { if(err.code==='ESRCH') alive=false; else throw err; }
      if(alive)throw new Error('Mirror operation already running');
      await fs.unlink(lock); f=await fs.open(lock,'wx',0o600);
    }
    try { await f.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})); await f.sync(); return await action(); }
    finally { await f.close(); await fs.unlink(lock); }
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
        else if(s.isFile() && (e.name.endsWith('.tgz')||e.name==='package.json')) { found.set(rel,fingerprint(s)); if(found.size>this.options.maxEntries)throw new Error('Inventory entry limit'); }
      }
    };
    await visit(''); return found;
  }
  /** A verified scan interval, never an instantaneous filesystem snapshot. Rehash every artifact. */
  async scan():Promise<Snapshot> { return this.locked(()=>this.scanUnlocked()); }
  private async scanUnlocked():Promise<Snapshot> {
    const repo_id=await this.init(), started_at=new Date().toISOString();
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
    const s:Snapshot={schema:SCHEMA,repo_id,scope_id:SCOPE,snapshot_id:randomUUID(),started_at,ended_at:new Date().toISOString(),semantics:'verified-scan-interval',complete:errors.length===0,errors,artifacts,metadata,metadata_missing_artifacts:missing.sort(),root:'',artifact_root:artifactRoot(artifacts)};
    s.root=digest(semantic(s));
    await atomic(path.join(this.state,'snapshots',s.snapshot_id+'.json'),s);
    if(s.complete)await atomic(path.join(this.state,'index.json'),{schema:SCHEMA,snapshot_id:s.snapshot_id,root:s.root,artifact_root:s.artifact_root});
    return s;
  }
  async snapshots():Promise<any[]> {await this.init();const dir=path.join(this.state,'snapshots');if(!await exists(dir))return[]; const out=[];for(const f of await fs.readdir(dir)){if(!f.endsWith('.json'))continue;const s=await json(path.join(dir,f));out.push({snapshot_id:s.snapshot_id,started_at:s.started_at,ended_at:s.ended_at,complete:s.complete,root:s.root,files:s.artifacts.length,errors:s.errors});}return out.sort((a,b)=>b.ended_at.localeCompare(a.ended_at));}
  async snapshot(id:string):Promise<Snapshot>{await this.init();return json(path.join(this.state,'snapshots',safeID(id)+'.json'));}
  private async saveJournal(j:Journal):Promise<void>{await atomic(path.join(this.state,'transfers',safeID(j.transfer.transfer_id)+'.json'),j);}
  async status():Promise<any>{const repo_id=await this.init();const dir=path.join(this.state,'transfers');const transfers=[];if(await exists(dir))for(const f of await fs.readdir(dir)){if(f.endsWith('.json')){const j=await json(path.join(dir,f));transfers.push({transfer_id:j.transfer.transfer_id,state:j.state,source_repo_id:j.transfer.source_repo_id,target_repo_id:j.transfer.target_repo_id,base_root:j.transfer.base_root,source_root:j.transfer.source_root,receipt:j.receipt,error:j.error});}}const base=path.join(this.state,'baselines.json');return {repo_id,scope_id:SCOPE,transfers,baselines:await exists(base)?await json(base):{},legacy_baseline:'untrusted-mtime-history; v2 requires full inventories',recovery:'Retry the same archive after interruption; a lost receipt can be downloaded again. Reconcile complete inventories after a broken chain.'};}
  async export(sourceID:string,target:Snapshot):Promise<any>{return this.locked(async()=>{
    const source=await this.snapshot(sourceID);if(source.repo_id!==await this.init())throw new Error('Snapshot repository mismatch');
    const plan=reconcile(source,target);if(plan.conflicts.length)throw new Error('Hash conflicts: export blocked; isolate and resolve conflicts first');
    const transfer_id=randomUUID(), union=[...target.artifacts,...plan.missing];
    for(const a of union)if(!source.metadata[a.package]?.versions?.[a.version]&&!target.metadata[a.package]?.versions?.[a.version])throw new Error(`Metadata missing for artifact ${key(a)}; recover metadata before transfer`);
    const t:Transfer={schema:SCHEMA,scope_id:SCOPE,transfer_id,source_repo_id:source.repo_id,target_repo_id:target.repo_id,base_root:target.root,source_root:source.root,expected_artifact_root:artifactRoot(union),source,target,files:plan.missing,metadata_adapter:'verdaccio-5-6-public-v1'};
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
    const parser=new (tar as any).Parse({strict:true,brotli:false,maxMetaEntrySize:1024*1024,onentry:(e:any)=>{
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
    const dir=path.join(this.state,'imports',randomUUID());await fs.mkdir(dir,{recursive:true});let j:Journal|undefined;
    try{
      const stableArchive=path.join(dir,'input.tar.gz');await stableRead(archive,stableArchive);const t=await this.extract(stableArchive,dir);
      if(t.target_repo_id!==await this.init())throw new Error('Wrong target repo_id; export against this repository inventory');
      const jp=path.join(this.state,'transfers',t.transfer_id+'.json');
      const prior:Journal|undefined=await exists(jp)?await json(jp):undefined;
      if(prior&&stable(prior.transfer)!==stable(t))throw new Error('transfer_id reused with different content');
      if(prior?.receipt){await this.verifyExpected(t);return prior.receipt;}
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
      const body:any={schema:SCHEMA,scope_id:SCOPE,transfer_id:t.transfer_id,source_repo_id:t.source_repo_id,target_repo_id:t.target_repo_id,base_root:t.base_root,source_root:t.source_root,expected_artifact_root:t.expected_artifact_root,target_root:after.root,target_snapshot_id:after.snapshot_id,verified_at:new Date().toISOString(),status:'verified'};
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
      raw.versions={...raw.versions};raw['dist-tags']={...(incoming['dist-tags']||{}),...(raw['dist-tags']||{})};raw._attachments={...(raw._attachments||{})};raw._distfiles={...(raw._distfiles||{})};
      for(const a of all.filter(a=>a.package===name)){
        let v=raw.versions[a.version]||incoming.versions[a.version];if(!v)throw new Error(`Metadata missing for artifact ${key(a)}`);
        v=JSON.parse(JSON.stringify(v));
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
    j.state='acknowledged';j.receipt=receipt;await this.saveJournal(j);
    await this.baseline(t.target_repo_id,receipt);
    return {schema:SCHEMA,scope_id:SCOPE,transfer_id:t.transfer_id,receipt_hash:receipt.receipt_hash,source_repo_id:t.source_repo_id,target_repo_id:t.target_repo_id,status:'receipt-accepted'};
  });}
  async acceptAck(ack:any):Promise<any>{return this.locked(async()=>{
    const j:Journal=await json(path.join(this.state,'transfers',safeID(ack.transfer_id)+'.json'));
    if(!j.receipt||ack.schema!==SCHEMA||ack.scope_id!==SCOPE||ack.target_repo_id!==await this.init()||ack.target_repo_id!==j.transfer.target_repo_id||ack.source_repo_id!==j.transfer.source_repo_id||ack.receipt_hash!==j.receipt.receipt_hash||ack.status!=='receipt-accepted')throw new Error('Acknowledgment chain mismatch');
    j.state='acknowledged';await this.saveJournal(j);await this.baseline(j.transfer.source_repo_id,j.receipt);return {status:'acknowledged',baseline_advanced:true};
  });}
  private async baseline(peer:string,receipt:Receipt):Promise<void>{const p=path.join(this.state,'baselines.json'), b=await exists(p)?await json(p):{};if(b[peer]?.verified_at>receipt.verified_at)return;b[peer]={receipt_hash:receipt.receipt_hash,transfer_id:receipt.transfer_id,source_root:receipt.source_root,target_root:receipt.target_root,scope_id:SCOPE,verified_at:receipt.verified_at};await atomic(p,b);}
}

/** v1 compatibility: preflight the whole stable archive, then extract only bounded regular files. */
export async function extractLegacyArchive(archive:string,dir:string,limits:Partial<MirrorOptions>={}):Promise<any>{
  const maxBytes=limits.maxBytes||20*1024**3,maxEntries=limits.maxEntries||500000,maxFileBytes=limits.maxFileBytes||2*1024**3;
  const privateArchive=path.join(dir,'.validated-input.tar.gz');await stableRead(archive,privateArchive);
  const seen=new Set<string>(),files=new Set<string>();let bytes=0,entries=0;
  const normalize=(p:string):string=>p.replace(/^(\.\/)+/,'').replace(/\/$/,'');
  const parser=new (tar as any).Parse({strict:true,brotli:false,maxMetaEntrySize:1024*1024,onentry:(e:any)=>{
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
  }
  if(manifestPaths.size!==files.size)throw new Error('Unlisted legacy archive content');
  return m;
}

/** Imported business metadata never replaces local private versions, local identity or tags. */
export async function mergeLegacyMetadata(source:string,dest:string,name:string):Promise<void>{
  const incoming=publicMetadata(await json(source),name);
  let local:any={name,versions:{},'dist-tags':{},_rev:'0-0000000000000000',_attachments:{},_distfiles:{},_uplinks:{},time:{}};
  if(await exists(dest))local=await json(dest);
  publicMetadata(local,name);
  local.versions={...incoming.versions,...local.versions};
  local['dist-tags']={...incoming['dist-tags'],...local['dist-tags']};
  await atomic(dest,local);
}

export async function safeLegacyDestination(root:string,relative:string):Promise<string>{return safeParents(path.resolve(root),relative.replace(/%2f/gi,'/'));}
