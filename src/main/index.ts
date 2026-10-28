import {app,BrowserWindow,ipcMain,dialog,utilityProcess,protocol,shell,net} from 'electron';
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';import {createReadStream,createWriteStream} from 'node:fs';import {pipeline} from 'node:stream/promises';import {Transform} from 'node:stream';
import {validateSpec,validateSettings,validateViewport,colour} from '../contracts/model';
const {saveArtifact,sha,identity,protect}=require('../domain/files.cjs');
let win:BrowserWindow,root='',revision=0,current:any=null,savedPath='',active:any=null,serial=0,closing=false;
const assets=new Map<string,any>(),images=new Map<string,string>(),datasets=new Map<string,any>();
const APP_ID='local.instruments.compression';const testMode=process.env.MICROSCOPE_TEST==='1'&&!app.isPackaged;
// Squirrel 安装事件：自己维护开始菜单与桌面快捷方式。
// 背景：Setup.exe 装完不生成任何快捷方式（iconUrl 指向远程，本网络下不可靠），
// 而 Update.exe --createShortcut 建出来的名字取自 exe 文件名，只能是 ASCII，
// 装完开始菜单会显示 ImageCompressionMicroscope 而不是中文产品名。
// 所以这里直接写 .lnk：名字用产品名，目标指向版本无关的根级 stub，
// 这样后续升级换 app-x.y.z 目录也不会让快捷方式失效。
// 注意不能匹配 --squirrel-firstrun，那是安装后自动启动应用的事件。
const PRODUCT_NAME='图片压缩显微镜';
const squirrelEvent=process.platform==='win32'
 ?['--squirrel-install','--squirrel-updated','--squirrel-uninstall','--squirrel-obsolete'].find(a=>process.argv.includes(a))
 :undefined;
