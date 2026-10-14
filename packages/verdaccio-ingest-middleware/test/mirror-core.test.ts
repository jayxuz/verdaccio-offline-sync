import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar';
import express from 'express';
import { MirrorRepository, reconcile, stableRead } from '../src/mirror-core';
import { mirrorRouter, mirrorHTML } from '../src/mirror-router';

const roots:string[]=[];
afterEach(async()=>{for(const r of roots.splice(0))await fs.rm(r,{recursive:true,force:true});});
async function root(){const r=await fs.mkdtemp(path.join(os.tmpdir(),'verdaccio-mirror-test-'));roots.push(r);return r;}
async function fixture(storage:string,name='demo',version='1.0.0',content='hello',filename?:string){
  const source=await root();await fs.mkdir(path.join(source,'package'));await fs.writeFile(path.join(source,'package/package.json'),JSON.stringify({name,version,description:content}));await fs.writeFile(path.join(source,'package/index.js'),content);
  const dir=path.join(storage,name);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,filename||`${name.split('/').pop()}-${version}.tgz`);
  await tar.create({file,gzip:true,cwd:source,portable:true,noMtime:true},['package']);
  let m:any={name,versions:{},'dist-tags':{},_rev:'1-local',_attachments:{},_distfiles:{},_uplinks:{secret:{token:'do-not-export'}},private_local_marker:'keep-me'};
  try{m=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  m.versions[version]={name,version,description:content,dependencies:{},dist:{tarball:'https://old.invalid/'+name+'.tgz',shasum:'old'},_npmUser:{name:'secret-user'}};m['dist-tags'].latest=version;
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify(m));return file;
}
async function pair(){const a=await root(),b=await root();return {a,b,A:new MirrorRepository(a),B:new MirrorRepository(b)};}
async function transfer(A:MirrorRepository,B:MirrorRepository){const s=await A.scan(),t=await B.scan();return A.export(s.snapshot_id,t);}

test('complete additive chain, private target versions, receipts, reverse export and HTTP paths',async()=>{
  const {a,b,A,B}=await pair();await fixture(a,'demo','1.0.0');await fixture(b,'demo','2.0.0','private');await fixture(b,'internal','3.0.0');
  const s=await A.scan(),t=await B.scan();const p=reconcile(s,t);assert.equal(p.missing.length,1);assert.equal(p.target_only.length,2);
  assert(!JSON.stringify(s).includes('secret-user'));assert(!JSON.stringify(s).includes('do-not-export'));
  const e=await A.export(s.snapshot_id,t);assert.deepEqual((await A.status()).baselines,{});
  const r=await B.import(e.archive);assert.equal(r.status,'verified');assert.deepEqual((await B.status()).baselines,{});
  assert.deepEqual(await B.import(e.archive),r); // replay/lost receipt
  const m=JSON.parse(await fs.readFile(path.join(b,'demo/package.json'),'utf8'));assert.equal(m.private_local_marker,'keep-me');assert(m.versions['1.0.0']);assert(m.versions['2.0.0']);
  const ack=await A.acceptReceipt(r);assert((await A.status()).baselines[t.repo_id]);await B.acceptAck(ack);assert((await B.status()).baselines[s.repo_id]);
  await assert.rejects(A.acceptReceipt({...r,target_repo_id:'another-target'}),/Invalid|mismatch/);
  const back=await transfer(B,A);assert.equal(back.files,2);const rr=await A.import(back.archive);await B.acceptReceipt(rr);assert.equal((await A.scan()).artifact_root,(await B.scan()).artifact_root);
});

test('old/equal mtimes and preserved-mtime content changes are selected by hashes',async()=>{
  const {a,A,B}=await pair();const file=await fixture(a);const old=new Date('2000-01-01');await fs.utimes(file,old,old);
  const first=await A.scan();const e=await A.export(first.snapshot_id,await B.scan());await B.import(e.archive);
  assert.equal(reconcile(await A.scan(),await B.scan()).missing.length,0);
  await fixture(a,'demo','1.0.0','changed');await fs.utimes(file,old,old);
  const next=await A.scan();assert.notEqual(first.artifact_root,next.artifact_root);assert.equal(reconcile(next,await B.scan()).conflicts.length,1);
});

