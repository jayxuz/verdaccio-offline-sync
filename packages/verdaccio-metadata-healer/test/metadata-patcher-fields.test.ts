import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, afterEach } from 'node:test';
import tar from 'tar';
import { MetadataPatcher } from '../src/metadata-patcher';
import { ShasumCache } from '../src/shasum-cache';
const roots:string[]=[];const logger:any={debug(){},info(){},warn(){},error(){}};
afterEach(async()=>{for(const r of roots.splice(0))await fs.rm(r,{recursive:true,force:true});});
async function patched(extra:any,binding=true){const r=await fs.mkdtemp(path.join(os.tmpdir(),'mirror-install-fields-'));roots.push(r);await fs.mkdir(path.join(r,'package'));const pkg={name:'fields-demo',version:'1.0.0',type:'module',exports:{'.':'./index.js'},imports:{'#internal':'./internal.js'},typesVersions:{'*':{'*':['types/*']}},sideEffects:false,os:['linux'],cpu:['arm64'],libc:'musl',peerDependenciesMeta:{react:{optional:true}},directories:{lib:'lib'},...extra};await fs.writeFile(path.join(r,'package/package.json'),JSON.stringify(pkg));if(binding)await fs.writeFile(path.join(r,'package/binding.gyp'),'{"targets":[]}');const file=path.join(r,'fields-demo-1.0.0.tgz');await tar.create({file,cwd:r,gzip:true},['package']);const config:any={host:'127.0.0.1:15972'};const result=await new MetadataPatcher(config,logger).patchManifest({name:'fields-demo',versions:{},'dist-tags':{}} as any,[{path:file,filename:'fields-demo-1.0.0.tgz',version:'1.0.0',mtime:new Date()}] as any,new ShasumCache(config,logger));assert.equal((result as any).time?.['1.0.0'],undefined);return (result as any).versions['1.0.0'];}
test('real tgz reconstruction preserves module/export/platform/peer fields and implicit binding.gyp install',async()=>{const v=await patched({});assert(v);assert.equal(v.type,'module');assert.deepEqual(v.exports,{'.':'./index.js'});assert.deepEqual(v.imports,{'#internal':'./internal.js'});assert.deepEqual(v.typesVersions,{'*':{'*':['types/*']}});assert.equal(v.sideEffects,false);assert.equal(v.libc,'musl');assert.deepEqual(v.os,['linux']);assert.deepEqual(v.cpu,['arm64']);assert.deepEqual(v.peerDependenciesMeta,{react:{optional:true}});assert.equal(v.hasInstallScript,true);assert(v.dist.shasum);assert(v.dist.integrity);});
test('gypfile false disables implicit install but explicit lifecycle still marks install script',async()=>{assert.equal((await patched({gypfile:false})).hasInstallScript,false);assert.equal((await patched({gypfile:false,scripts:{postinstall:'node postinstall.js'}})).hasInstallScript,true);assert.equal((await patched({},false)).hasInstallScript,false);});