if(squirrelEvent){
 try{
  const exeName=path.basename(process.execPath);
  const appDir=path.resolve(path.dirname(process.execPath),'..');
  const stub=path.join(appDir,exeName);
  const startMenu=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs');
  const links=[path.join(startMenu,PRODUCT_NAME+'.lnk'),path.join(app.getPath('desktop'),PRODUCT_NAME+'.lnk')];
  const removing=squirrelEvent==='--squirrel-uninstall'||squirrelEvent==='--squirrel-obsolete';
  if(removing){
   for(const lnk of links){try{require('node:fs').unlinkSync(lnk);}catch{}}
  }else{
   for(const lnk of links)shell.writeShortcutLink(lnk,'create',{target:stub,args:'',icon:stub,iconIndex:0,description:PRODUCT_NAME});
  }
  // 旧版本用 Update.exe 建过 ASCII 名字的快捷方式，升级时一并清掉，避免开始菜单里出现两条。
  if(!removing){
   const legacy=path.join(startMenu,'Personal instruments',exeName.replace(/\.exe$/i,'')+'.lnk');
   try{require('node:fs').unlinkSync(legacy);}catch{}
  }
 }catch(e){
  // 写 lnk 失败时退回 Squirrel 自带机制，至少保证有一条能用的入口。
  try{
   const exeName=path.basename(process.execPath);
   const updateExe=path.resolve(path.dirname(process.execPath),'..','Update.exe');
   const args=squirrelEvent==='--squirrel-uninstall'||squirrelEvent==='--squirrel-obsolete'
    ?['--removeShortcut',exeName]:['--createShortcut',exeName];
   require('node:child_process').spawnSync(updateExe,args,{timeout:20000,windowsHide:true,stdio:'ignore'});
  }catch{}
 }
 app.exit(0);
}
const entry=pathToFileURL(path.join(__dirname,'../renderer/index.html')).href;
protocol.registerSchemesAsPrivileged([{scheme:'microscope',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
if(!app.requestSingleInstanceLock())app.quit();
const safe=(fn:any)=>async(event:any,...args:any[])=>{if(event.sender!==win.webContents||event.senderFrame?.url!==entry)throw Error('拒绝未知消息来源');return fn(...args);};
const notify=(data:any)=>{if(!win?.isDestroyed())win?.webContents.send('job',data);};
const ref=(a:any)=>({id:a.id,name:a.name,byteLength:a.byteLength,sha256:a.sha256});
async function register(file:string){
 if(typeof file!=='string'||file.length>32767)throw Error('无效文件');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>512*1024*1024)throw Error('素材须为不超过 512 MiB 的普通文件');if(assets.size>=30)throw Error('本会话已导入30份材料，请保存会话后重新启动释放缓存');
 const id=crypto.randomUUID(),snapshot=path.join(root,id+'.input'),digest=crypto.createHash('sha256');let n=0;
 await pipeline(createReadStream(file),new Transform({transform(chunk,_,cb){n+=chunk.length;if(n>512*1024*1024)cb(Error('素材过大'));else{digest.update(chunk);cb(null,chunk);}}}),createWriteStream(snapshot,{flags:'wx'}));
 const item={id,path:file,identity:await identity(file),snapshot,name:path.basename(file),byteLength:n,modifiedAtMs:stat.mtimeMs,sha256:digest.digest('hex')};assets.set(id,item);return ref(item);
}
async function stopWorker(){const worker=active;active=null;if(worker){await new Promise<void>(resolve=>{worker.once('exit',()=>resolve());if(!worker.kill())resolve();});}}
async function invalidate(){revision++;current=null;serial++;await stopWorker();notify({type:'cancelled',revision});return revision;}
async function directory(){const dir=path.join(root,crypto.randomUUID());await fs.mkdir(dir);return dir;}
async function worker(operation:string,payload:any,guard:()=>boolean,kind:string){
 const token=++serial;await stopWorker();if(!guard()||token!==serial)throw Error('任务已过期');
 return new Promise<any>((resolve,reject)=>{const child=utilityProcess.fork(path.join(__dirname,'../workers/image.cjs'),[],{serviceName:'图像处理'});active=child;let settled=false;const finish=(error:any,result?:any)=>{if(settled)return;settled=true;if(active===child)active=null;child.kill();error?reject(error):resolve(result);};
 child.on('message',m=>{if(!guard()||token!==serial){finish(Error('任务已过期'));return;}if(m.type==='result')finish(null,m.result);else if(m.type==='error')finish(Object.assign(Error(m.message),{code:m.code}));else if(m.type==='progress')notify({...m,revision,kind});});child.on('exit',code=>finish(Error(token!==serial?'任务已取消':`图像工作进程退出 (${code})，可重试`)));child.postMessage({operation,payload});});
}
function expose(result:any){const files:any={},pyramids:any={};for(const [key,file]of Object.entries(result.files||{})){const id=crypto.randomUUID();images.set(id,file as string);files[key]=`microscope://${id}/image.png`;}
 for(const [key,dataset]of Object.entries(result.pyramids||{})){const id=crypto.randomUUID();datasets.set(id,dataset);const {folder,...descriptor}=dataset as any;pyramids[key]={...descriptor,url:`microscope://${id}`};}return {...result,artifact:result.artifact?{...result.artifact,path:undefined}:undefined,canonical:undefined,files,pyramids};}
const queued:any={open:[],save:[],message:[]};
async function openDialog(options:any){if(testMode&&queued.open.length){const file=queued.open.shift();return {canceled:!file,filePaths:file?[file]:[]};}return dialog.showOpenDialog(win,options);}
async function saveDialog(options:any){if(testMode&&queued.save.length){const file=queued.save.shift();return {canceled:!file,filePath:file||undefined};}return dialog.showSaveDialog(win,options);}
async function messageDialog(options:any){if(testMode&&queued.message.length)return {response:queued.message.shift()};return dialog.showMessageBox(win,options);}
async function sessionSave(data:any){const settings=validateSettings(data?.settings),viewport=validateViewport(data?.viewport);if(!assets.has(data.sourceId)||data.compareId&&!assets.has(data.compareId)||typeof data.allow16!=='boolean'||typeof data.compareAllow16!=='boolean')throw Error('会话材料或转换选择无效');
 const r=await saveDialog({defaultPath:'compression-session.json',filters:[{name:'显微镜会话',extensions:['json']}]});if(r.canceled||!r.filePath)return null;
 const refs=await Promise.all([data.sourceId,...(data.compareId?[data.compareId]:[])].map(async id=>{const a=assets.get(id),bytes=await fs.readFile(a.path);if(sha(bytes)!==a.sha256)throw Error('源文件在导入后已变化，不能保存依赖旧快照的会话。请重新导入。');return {id,relativePath:path.relative(path.dirname(r.filePath),a.path),absolutePath:a.path,byteLength:a.byteLength,modifiedAtMs:a.modifiedAtMs,sha256:a.sha256};}));
 const envelope={schemaVersion:1,appId:APP_ID,documentId:crypto.randomUUID(),createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),assets:refs,data:{...data,settings,viewport,canonicalizationVersion:'srgb8-straight-v2'}};
 const bytes=Buffer.from(JSON.stringify(envelope,null,2)),temp=path.join(root,crypto.randomUUID()+'.json');await fs.writeFile(temp,bytes);await saveArtifact({path:temp,byteLength:bytes.length,sha256:sha(bytes)},r.filePath,[...assets.values()]);return r.filePath;
}
async function sessionOpen(){const r=await openDialog({properties:['openFile'],filters:[{name:'显微镜会话',extensions:['json']}]});if(r.canceled)return null;const stat=await fs.stat(r.filePaths[0]);if(stat.size>1024*1024)throw Error('会话文件过大');const s=JSON.parse(await fs.readFile(r.filePaths[0],'utf8'));
 if(s.schemaVersion!==1||s.appId!==APP_ID||!Array.isArray(s.assets)||s.assets.length<1||s.assets.length>2||typeof s.documentId!=='string')throw Error('不支持的会话版本或应用，未修改原文件');const settings=validateSettings(s.data?.settings),viewport=validateViewport(s.data?.viewport);if(typeof s.data.allow16!=='boolean'||typeof s.data.compareAllow16!=='boolean')throw Error('会话位深选择无效');const restored:any={};
 for(const a of s.assets){if(typeof a.id!=='string'||typeof a.absolutePath!=='string'||a.relativePath&&typeof a.relativePath!=='string'||!/^([0-9a-f]{64})$/.test(a.sha256))throw Error('会话素材引用无效');let file=a.relativePath?path.resolve(path.dirname(r.filePaths[0]),a.relativePath):a.absolutePath,valid=false;
 for(const candidate of [file,a.absolutePath]){try{if(sha(await fs.readFile(candidate))===a.sha256){file=candidate;valid=true;break;}}catch{}}
 if(!valid){const choice=await messageDialog({type:'warning',message:'会话素材缺失或内容已变化',detail:'请选择原素材重新关联。SHA-256 一致才恢复编辑；取消会保留当前工作区。',buttons:['重新关联','取消'],cancelId:1});if(choice.response===1)return null;const picked=await openDialog({properties:['openFile']});if(picked.canceled)return null;file=picked.filePaths[0];}
 const registered=await register(file);if(registered.sha256!==a.sha256)throw Error('重新关联文件的 SHA-256 不一致，编辑未恢复');restored[a.id]=registered;
 }
 if(!restored[s.data.sourceId]||settings.mode==='compare'&&!restored[s.data.compareId])throw Error('会话缺少所需素材');await invalidate();return {data:{...s.data,settings,viewport},source:restored[s.data.sourceId],compare:restored[s.data.compareId]};
}
app.whenReady().then(async()=>{
 const cache=path.join(app.getPath('temp'),'compression-microscope-cache');await fs.mkdir(cache,{recursive:true});
 // Only app-owned marked directories are reclaimed; never touch user-selected paths.
 for(const name of await fs.readdir(cache)){if(!/^session-[0-9a-f-]{36}$/.test(name))continue;const folder=path.join(cache,name);try{if(await fs.readFile(path.join(folder,'.owner'),'utf8')===APP_ID)await fs.rm(folder,{recursive:true,force:true});}catch{}}
 root=path.join(cache,'session-'+crypto.randomUUID());await fs.mkdir(root);await fs.writeFile(path.join(root,'.owner'),APP_ID);
 // 自定义协议的响应必须带 CORS 头：差异/Alpha 显影要在渲染进程里 getImageData 读像素做增益，
 // 画布一旦被判为跨源污染就会抛 SecurityError，整帧渲染中断（表现为切到差异显影后画面死掉）。
 const serve=async(file:string)=>{const res=await net.fetch(pathToFileURL(file).href);const h=new Headers(res.headers);h.set('Access-Control-Allow-Origin','*');h.set('Cross-Origin-Resource-Policy','cross-origin');h.set('Cache-Control','no-store');return new Response(res.body,{status:res.status,headers:h});};
 protocol.handle('microscope',async request=>{try{const u=new URL(request.url);if(images.has(u.hostname)&&u.pathname==='/image.png')return await serve(images.get(u.hostname)!);const d=datasets.get(u.hostname),match=/^\/(\d+)-(\d+)-(\d+)\.png$/.exec(u.pathname);if(!d||!match)return new Response('Missing',{status:404});const [l,x,y]=match.slice(1).map(Number),level=d.levels[l];if(!level||x>=level.cols||y>=level.rows)return new Response('Missing',{status:404});return await serve(path.join(d.folder,`${l}-${x}-${y}.png`));}catch{return new Response('Missing',{status:404});}});
 win=new BrowserWindow({width:1440,height:950,minWidth:850,minHeight:650,show:!testMode,backgroundColor:'#101419',webPreferences:{preload:path.join(__dirname,'../preload/index.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 const handles:any={
 pick:async()=>{const r=await openDialog({properties:['openFile'],filters:[{name:'静态 SDR 图片',extensions:['jpg','jpeg','png','webp']}]});return r.canceled?null:register(r.filePaths[0]);},drop:register,
 cancel:async()=>invalidate(),
 process:async(p:any)=>{const spec=validateSpec(p?.spec);if(!['encode','compare'].includes(p.mode)||!colour(p.background)||typeof p.allow16!=='boolean'||typeof p.compareAllow16!=='boolean')throw Error('处理请求无效');const source=assets.get(p.sourceId),compare=assets.get(p.compareId);if(!source||p.mode==='compare'&&!compare)throw Error('请先导入所需图片');const rev=await invalidate(),dir=await directory(),jobId=crypto.randomUUID();
 if(rev!==revision)return {revision:rev};notify({type:'progress',stage:'排队并检查输入',revision:rev,kind:'process'});
 worker('process',{...p,spec,source:source.snapshot,compare:compare?.snapshot,dir},()=>rev===revision,'process').then(result=>{if(rev!==revision)return;current={...result,revision:rev,jobId,sourceId:p.sourceId,compareId:p.compareId,mode:p.mode,spec,background:p.background};notify({type:'result',revision:rev,result:{...expose(result),jobId},kind:'process'});}).catch(e=>{if(rev===revision)notify({type:'error',revision:rev,code:e.code,message:e.message,kind:'process'});});return {revision:rev};},
 observe:async(p:any)=>{if(!current||p.jobId!==current.jobId||!colour(p.background))throw Error('观察结果已过期');const captured=current,rev=revision,dir=await directory();const r=await worker('observe',{canonical:captured.canonical,background:p.background,dir},()=>current===captured&&revision===rev,'observe');if(current!==captured)throw Error('观察结果已过期');current={...captured,comparison:r.comparison,background:p.background,files:{...captured.files,...r.files},pyramids:{...captured.pyramids,...r.pyramids}};return expose({...r,jobId:captured.jobId});},
 save:async(kind:string,jobId:string,observation:any={})=>{if(!current||current.jobId!==jobId||current.revision!==revision)throw Error('结果已过期，请等待当前参数完成');if(!['artifact','difference','comparison'].includes(kind))throw Error('无效导出类型');if(!colour(observation.background)||!Number.isFinite(observation.gain)||observation.gain<1||observation.gain>64||typeof observation.alpha!=='boolean')throw Error('导出观察参数无效');const captured=current,rev=revision,guard=()=>{if(current?.jobId!==jobId||revision!==rev)throw Error('结果已过期，未提交保存，请生成当前结果后重试');};let file=captured.artifact,report:any=null;
 if(kind!=='artifact'){const dir=await directory();const out=await worker('export',{kind,canonical:captured.canonical,dir,...observation,sourceHash:assets.get(captured.sourceId).sha256,resultHash:captured.artifact.sha256},()=>current?.jobId===jobId&&revision===rev,'export');guard();file=out.artifact;report=out.report;const preview=expose({files:{preview:file.path}}).files.preview;
 const choice=await messageDialog({type:'info',message:kind==='difference'?'导出完整差异图':'导出完整对照图',detail:`${out.width} × ${out.height} px · PNG · ${file.byteLength.toLocaleString()} 字节\n背景 ${observation.background} · 增益 ×${observation.gain} · ${observation.alpha?'独立 alpha':'颜色差异'}\n另存完整图像，并提供参数 JSON 说明。`,buttons:['选择保存位置','取消'],cancelId:1});if(choice.response===1)return {cancelled:true};}
 else{const choice=await messageDialog({type:'info',message:captured.mode==='encode'?'保存完整压缩图片':'另存比较图原字节副本',detail:`${file.format.toUpperCase()} · ${captured.result.width} × ${captured.result.height} px\n${file.byteLength.toLocaleString()} 字节 · 源文件保留\n${captured.sizeSearch&&!captured.sizeSearch.ignored?captured.sizeSearch.satisfied?`体积上限 ${(captured.sizeSearch.cap/1024).toFixed(2)} KiB · 采用质量 ${captured.sizeSearch.quality}\n`:`体积上限 ${(captured.sizeSearch.cap/1024).toFixed(2)} KiB 无法达成，质量已降到 1\n`:''}${captured.mode==='encode'?captured.spec.format==='jpeg'?`透明按背景 ${captured.spec.matte} 合成；保留 sRGB，去除非必要元数据。`:'保留 sRGB，去除非必要元数据。':'副本保留原元数据，未重新压缩。'}`,buttons:['选择保存位置','取消'],cancelId:1});if(choice.response===1)return {cancelled:true};}
 guard();const a=assets.get(captured.sourceId),ext=file.format==='jpeg'?'jpg':file.format,suffix=kind==='artifact'?captured.mode==='encode'?'compressed':'comparison-copy':kind;
 const r=await saveDialog({defaultPath:path.join(path.dirname(a.path),`${path.parse(a.name).name}-${suffix}.${ext}`),filters:[{name:kind==='artifact'?'完整图片':`${kind} · PNG`,extensions:[ext]}]});if(r.canceled||!r.filePath)return {cancelled:true};guard();const record=await saveArtifact(file,r.filePath,[...assets.values()],guard);let reportPath='';if(report){const choice=await messageDialog({type:'question',message:'图片已保存。另存导出参数说明？',detail:'参数 JSON 是独立辅助文件，不改变图片。',buttons:['另存 JSON','跳过'],cancelId:1});if(choice.response===0){const reportSave=await saveDialog({defaultPath:r.filePath+'.json',filters:[{name:'导出说明',extensions:['json']}]});if(!reportSave.canceled&&reportSave.filePath){await saveArtifact(report,reportSave.filePath,[...assets.values()]);reportPath=reportSave.filePath;}}}savedPath=r.filePath;return {...record,path:savedPath,reportPath};},
 openSaved:async(reveal:boolean)=>{if(typeof reveal!=='boolean'||!savedPath)return;if(reveal)shell.showItemInFolder(savedPath);else await shell.openPath(savedPath);},sessionSave,sessionOpen
 };
 for(const [name,fn]of Object.entries(handles))ipcMain.handle(name,safe(fn));
 if(testMode){ipcMain.handle('test:queue',safe(async(data:any)=>{for(const k of ['open','save','message'])if(Array.isArray(data[k]))queued[k].push(...data[k]);return true;}));}
 await win.loadFile(path.join(__dirname,'../renderer/index.html'));
 if(testMode&&process.env.MICROSCOPE_TEST_SCRIPT){const script=require(process.env.MICROSCOPE_TEST_SCRIPT);try{await script({app,win,handles,queued,root,getCurrent:()=>current});app.exit(0);}catch(e){console.error(e);app.exit(1);}}
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{closing=true;serial++;active?.kill();if(root)fs.rm(root,{recursive:true,force:true}).catch(()=>{});});
