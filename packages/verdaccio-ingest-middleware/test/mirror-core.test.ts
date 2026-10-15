import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import tar from 'tar';
import express from 'express';
import { MirrorRepository, reconcile, stableRead, getWriterIdentity, persistVerdaccioMetadata } from '../src/mirror-core';
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
test('a real source mutation during the same-stream staged read is rejected even when mtime is restored',async()=>{
  const r=await root(),source=path.join(r,'source'),staged=path.join(r,'staged');await fs.writeFile(source,Buffer.alloc(32*1024*1024,7));const before=await fs.stat(source);
  const reading=stableRead(source,staged).then(value=>({value,error:undefined as any}),error=>({value:undefined,error}));
  let started=false;for(let i=0;i<300;i++){try{if((await fs.stat(staged)).size>0){started=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1));}assert.equal(started,true);
  const f=await fs.open(source,'r+');try{await f.write(Buffer.from('changed'),0,7,0);}finally{await f.close();}await fs.utimes(source,before.atime,before.mtime);const result=await reading;assert.match(result.error?.message||'',/Source changed/);
});
test('process death after publication resumes with a dead-PID atomic lock and applying journal',async()=>{
  const {a,A,B}=await pair();await fixture(a,'one');await fixture(a,'two');const e=await transfer(A,B);
  const childCode=`require(${JSON.stringify(require.resolve('tsx/cjs'))});const {MirrorRepository}=require(${JSON.stringify(path.resolve(__dirname,'../src/mirror-core.ts'))});new MirrorRepository(${JSON.stringify(B.storage)},{hooks:{afterArtifact:async()=>process.exit(77)}}).import(${JSON.stringify(e.archive)}).catch(e=>{console.error(e);process.exit(1)});`;
  const child=spawn(process.execPath,['-e',childCode],{stdio:'ignore'});const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,77);assert.equal((await B.status()).transfers[0].state,'applying');const receipt=await B.import(e.archive);assert.equal(receipt.status,'verified');assert.equal((await B.scan()).artifacts.length,2);
});
test('two real processes cannot both reclaim a dead owner or enter the critical section', {timeout:15000},async()=>{
  const r=await root(),A=new MirrorRepository(r);await A.init();await fs.symlink('pid-2147483647-'+randomUUID(),path.join(A.state,'writer.lock'));
  const code=(role:string)=>`require(${JSON.stringify(require.resolve('tsx/cjs'))});const fs=require('fs/promises'),{MirrorRepository}=require(${JSON.stringify(path.resolve(__dirname,'../src/mirror-core.ts'))});const role=${JSON.stringify(role)},root=${JSON.stringify(r)};process.on('message',async m=>{if(m!=='go')return;try{await new MirrorRepository(root,{hooks:{beforeReclaim:async()=>{process.send({type:'checked'});if(role==='a')await new Promise(resolve=>process.once('message',resolve));},afterWalk:async()=>{let f;try{f=await fs.open(root+'/.critical-guard','wx');}catch(e){process.send({type:'overlap'});throw e;}process.send({type:'entered'});await new Promise(resolve=>setTimeout(resolve,150));await f.close();await fs.unlink(root+'/.critical-guard');}}}).scan();process.send({type:'done'},()=>process.exit(0));}catch(e){process.send({type:'error',error:e.message},()=>process.exit(/already running/.test(e.message)?2:1));}});process.send({type:'ready'});`;
  const launch=(role:string)=>{const child=spawn(process.execPath,['-e',code(role)],{stdio:['ignore','ignore','ignore','ipc']}),messages:any[]=[];child.on('message',m=>messages.push(m));const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});const message=async(type:string)=>{for(let n=0;n<1000;n++){const found=messages.find(m=>m.type===type);if(found)return found;if(child.exitCode!==null)throw Error('Child exited before '+type);await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Child message timeout '+type);};return {child,messages,exit,message};};
  const a=launch('a'),b=launch('b');try{await Promise.all([a.message('ready'),b.message('ready')]);a.child.send('go');await a.message('checked');b.child.send('go');const second=await Promise.race([b.exit.then(code=>({exit:code})),b.message('entered').then(()=>({entered:true}))]);a.child.send('release');const [ac,bc]=await Promise.all([a.exit,b.exit]);assert.equal(ac,0);assert.equal(bc,2);assert('exit'in second);assert.equal([...a.messages,...b.messages].filter(m=>m.type==='entered').length,1);assert.equal([...a.messages,...b.messages].some(m=>m.type==='overlap'),false);}finally{for(const c of [a,b])if(c.child.exitCode===null)c.child.kill('SIGTERM');}
});
test('a durable unindexed snapshot is recovered before a later scan and matches full historical rebuild',async()=>{
  const r=await root(),A=new MirrorRepository(r);await A.scan();const prior=JSON.parse(await fs.readFile(path.join(A.state,'index.json'),'utf8'));await fixture(r,'transient');
  const code=`require(${JSON.stringify(require.resolve('tsx/cjs'))});const {MirrorRepository}=require(${JSON.stringify(path.resolve(__dirname,'../src/mirror-core.ts'))});new MirrorRepository(${JSON.stringify(r)},{hooks:{afterSnapshotSaved:async()=>process.exit(78)}}).scan().catch(()=>process.exit(1));`;
  const child=spawn(process.execPath,['-e',code],{stdio:'ignore'});assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),78);assert.equal(JSON.parse(await fs.readFile(path.join(A.state,'index.json'),'utf8')).checksum,prior.checksum);
  assert.equal((await A.changes({package:'transient'})).events[0].change,'added');await fs.rm(path.join(r,'transient'),{recursive:true});await A.scan();const recovered=await A.changes({package:'transient'});assert.deepEqual(recovered.events.map((e:any)=>e.change),['added','removed']);await A.rebuildHistoryIndex();assert.deepEqual((await A.changes({package:'transient'})).events,recovered.events);
});
test('metadata-only and pure metadata changes are indexed, with an inclusive UTC hit interval',async()=>{
  const r=await root(),A=new MirrorRepository(r);await fs.mkdir(path.join(r,'metadata-only'));await fs.writeFile(path.join(r,'metadata-only/package.json'),JSON.stringify({name:'metadata-only',versions:{'1.0.0':{name:'metadata-only',version:'1.0.0'}},'dist-tags':{latest:'1.0.0'}}));await fixture(r,'stored');const first=await A.scan();assert.equal((await A.changes({package:'metadata-only'})).events[0].change,'metadata-only');
  await new Promise(resolve=>setTimeout(resolve,5));const mp=path.join(r,'stored/package.json'),m=JSON.parse(await fs.readFile(mp,'utf8'));m.versions['1.0.0'].description='metadata changed, same tgz';await fs.writeFile(mp,JSON.stringify(m));const second=await A.scan();assert.equal(first.artifact_root,second.artifact_root);
  const hit=await A.changes({package:'stored',version:'1.0.0',from_time:second.ended_at,to_time:second.ended_at});assert.equal(hit.total,1);assert.equal(hit.events[0].change,'metadata-changed');assert.equal(hit.events[0].sequence,second.sequence);
});
test('choosing-stage and ticket-stage process death cannot block recovery',async()=>{
  for(const [hook,exit]of [['afterWriterChoosing',79],['afterWriterTicket',80]] as const){const r=await root();const code=`require(${JSON.stringify(require.resolve('tsx/cjs'))});const {MirrorRepository}=require(${JSON.stringify(path.resolve(__dirname,'../src/mirror-core.ts'))});new MirrorRepository(${JSON.stringify(r)},{hooks:{${hook}:async()=>process.exit(${exit})}}).scan().catch(()=>process.exit(1));`;const child=spawn(process.execPath,['-e',code],{stdio:'ignore'});assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),exit);assert.equal((await new MirrorRepository(r).scan()).complete,true);}
});
test('same PID with a different start/boot identity is stale; actual holders and unknown namespaces are protected',async()=>{
  const r=await root(),A=new MirrorRepository(r);await A.init();const self=await getWriterIdentity(),writers=path.join(A.state,'writers');
  for(const state of ['choosing','ticket'])for(const altered of [{start_time:self.start_time==='0'?'1':'0'},{boot_id:'00000000-0000-0000-0000-000000000000'}]){const p=path.join(writers,'owner-'+process.pid+'-'+randomUUID());await fs.symlink(JSON.stringify({...self,...altered,state,number:'1'}),p);assert.equal((await A.scan()).complete,true);await fs.unlink(p);}
  const live=path.join(writers,'owner-'+process.pid+'-'+randomUUID());await fs.symlink(JSON.stringify({...self,state:'choosing'}),live);await assert.rejects(A.scan(),/already running/);await fs.unlink(live);
  const foreign=path.join(writers,'owner-'+process.pid+'-'+randomUUID());await fs.symlink(JSON.stringify({...self,pid_namespace:'pid:[0]',state:'choosing'}),foreign);await assert.rejects(A.scan(),/another PID namespace/);await fs.unlink(foreign);
  await fs.symlink(JSON.stringify({...self,start_time:'0',token:randomUUID()}),path.join(A.state,'writer.lock'));assert.equal((await A.scan()).complete,true);
});
test('exports condition ordering remains observable even when tgz bytes do not change',async()=>{
  const r=await root(),A=new MirrorRepository(r);await fixture(r);const p=path.join(r,'demo/package.json'),m=JSON.parse(await fs.readFile(p,'utf8'));m.versions['1.0.0'].exports={import:'./esm.js',default:'./fallback.js'};await fs.writeFile(p,JSON.stringify(m));const first=await A.scan();m.versions['1.0.0'].exports={default:'./fallback.js',import:'./esm.js'};await fs.writeFile(p,JSON.stringify(m));const next=await A.scan();assert.equal(first.artifact_root,next.artifact_root);assert.notEqual(first.root,next.root);assert.equal((await A.changes({package:'demo'})).events[1].change,'metadata-changed');
});
test('standard storage creates missing metadata without direct filesystem fallback',async()=>{let created:any;const storage={localStorage:{_getLocalStorage:()=>({createPackage(_name:string,data:any,cb:(e?:any)=>void){created=data;cb();}}),_updatePackage(_name:string,_update:any,cb:(e?:any)=>void){cb({code:404});}}};await persistVerdaccioMetadata(storage,'demo',{name:'demo',versions:{'1.0.0':{name:'demo',version:'1.0.0'}},'dist-tags':{latest:'1.0.0'}});assert(created.versions['1.0.0']);assert.deepEqual(created._uplinks,{});assert.equal(created._id,'demo');});
test('standard create race retries locked update, retaining current private version fields and tags',async()=>{let calls=0;const current:any={name:'demo',_rev:'target-rev',versions:{'1.0.0':{name:'demo',version:'1.0.0',privateNote:'retain'},'2.0.0':{name:'demo',version:'2.0.0'}},'dist-tags':{latest:'2.0.0'},time:{'2.0.0':'known-time'},_uplinks:{target:true}};const storage={localStorage:{_getLocalStorage:()=>({createPackage(_n:string,_d:any,cb:(e?:any)=>void){cb({code:'EEXIST'});}}),_updatePackage(_n:string,update:any,cb:(e?:any)=>void){if(!calls++){cb({code:'ENOENT'});return;}update(current,cb);}}};await persistVerdaccioMetadata(storage,'demo',{name:'demo',versions:{'1.0.0':{name:'demo',version:'1.0.0',type:'module',dist:{shasum:'actual'}}},'dist-tags':{latest:'1.0.0'},time:{modified:'local-change'}});assert.equal(calls,2);assert.equal(current.versions['1.0.0'].privateNote,'retain');assert.equal(current.versions['1.0.0'].type,'module');assert(current.versions['2.0.0']);assert.equal(current['dist-tags'].latest,'2.0.0');assert.equal(current.time['2.0.0'],'known-time');assert.equal(current._rev,'target-rev');});