test('same-version equal-size different hashes conflict; path aliases compare only by hash',async()=>{
  const {a,b,A,B}=await pair();const source=await fixture(a,'@s/demo','1.2.3','same');await fixture(b,'@s/demo','1.2.3','same','scope-demo-1.2.3.tgz');
  await fs.copyFile(source,path.join(b,'@s/demo/scope-demo-1.2.3.tgz'));
  const p=reconcile(await A.scan(),await B.scan());assert.equal(p.missing.length,0);assert.equal(p.aliases.length,1);
  await fs.copyFile(source,path.join(a,'@s/demo/another-1.2.3.tgz'));const q=reconcile(await A.scan(),await B.scan());assert.equal(q.cleanup.dry_run,true);assert.equal(q.cleanup.candidates.length,1);
  const blob=await fs.readFile(source);blob[4]^=1;await fs.writeFile(path.join(b,'@s/demo/scope-demo-1.2.3.tgz'),blob);
  const ss=await A.scan(),tt=await B.scan();assert.equal(reconcile(ss,tt).conflicts.length,1);await assert.rejects(A.export(ss.snapshot_id,tt),/conflicts/);
});

test('encoded scoped directory aliases normalize without size-only equivalence',async()=>{
  const {a,b,A,B}=await pair();const p=await fixture(a,'@s/demo');await fixture(b,'@s/demo');await fs.copyFile(p,path.join(b,'@s/demo/demo-1.0.0.tgz'));await fs.rename(path.join(a,'@s/demo'),path.join(a,'@s%2fdemo'));await fs.rmdir(path.join(a,'@s'));
  const s=await A.scan();assert.equal(s.complete,true);assert.equal(s.artifacts[0].package,'@s/demo');assert.equal(reconcile(s,await B.scan()).missing.length,0);
});

test('metadata-only versions are diagnostics, never claimed as stored tgz',async()=>{
  const {a,A,B}=await pair();await fixture(a);const mpath=path.join(a,'demo/package.json'),m=JSON.parse(await fs.readFile(mpath,'utf8'));m.versions['9.0.0']={name:'demo',version:'9.0.0'};await fs.writeFile(mpath,JSON.stringify(m));const s=await A.scan();assert.deepEqual(s.metadata_missing_artifacts,['demo@9.0.0']);assert.equal(reconcile(s,await B.scan()).missing.length,1);
});

test('concurrent additions/source change create incomplete observation and do not advance index',async()=>{
  const a=await root();await fixture(a);const normal=new MirrorRepository(a);const before=await normal.scan();const A=new MirrorRepository(a,{hooks:{afterWalk:async()=>{await fixture(a,'new-package');}}});const s=await A.scan();assert.equal(s.complete,false);assert.match(s.errors[0],/changed/);const idx=JSON.parse(await fs.readFile(path.join(A.state,'index.json'),'utf8'));assert.equal(idx.snapshot_id,before.snapshot_id);
});

test('unreadable directories and symlinks cannot mark a full scan successful',async()=>{
  const a=await root();await fixture(a);await fs.mkdir(path.join(a,'blocked'));await fs.chmod(path.join(a,'blocked'),0);try{assert.equal((await new MirrorRepository(a).scan()).complete,false);}finally{await fs.chmod(path.join(a,'blocked'),0o700);}
  await fs.symlink(path.join(a,'demo'),path.join(a,'linked'));assert.equal((await new MirrorRepository(a).scan()).complete,false);
});

test('stale/corrupt index is rebuilt; missing stored files and changed snapshots are detected',async()=>{
  const {a,A,B}=await pair();const f=await fixture(a);const s=await A.scan();await fs.writeFile(path.join(A.state,'index.json'),'broken');assert.equal((await A.scan()).complete,true);await fs.unlink(f);const next=await A.scan();assert.deepEqual(next.metadata_missing_artifacts,['demo@1.0.0']);await assert.rejects(A.export(s.snapshot_id,await B.scan()),/ENOENT|drift/);assert.deepEqual((await A.status()).baselines,{});
});

test('source drift after inventory aborts export and leaves no successful transfer/baseline',async()=>{
  const {a,b}=await pair();await fixture(a);const A=new MirrorRepository(a,{hooks:{beforeStage:async()=>{await fixture(a,'extra');}}}),B=new MirrorRepository(b);const s=await A.scan();await assert.rejects(A.export(s.snapshot_id,await B.scan()),/drift/);const status=await A.status();assert.equal(status.transfers[0].state,'export-failed');assert.deepEqual(status.baselines,{});
});

test('interrupted import resumes exact transfer id, preserves target-only and is idempotent',async()=>{
  const {a,b,A}=await pair();await fixture(a,'one');await fixture(a,'two');await fixture(b,'private');let fail=true;const B=new MirrorRepository(b,{hooks:{afterArtifact:async()=>{if(fail){fail=false;throw Error('simulated interruption');}}}});const e=await transfer(A,B);await assert.rejects(B.import(e.archive),/interruption/);assert.equal((await B.status()).transfers[0].state,'interrupted');const r=await B.import(e.archive);assert.equal(r.status,'verified');assert.deepEqual(await B.import(e.archive),r);assert.equal((await B.scan()).artifacts.length,3);
});

