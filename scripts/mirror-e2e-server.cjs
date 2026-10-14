// Isolated real Verdaccio instances for manual/browser validation. No production paths.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const base=path.resolve(__dirname,'..');
const tar=require(path.join(base,'packages/verdaccio-ingest-middleware/node_modules/tar'));
const {runServer}=require(path.join(base,'packages/verdaccio-ingest-middleware/node_modules/verdaccio'));
async function fixture(storage,name,version,content){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'mirror-e2e-package-'));await fs.mkdir(path.join(tmp,'package'));await fs.writeFile(path.join(tmp,'package/package.json'),JSON.stringify({name,version,description:content}));await fs.writeFile(path.join(tmp,'package/index.js'),`module.exports=${JSON.stringify(content)};`);
 const dir=path.join(storage,name);await fs.mkdir(dir,{recursive:true});const filename=name.split('/').pop()+'-'+version+'.tgz';await tar.create({cwd:tmp,file:path.join(dir,filename),gzip:true,portable:true,noMtime:true},['package']);
 const manifest={name,_id:name,_rev:'1-0000000000000001',versions:{[version]:{name,version,description:content,dist:{tarball:'http://localhost:1/'+name+'/-/'+filename}}},'dist-tags':{latest:version},_attachments:{},_distfiles:{},_uplinks:{},time:{created:new Date().toISOString(),modified:new Date().toISOString()}};await fs.writeFile(path.join(dir,'package.json'),JSON.stringify(manifest));await fs.rm(tmp,{recursive:true,force:true});
}
async function main(){
 await fs.mkdir(path.join(base,'output/mirror'),{recursive:true});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'verdaccio-mirror-e2e-')),plugins=path.join(root,'plugins');await fs.mkdir(plugins);
 for(const name of ['verdaccio-ingest-middleware','verdaccio-metadata-healer'])await fs.symlink(path.join(base,'packages',name),path.join(plugins,name));
 const servers=[];
 for(const [side,port,plugin] of [['source',15971,'ingest-middleware'],['target',15972,'metadata-healer']]){
  const storage=path.join(root,side,'storage');await fs.mkdir(storage,{recursive:true});
  await fixture(storage,side==='source'?'browser-demo':'private-demo','1.0.0',side==='source'?'online fixture':'private target fixture');
  const config={storage,plugins,uplinks:{},packages:{'@*/*':{access:'$all',publish:'$authenticated'},'**':{access:'$all',publish:'$authenticated'}},middlewares:{[plugin]:{enabled:true,enableImportUI:true,storagePath:storage,mirrorRegistryURL:'http://127.0.0.1:'+port,host:'127.0.0.1:'+port}},log:{type:'stdout',format:'pretty',level:'warn'},listen:'127.0.0.1:'+port};
  const configPath=path.join(root,side,'config.yaml');await fs.writeFile(configPath,JSON.stringify(config,null,2));const server=await runServer(configPath);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});servers.push(server);
 }
 await fs.writeFile(path.join(base,'output/mirror/e2e-state.json'),JSON.stringify({root,source:'http://127.0.0.1:15971/_/ingest/mirror',target:'http://127.0.0.1:15972/_/healer/mirror'},null,2));
 console.log('ISOLATED_MIRROR_READY '+root);
 process.on('SIGTERM',()=>{for(const s of servers)s.close();setTimeout(()=>process.exit(),100).unref();});
}
main().catch(e=>{console.error(e);process.exit(1);});
