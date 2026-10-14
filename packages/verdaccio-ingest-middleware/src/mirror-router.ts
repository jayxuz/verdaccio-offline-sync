// Canonical source: scripts/mirror-router.ts. Generated copies ship with each plugin.
import { Router, json } from 'express';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { MirrorRepository, MirrorOptions, reconcile } from './mirror-core';

export function mirrorRouter(storage: string, prefix: string, options: MirrorOptions = {}, verdaccioStorage?:any): Router {
  const runtimeOptions={...options};
  if(verdaccioStorage)runtimeOptions.onImported=async(names:string[])=>{
    const local=verdaccioStorage.localStorage;
    if(typeof local?._getLocalStorage!=='function'||typeof local?.storagePlugin?.add!=='function')throw new Error('Unsupported Verdaccio storage adapter; no verified receipt');
    for(const name of names){
      const raw=JSON.parse(await fs.readFile(path.join(storage,name,'package.json'),'utf8'));
      const ps=local._getLocalStorage(name);
      await new Promise<void>((resolve,reject)=>ps.upsertPackage(name,raw,(e:any)=>e?reject(e):resolve()));
      await new Promise<void>((resolve,reject)=>{const result=local.storagePlugin.add(name,(e:any)=>e?reject(e):resolve());if(result?.then)result.then(resolve,reject);else if(local.storagePlugin.add.length<2)resolve();});
    }
  };
  const router = Router(), repo = new MirrorRepository(storage, runtimeOptions);
  const action = (fn: (req:any,res:any)=>Promise<any>) => async(req:any,res:any):Promise<void> => {
    try { await fn(req,res); } catch(e:any) { if(process.env.VERDACCIO_MIRROR_DEBUG)console.error(e.stack); if(!res.headersSent)res.status(409).json({success:false,error:e.message}); }
  };
  router.get(prefix+'/ui', (_req,res)=>res.type('html').send(mirrorHTML(prefix)));
  // Use a local parser before existing plugin parsers, allowing full inventories without changing other APIs.
  router.use(prefix, json({limit:options.maxJSONBytes || 64*1024**2}));
  router.get(prefix+'/status', action(async(_req,res)=>res.json(await repo.status())));
  router.get(prefix+'/snapshots', action(async(_req,res)=>res.json(await repo.snapshots())));
  router.get(prefix+'/snapshots/:id', action(async(req,res)=>res.json(await repo.snapshot(req.params.id))));
  router.post(prefix+'/scan', action(async(_req,res)=>res.json(await repo.scan())));
  router.post(prefix+'/plan', action(async(req,res)=>res.json(reconcile(await repo.snapshot(req.body.source_snapshot_id),req.body.target))));
  router.post(prefix+'/export', action(async(req,res)=>{ const result=await repo.export(req.body.source_snapshot_id,req.body.target); delete result.archive; res.json({...result,download_url:`${prefix}/archives/${result.transfer_id}`}); }));
  router.get(prefix+'/archives/:id', action(async(req,res)=>{await repo.init();await fs.access(repo.archive(req.params.id));res.download(repo.archive(req.params.id),req.params.id+'.tar.gz');}));
  router.post(prefix+'/import', action(async(req,res)=>{
    // Verdaccio's request logger adds a data listener. Pause synchronously before any await,
    // otherwise the incoming body drains while the upload directory is being prepared.
    req.pause();
    await repo.init();const dir=path.join(repo.state,'uploads');await fs.mkdir(dir,{recursive:true});const upload=path.join(dir,randomUUID());let size=0;
    try { const cap=new Transform({transform(chunk,_e,cb){size+=chunk.length;cb(size>(options.maxBytes||20*1024**3)?new Error('Upload size limit'):null,chunk);}});await pipeline(req,cap,createWriteStream(upload,{flags:'wx',mode:0o600}));res.setHeader('X-Mirror-Upload-Bytes',size);if(!size)throw new Error('Empty archive upload; check host request-body middleware');res.json(await repo.import(upload)); }
    finally {await fs.rm(upload,{force:true});}
  }));
  router.post(prefix+'/receipt', action(async(req,res)=>res.json(await repo.acceptReceipt(req.body))));
  router.post(prefix+'/ack', action(async(req,res)=>res.json(await repo.acceptAck(req.body))));
  return router;
}