test('wrong target, target chain drift, unordered exports and forged receipts are rejected',async()=>{
  const {a,b,A,B}=await pair();await fixture(a);const old=await B.scan(),s=await A.scan(),e=await A.export(s.snapshot_id,old);const C=new MirrorRepository(await root());await assert.rejects(C.import(e.archive),/target/);
  await fixture(b,'local-change');await assert.rejects(B.import(e.archive),/chain/);assert.deepEqual((await B.status()).baselines,{});
  const fresh=await transfer(A,B),r=await B.import(fresh.archive);await assert.rejects(B.import(e.archive),/chain/);await assert.rejects(A.acceptReceipt({...r,source_root:'a'.repeat(64)}),/receipt/);
});

test('archive preflight rejects traversal, symlink, duplicate entries, expansion limits and tampered blobs',async()=>{
  const {a,A,B}=await pair();await fixture(a);const e=await transfer(A,B);const dir=await root();await tar.extract({cwd:dir,file:e.archive});
  const blobs=await fs.readdir(path.join(dir,'blobs'));await fs.writeFile(path.join(dir,'blobs',blobs[0]),'corrupt');const bad=path.join(await root(),'bad.tar.gz');await tar.create({cwd:dir,file:bad,gzip:true},['.mirror-manifest.json','blobs/'+blobs[0]]);await assert.rejects(B.import(bad),/checksum/);
  const duplicate=path.join(await root(),'duplicate.tar.gz');await tar.create({cwd:dir,file:duplicate,gzip:true},['.mirror-manifest.json','.mirror-manifest.json']);await assert.rejects(B.import(duplicate),/Duplicate/);
  await fs.symlink('/etc/passwd',path.join(dir,'link'));const sym=path.join(await root(),'sym.tar.gz');await tar.create({cwd:dir,file:sym,gzip:true},['link']);await assert.rejects(B.import(sym),/entry/);
  const small=new MirrorRepository(B.storage,{maxBytes:128});await assert.rejects(small.import(e.archive),/size limit|expansion/);
});

test('HTTP router serves full workflow, raw upload, inventories, saved time queries and safe UI',async()=>{
  const {a,b}=await pair();await fixture(a);const app=express();app.use((req,_res,next)=>{req.on('data',()=>{});next();});app.use(mirrorRouter(a,'/a',{registryURL:'http://127.0.0.1'}));app.use(mirrorRouter(b,'/b',{registryURL:'http://127.0.0.1'}));const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address() as any,base='http://127.0.0.1:'+addr.port;
  const post=async(p:string,b:any)=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,200,await r.clone().text());return r.json() as any;};
  try{
    const s=await post('/a/scan',{}),t=await post('/b/scan',{});const p=await post('/a/plan',{source_snapshot_id:s.snapshot_id,target:t});assert.equal(p.missing.length,1);
    const e=await post('/a/export',{source_snapshot_id:s.snapshot_id,target:t});const data=await (await fetch(base+e.download_url)).arrayBuffer();const uploaded=await fetch(base+'/b/import',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:data});assert.equal(uploaded.status,200,await uploaded.clone().text());const receipt=await uploaded.json();const ack=await post('/a/receipt',receipt);await post('/b/ack',ack);
    const saved=await (await fetch(base+'/a/snapshots/'+s.snapshot_id)).json() as any;assert.equal(saved.root,s.root);assert.equal((await (await fetch(base+'/b/status')).json() as any).transfers[0].state,'acknowledged');
    const html=mirrorHTML('/a');assert.doesNotThrow(()=>new Function(html.match(/<script>([\s\S]*?)<\/script>/)![1]));assert.match(html,/反向导出/);
    assert.equal((await stableRead(path.join(b,'demo/demo-1.0.0.tgz'))).sha256,s.artifacts[0].sha256);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('both distributable plugins use byte-identical generated protocol and UI sources',async()=>{
  for(const name of ['mirror-core.ts','mirror-router.ts']){const base=path.resolve(__dirname,'../../..');assert.equal(await fs.readFile(path.join(base,'scripts',name),'utf8'),await fs.readFile(path.join(base,'packages/verdaccio-ingest-middleware/src',name),'utf8'));assert.equal(await fs.readFile(path.join(base,'scripts',name),'utf8'),await fs.readFile(path.join(base,'packages/verdaccio-metadata-healer/src',name),'utf8'));}
});