test('verified replay repairs missing metadata, retains target fields, and rejects a changed artifact set',async()=>{
  const {a,b,A,B}=await pair();await fixture(a);const src=path.join(a,'demo/package.json'),sm=JSON.parse(await fs.readFile(src,'utf8'));sm.versions['1.0.0'].exports={'.':'./index.js'};await fs.writeFile(src,JSON.stringify(sm));
  const e=await transfer(A,B),receipt=await B.import(e.archive),dest=path.join(b,'demo/package.json');
  const m=JSON.parse(await fs.readFile(dest,'utf8'));m.versions['1.0.0'].privateNote='retain';delete m.versions['1.0.0'].dist;delete m.versions['1.0.0'].exports;await fs.writeFile(dest,JSON.stringify(m));
  assert.deepEqual(await B.import(e.archive),receipt);
  const fixed=JSON.parse(await fs.readFile(dest,'utf8'));assert.equal(fixed.versions['1.0.0'].privateNote,'retain');assert.deepEqual(fixed.versions['1.0.0'].exports,{'.':'./index.js'});assert(fixed.versions['1.0.0'].dist.integrity);
  assert.deepEqual((await B.status()).baselines,{});
  fixed.versions['1.0.0'].description='changed local meaning';await fs.writeFile(dest,JSON.stringify(fixed));await assert.rejects(B.import(e.archive),/metadata changed/);assert.deepEqual((await B.status()).baselines,{});
  await fixture(b,'added-after-receipt');await assert.rejects(B.import(e.archive),/artifacts changed/);assert.deepEqual((await B.status()).baselines,{});
});