export function mirrorHTML(prefix:string):string{return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>双向镜像同步</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#f3f6fa;color:#1c2d42;margin:0}main{max-width:1100px;margin:auto;padding:28px}h1{margin:0}section{background:white;border:1px solid #d8e0eb;border-radius:12px;padding:22px;margin:18px 0}button,a.btn{background:#1554b1;color:white;border:0;border-radius:6px;padding:9px 14px;cursor:pointer;margin:5px;text-decoration:none;display:inline-block}button:disabled{opacity:.45;cursor:wait}input,select{padding:7px;max-width:100%}pre{white-space:pre-wrap;word-break:break-word;max-height:430px;overflow:auto;background:#eef3fa;padding:15px;border-radius:7px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}small{color:#526780}.error{color:#a62020}#notice{position:sticky;top:0;padding:9px;background:#e4efff;border-radius:6px}</style>
<main><h1>双向镜像同步 · v2</h1><p>完整库存对账 → 差异制品 → 目标验证 → 回执 → 确认。两端使用相同流程，保留双方独有制品。</p><div id="notice" role="status">准备就绪</div>
<section><h2>1 · 本地库存与已保存快照</h2><p>清单基于扫描区间；只有完整成功的清单可用于对账。历史查询仅查询已保存快照。</p><button id="scan">完整扫描 / 重建索引</button><button id="refresh">刷新状态</button><select id="saved"><option value="">选择已保存快照</option></select><button id="load">加载快照</button><button id="inventory" disabled>下载本地清单</button><pre id="local">尚未扫描</pre></section>
<section><h2>2 · 导入对方清单，对账及导出</h2><label>对方完整库存 JSON <input id="peer" type="file" accept=".json"></label><button id="plan" disabled>对账</button><button id="export" disabled>生成补齐差异包</button><div id="download"></div><div id="counts"></div><pre id="comparison">尚未对账</pre><p><small>同包同版本异 hash 会阻止导出。别名仅在 hash 相同时归为相同内容；清理仅生成 dry-run 隔离备份计划。若对方独有制品需要传回，请在对方的本页导入本地清单并反向导出。</small></p></section>
<section><h2>3 · 导入差异包并生成验证回执</h2><input id="archive" type="file" accept=".tar.gz,.tgz"><button id="import">导入并验证</button><button id="receiptDownload" disabled>下载回执</button><pre id="importResult">尚未导入</pre></section>
<section><h2>4 · 接收回执及返回确认</h2><label>目标回执 JSON <input id="receipt" type="file" accept=".json"></label><button id="acceptReceipt">接收回执</button><button id="ackDownload" disabled>下载确认</button><br><label>源端确认 JSON <input id="ack" type="file" accept=".json"></label><button id="acceptAck">接收确认</button><p><small>仅目标实物与 metadata 验证成功会生成回执。源端接收回执后记录共同基线；目标接收确认后完成该链。丢失回执可从状态重新下载。断链或换目标时交换完整清单。</small></p><pre id="baseline">尚未确认</pre></section>
<section><h2>仓库、回执与基线状态</h2><div id="receipts"></div><pre id="state"></pre></section></main>
<script>
const api=${JSON.stringify(prefix)},$=id=>document.getElementById(id);let local,peer,receipt,ack;
const show=(id,v)=>$(id).textContent=typeof v==='string'?v:JSON.stringify(v,null,2);
async function request(route,body){const r=await fetch(api+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||r.statusText);return j;}
function save(name,value){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
async function file(id){if(!$(id).files[0])throw Error('请先选择文件');return JSON.parse(await $(id).files[0].text());}
function run(id,fn){$(id).onclick=async()=>{const b=$(id);b.disabled=true;show('notice','正在处理，请等待…');try{await fn();show('notice','操作完成');await status();}catch(e){show('notice','失败：'+e.message);$('notice').className='error';}finally{b.disabled=false;}};}
async function status(){const s=await request('/status');show('state',s);$('receipts').replaceChildren();for(const t of s.transfers.filter(t=>t.receipt)){const b=document.createElement('button');b.textContent='下载回执 '+t.transfer_id;b.onclick=()=>save('receipt-'+t.transfer_id+'.json',t.receipt);$('receipts').append(b);}const all=await request('/snapshots'),selected=$('saved').value;$('saved').replaceChildren();for(const x of all){const o=document.createElement('option');o.value=x.snapshot_id;o.textContent=x.ended_at+' · '+(x.complete?'完整':'不完整')+' · '+x.files+' 制品';$('saved').append(o);}$('saved').value=selected||all[0]?.snapshot_id||'';}
function setLocal(s){local=s;show('local',{repo_id:s.repo_id,snapshot_id:s.snapshot_id,root:s.root,complete:s.complete,errors:s.errors,artifacts:s.artifacts.length,metadata_only:s.metadata_missing_artifacts.length,started_at:s.started_at,ended_at:s.ended_at});$('inventory').disabled=!s.complete;$('plan').disabled=!(s.complete&&peer);$('export').disabled=true;}
run('scan',async()=>setLocal(await request('/scan',{})));run('refresh',status);run('load',async()=>setLocal(await request('/snapshots/'+$('saved').value)));
$('inventory').onclick=()=>save('inventory-'+local.repo_id+'.json',local);
$('peer').onchange=async()=>{try{peer=await file('peer');$('plan').disabled=!local?.complete;show('comparison','已加载对方清单 '+peer.repo_id);$('export').disabled=true;}catch(e){show('notice',e.message);}};
run('plan',async()=>{const p=await request('/plan',{source_snapshot_id:local.snapshot_id,target:peer});show('comparison',p);show('counts','补齐 '+p.missing.length+' · 对方独有 '+p.target_only.length+' · 冲突 '+p.conflicts.length+' · 路径别名 '+p.aliases.length);$('export').disabled=!!p.conflicts.length;});
run('export',async()=>{const e=await request('/export',{source_snapshot_id:local.snapshot_id,target:peer});$('download').replaceChildren();const a=document.createElement('a');a.className='btn';a.href=e.download_url;a.textContent='下载补齐包 ('+e.files+' 制品)';a.download=e.transfer_id+'.tar.gz';$('download').append(a);show('comparison',e);});
run('import',async()=>{if(!$('archive').files[0])throw Error('请选择差异包');const r=await fetch(api+'/import',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:$('archive').files[0]});const j=await r.json();if(!r.ok)throw Error(j.error);receipt=j;show('importResult',j);$('receiptDownload').disabled=false;});
$('receiptDownload').onclick=()=>save('receipt-'+receipt.transfer_id+'.json',receipt);
run('acceptReceipt',async()=>{ack=await request('/receipt',await file('receipt'));show('baseline',ack);$('ackDownload').disabled=false;});$('ackDownload').onclick=()=>save('ack-'+ack.transfer_id+'.json',ack);
run('acceptAck',async()=>show('baseline',await request('/ack',await file('ack'))));status().catch(e=>show('notice',e.message));
</script></html>`;}