test('history index queries actual package/version additions, disappearance, hash and alias changes by saved sequence',async()=>{
  const a=await root();const f=await fixture(a);const A=new MirrorRepository(a),first=await A.scan();
  await fixture(a,'demo','1.0.0','changed');const changed=await A.scan();
  await fs.copyFile(f,path.join(a,'demo/alias-1.0.0.tgz'));const alias=await A.scan();
  await fs.unlink(f);await fs.unlink(path.join(a,'demo/alias-1.0.0.tgz'));const gone=await A.scan();
  const all=await A.changes({package:'demo',version:'1.0.0'});assert.deepEqual(all.events.map((e:any)=>e.change),['added','hash-changed','aliases-changed','removed']);
  const range=await A.changes({package:'demo',from_sequence:changed.sequence,to_sequence:alias.sequence});assert.deepEqual(range.events.map((e:any)=>e.change),['hash-changed','aliases-changed']);
  assert.equal((await A.changes({package:'demo',from_time:'1900-01-01T00:00:00Z',to_time:'1901-01-01T00:00:00Z'})).total,0);
  await fs.writeFile(path.join(A.state,'index.json'),'corrupt');await A.rebuildHistoryIndex();assert.deepEqual((await A.changes({package:'demo'})).events,all.events);assert.equal((await A.snapshot(first.snapshot_id)).artifacts.length,1);assert.equal(gone.metadata_missing_artifacts.length,1);
});
test('empty/truncated legacy locks recover only when no live descriptor holds them; atomic locks retain live ownership',async()=>{
  const A=new MirrorRepository(await root());await A.init();const lock=path.join(A.state,'writer.lock');const fd=await fs.open(lock,'wx');try{await assert.rejects(A.scan(),/held open|running/);}finally{await fd.close();}
  assert.equal((await A.scan()).complete,true);await fs.writeFile(lock,'{"pid":');assert.equal((await A.scan()).complete,true);
  await fs.symlink('pid-'+process.pid+'-'+randomUUID(),lock);await assert.rejects(A.scan(),/already running/);await fs.unlink(lock);
  await fs.symlink('pid-2147483647-'+randomUUID(),lock);assert.equal((await A.scan()).complete,true);
});
test('reverse receipt with earlier wall clock advances by monotonic observations, replay never rolls baseline back',async()=>{
  const a=await root(),b=await root(),A=new MirrorRepository(a,{now:()=>new Date('2000-01-01T00:00:00Z')}),B=new MirrorRepository(b);await fixture(a,'online');await fixture(b,'private');
  const e=await transfer(A,B),r1=await B.import(e.archive);await B.acceptAck(await A.acceptReceipt(r1));
  const reverse=await transfer(B,A),r2=await A.import(reverse.archive);assert(r2.verified_at<r1.verified_at);const ack=await B.acceptReceipt(r2);assert.equal(ack.baseline_advanced,true);assert.equal((await A.acceptAck(ack)).baseline_advanced,true);
  const peer=(await B.status()).repo_id,head=(await A.status()).baselines[peer];assert.equal(head.receipt_hash,r2.receipt_hash);await A.acceptReceipt(r1);assert.equal((await A.status()).baselines[peer].receipt_hash,r2.receipt_hash);
});
test('late never-accepted forward receipt is superseded after a completed reverse chain',async()=>{
  const {a,b,A,B}=await pair();await fixture(a,'online');await fixture(b,'private');const first=await transfer(A,B),r1=await B.import(first.archive),back=await transfer(B,A),r2=await A.import(back.archive);await A.acceptAck(await B.acceptReceipt(r2));const late=await A.acceptReceipt(r1);assert.equal(late.baseline_advanced,false);assert.equal((await B.acceptAck(late)).baseline_advanced,false);
});
test('traversal and nested compression are rejected before apply',async()=>{
  const B=new MirrorRepository(await root()),dir=await root(),header=new (tar as any).Header({path:'../escape',type:'File',size:1,mode:0o600,uid:0,gid:0});header.encode();const bad=path.join(dir,'traversal.tar.gz');await fs.writeFile(bad,gzipSync(Buffer.concat([header.block,Buffer.from('x'),Buffer.alloc(511+1024)])));await assert.rejects(B.import(bad),/Unsafe path/);const nested=path.join(dir,'nested.tar.gz');await fs.writeFile(nested,gzipSync(gzipSync(Buffer.alloc(4096))));await assert.rejects(B.import(nested),/Nested compression/);
});
