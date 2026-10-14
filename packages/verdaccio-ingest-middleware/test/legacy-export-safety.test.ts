import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, afterEach } from 'node:test';
import { DifferentialScanner } from '../src/differential-scanner';
import { DifferentialPacker } from '../src/differential-packer';
import { extractLegacyArchive } from '../src/mirror-core';
const roots:string[]=[];const logger:any={info(){},debug(){},warn(){},error(){}};
afterEach(async()=>{for(const r of roots.splice(0))await fs.rm(r,{recursive:true,force:true});});
async function root(){const r=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-export-safety-'));roots.push(r);return r;}
test('v1 old/equal mtime and filtered metadata never establish a trusted baseline',async()=>{const r=await root();await fs.mkdir(path.join(r,'demo'));await fs.writeFile(path.join(r,'demo/demo-1.0.0.tgz'),'bytes');await fs.writeFile(path.join(r,'demo/package.json'),'{"name":"demo","versions":{}}');const old=new Date('2000-01-01');await fs.utimes(path.join(r,'demo/demo-1.0.0.tgz'),old,old);const scanner=new DifferentialScanner(r,logger);await scanner.addExportRecord({exportId:'old',timestamp:new Date().toISOString(),timestampMs:Date.now(),fileCount:1,totalSize:1,filename:'old.tar.gz',checksum:'unused',type:'full',summary:{packages:1,versions:1}});assert.equal(await scanner.getLastExportTimestamp(),null);const files=await scanner.scanModifiedFiles({since:new Date(),includeMetadata:false});assert.equal(files.length,1);assert.equal(files[0].type,'tarball');});
test('v1 packer stages/hash same bytes and creates an import-compatible archive',async()=>{const r=await root();await fs.mkdir(path.join(r,'demo'));await fs.writeFile(path.join(r,'demo/demo-1.0.0.tgz'),'stable-bytes');const scanner=new DifferentialScanner(r,logger),files=await scanner.scanModifiedFiles({});const out=await root();const e=await new DifferentialPacker(r,logger).createExportPackage(files,{exportId:'export-test',outputDir:out});const unpack=await root();const m=await extractLegacyArchive(e.path,unpack);assert.equal(m.files[0].checksum,e.manifest.files[0].checksum);assert.equal(await fs.readFile(path.join(unpack,'demo/demo-1.0.0.tgz'),'utf8'),'stable-bytes');});
test('v1 scanner errors abort export instead of silently returning partial scope',async()=>{const r=await root();await fs.mkdir(path.join(r,'blocked'));await fs.chmod(path.join(r,'blocked'),0);try{await assert.rejects(new DifferentialScanner(r,logger).scanModifiedFiles({}),/EACCES/);}finally{await fs.chmod(path.join(r,'blocked'),0o700);}});
