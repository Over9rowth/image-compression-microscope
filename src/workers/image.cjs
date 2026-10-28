// All full-resolution image operations stay in a disposable utility process.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
sharp.cache(false); sharp.concurrency(1);
const MAX_PIXELS = 24_000_000;
const TILE = 512;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const linear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const lut = Array.from({length:256},(_,i)=>linear(i/255));
function matteColour(matte) { if(!/^#[a-f0-9]{6}$/i.test(matte))throw Error('背景色无效'); return [1,3,5].map(i=>lut[parseInt(matte.slice(i,i+2),16)]); }
function pixel(raw,i,c,m) {return Math.round(255*srgb(raw[i+3]/255*lut[raw[i+c]]+(1-raw[i+3]/255)*m[c]));}
function composite(raw,matte) { const m=matteColour(matte),out=Buffer.alloc(raw.length);for(let i=0;i<raw.length;i+=4){for(let c=0;c<3;c++)out[i+c]=pixel(raw,i,c,m);out[i+3]=255;}return out; }
function inspectHeader(bytes,meta) {
  if(!['jpeg','png','webp'].includes(meta.format))throw Error('仅支持静态 JPEG、PNG、WebP SDR 图片');
  if((meta.pages||1)>1||meta.delay?.length)throw Error('动画或多页图片不支持，请另选静态 SDR 图片');
  if(meta.gainMap?.image || meta.space==='scrgb' || ['float','double'].includes(meta.depth))throw Error('检测到 HDR / gain-map，当前版本不转换');
  // Reject HDR metadata even where a decoder returns only the SDR base image.
  for(const marker of ['hdrgm:','HDRGainMap','urn:com:apple:photo:2020:aux:hdrgainmap','MPF\0'])if(bytes.includes(Buffer.from(marker)))throw Error('检测到 HDR / 多图内容，当前版本不转换');
  if(meta.format==='png')for(let o=8;o+12<=bytes.length;){const n=bytes.readUInt32BE(o);if(n>bytes.length-o-12)throw Error('PNG 数据块损坏');const type=bytes.toString('ascii',o+4,o+8);if(['cICP','mDCv','cLLi'].includes(type))throw Error('PNG 含 HDR/扩展色彩声明，当前版本不转换');if(type==='acTL')throw Error('动画 PNG 不支持');o+=n+12;}
  if(meta.space==='cmyk'&&!meta.icc)throw Error('无 ICC 的 CMYK 图片无法可靠解释');
  if(meta.icc&&(meta.icc.length<128||meta.icc.toString('ascii',36,40)!=='acsp'))throw Error('ICC 配置无效，无法解释颜色');
  if(!meta.width||!meta.height||meta.width*meta.height>MAX_PIXELS)throw Error(`图像 ${meta.width||'?'} × ${meta.height||'?'} 超过 ${MAX_PIXELS/1e6} 百万像素保护上限，请自行选择较小材料`);
}
async function canonical(file,allow16=false) {
  const bytes=await fs.readFile(file);
  const meta=await sharp(bytes,{failOn:'warning',limitInputPixels:MAX_PIXELS}).metadata(); inspectHeader(bytes,meta);
  if(meta.depth==='ushort'&&!allow16){const e=Error('16 位 PNG 需要明确选择生成 8 位分析副本');e.code='NEEDS_8BIT';throw e;}
  if(!['uchar','ushort'].includes(meta.depth))throw Error('当前仅支持 8 位或明确转换的 16 位 SDR 图片');
  const {data,info}=await sharp(bytes,{failOn:'warning',limitInputPixels:MAX_PIXELS}).rotate().withIccProfile('srgb').toColourspace('srgb').ensureAlpha().raw({depth:'uchar'}).toBuffer({resolveWithObject:true});
  return {raw:data,width:info.width,height:info.height,meta:{format:meta.format,depth:meta.depth,hasAlpha:meta.hasAlpha,orientation:meta.orientation||1,colour:meta.icc?'ICC → sRGB':'无 ICC，按 sRGB 解释',analysis16:meta.depth==='ushort',estimatedWorkingBytes:meta.width*meta.height*4*6},sha256:hash(bytes),byteLength:bytes.length};
}
function stats(a,b,background,gain=1,alpha=false) {
  if(a.width!==b.width||a.height!==b.height)return {comparable:false,reason:'规范尺寸不同，仅可并排观察；不重采样'};
  const m=matteColour(background);let sum=0,max=0,changed=0,asum=0,amax=0,achanged=0;
  const diff=Buffer.alloc(a.raw.length),alphaDiff=Buffer.alloc(a.raw.length);
  // Blocked accumulation bounds the arithmetic working set; every full-resolution pixel contributes.
  for(let start=0;start<a.raw.length;start+=1024*1024)for(let i=start;i<Math.min(start+1024*1024,a.raw.length);i+=4){let any=false;const ad=Math.abs(a.raw[i+3]-b.raw[i+3]);asum+=ad;amax=Math.max(amax,ad);if(ad)achanged++;for(let c=0;c<3;c++){const d=Math.abs(pixel(a.raw,i,c,m)-pixel(b.raw,i,c,m));sum+=d;max=Math.max(max,d);any||=d!==0;diff[i+c]=Math.min(255,(alpha?ad:d)*gain);alphaDiff[i+c]=Math.min(255,ad*gain);}if(any)changed++;diff[i+3]=alphaDiff[i+3]=255;}
  const n=a.width*a.height;return {comparable:true,mae:sum/n/3,max,changed:changed/n,alphaMae:asum/n,alphaMax:amax,alphaChanged:achanged/n,diff,alphaDiff};
}
const rawOptions=(w,h)=>({raw:{width:w,height:h,channels:4}});
async function png(raw,w,h) {return sharp(raw,rawOptions(w,h)).png().toBuffer();}
async function pyramid(raw,w,h,dir,name) {
  const folder=path.join(dir,name);await fs.mkdir(folder,{recursive:true});const levels=[];let scale=1;
  while(true){const width=Math.max(1,Math.ceil(w*scale)),height=Math.max(1,Math.ceil(h*scale));const level=levels.length;
    const resized=scale===1?raw:await sharp(raw,rawOptions(w,h)).resize(width,height,{kernel:'lanczos3'}).raw().toBuffer();
    const cols=Math.ceil(width/TILE),rows=Math.ceil(height/TILE);
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++)await sharp(resized,rawOptions(width,height)).extract({left:x*TILE,top:y*TILE,width:Math.min(TILE,width-x*TILE),height:Math.min(TILE,height-y*TILE)}).png().toFile(path.join(folder,`${level}-${x}-${y}.png`));
    levels.push({width,height,cols,rows,scale});if(width<=TILE&&height<=TILE)break;scale/=2;
  }
  return {folder,width:w,height:h,tileSize:TILE,levels};
}
async function writeRaw(image,dir,name){const file=path.join(dir,name+'.rgba');await fs.writeFile(file,image.raw);return {file,width:image.width,height:image.height};}
async function readRaw(desc){return {...desc,raw:await fs.readFile(desc.file)};}
async function describeArtifact(file,format){const bytes=await fs.readFile(file);return {path:file,sha256:hash(bytes),byteLength:bytes.length,format};}
async function observe(p,stage=()=>{}) {
  stage('计算固定背景下的全图统计');const a=await readRaw(p.canonical.baseline),b=await readRaw(p.canonical.result);
  const comparison=stats(a,b,p.background,1,false);const files={},pyramids={};
  if(comparison.comparable){for(const [name,raw]of [['difference',comparison.diff],['alpha',comparison.alphaDiff]]){const file=path.join(p.dir,name+'.png');await fs.writeFile(file,await png(raw,a.width,a.height));files[name]=file;pyramids[name]=await pyramid(raw,a.width,a.height,p.dir,name);}}
  delete comparison.diff;delete comparison.alphaDiff;return {comparison,files,pyramids,background:p.background};
}
async function run(p,stage=()=>{}) {
  stage('检查方向、位深与色彩并规范化原图');const a=await canonical(p.source,p.allow16);let b,artifact,baseline=a,sizeSearch=null;
  if(p.mode==='encode'){
    if(p.spec.format==='jpeg')baseline={...a,raw:composite(a.raw,p.spec.matte)};
    // 同一个编码器构造器既用于体积搜索也用于最终产物，保证"搜到的字节数"就是"产物的字节数"。
    const encodeAt=quality=>{let enc=sharp(baseline.raw,rawOptions(a.width,a.height)).withIccProfile('srgb');
      if(p.spec.format==='jpeg')enc=enc.jpeg({quality,chromaSubsampling:p.spec.chroma});
      else if(p.spec.format==='png')enc=enc.png({compressionLevel:p.spec.compressionLevel,palette:false});
      else enc=enc.webp({quality,lossless:p.spec.lossless,alphaQuality:100,exact:true});
      return enc;};
    const lossy=p.spec.format==='jpeg'||(p.spec.format==='webp'&&!p.spec.lossless);
    const cap=Number.isInteger(p.spec.sizeCap)?p.spec.sizeCap:0;
    let quality=p.spec.quality,bytes;
    if(cap>0&&lossy){
      // 体积上限：在 1—100 里二分找"不超过上限的最大质量"。质量→体积不是严格单调，
      // 所以命中后再实编一次并复核 quality+1 是否确实越界，不靠假设。
      stage('按体积上限搜索最高可用质量');
      let lo=1,hi=100,best=null,attempts=0;
      while(lo<=hi){const mid=(lo+hi)>>1,size=(await encodeAt(mid).toBuffer()).length;attempts++;if(size<=cap){best={quality:mid,byteLength:size};lo=mid+1;}else hi=mid-1;}
      quality=best?best.quality:1;
      stage('编码完整图片');bytes=await encodeAt(quality).toBuffer();attempts++;
      const actual=bytes.length,satisfied=actual<=cap;
      let monotonic=true;
      if(satisfied&&quality<100){const next=(await encodeAt(quality+1).toBuffer()).length;attempts++;monotonic=next>cap;}
      sizeSearch={cap,satisfied,quality,byteLength:actual,attempts,monotonic,ignored:false};
    }else{
      stage('编码完整图片');bytes=await encodeAt(quality).toBuffer();
      if(cap>0)sizeSearch={cap,satisfied:null,quality,byteLength:bytes.length,attempts:1,ignored:true,reason:p.spec.format==='png'?'PNG 是无损格式，压缩级别只小幅改变体积，无法逼近目标':'WebP 无损没有可调画质，无法逼近目标'};
    }
    const file=path.join(p.dir,'artifact.'+p.spec.format);await fs.writeFile(file,bytes,{flag:'wx'});artifact=await describeArtifact(file,p.spec.format);
    stage('从同一编码产物重新解码');b=await canonical(file,true);
  }else{
    stage('规范化比较图');b=await canonical(p.compare,p.compareAllow16);
    const file=path.join(p.dir,'comparison-copy.'+b.meta.format);await fs.copyFile(p.compare,file);artifact=await describeArtifact(file,b.meta.format);
  }
  const canonicalFiles={source:await writeRaw(a,p.dir,'source'),baseline:await writeRaw(baseline,p.dir,'baseline'),result:await writeRaw(b,p.dir,'result')};
  const pyramids={};const files={};for(const [name,image]of [['source',a],['baseline',baseline],['result',b]]){stage(`构建${name==='source'?'原图':name==='result'?'结果':'合成基准'}观察瓦片`);pyramids[name]=await pyramid(image.raw,image.width,image.height,p.dir,name);const file=path.join(p.dir,name+'.png');await fs.writeFile(file,await png(image.raw,image.width,image.height));files[name]=file;}
  const observation=await observe({...p,canonical:canonicalFiles},stage);
  return {source:{width:a.width,height:a.height,meta:a.meta,sha256:a.sha256,byteLength:a.byteLength},result:{width:b.width,height:b.height,meta:b.meta},...observation,artifact,sizeSearch,canonical:canonicalFiles,files:{...files,...observation.files},pyramids:{...pyramids,...observation.pyramids},encoderVersion:JSON.stringify(sharp.versions),canonicalizationVersion:'srgb8-straight-v2'};
}
async function exportImage(p,stage=()=>{}) {
  let raw,w,h;stage('构建完整辅助导出');
  if(p.kind==='difference'){
    const a=await readRaw(p.canonical.baseline),b=await readRaw(p.canonical.result);const s=stats(a,b,p.background,p.gain,p.alpha);if(!s.comparable)throw Error(s.reason);raw=s.diff;w=a.width;h=a.height;
  }else{
    const a=await readRaw(p.canonical.source),b=await readRaw(p.canonical.result);const gap=24,caption=64;w=a.width+b.width+gap;h=Math.max(a.height,b.height)+caption;
    if(w*h>MAX_PIXELS*2.1)throw Error('对照图超出资源限制');
    const label=Buffer.from(`<svg width="${w}" height="${caption}"><rect width="100%" height="100%" fill="#101820"/><text x="16" y="38" font-size="20" fill="#dce4ed">SOURCE ${a.width}x${a.height}</text><text x="${a.width+gap+16}" y="38" font-size="20" fill="#79d8c8">RESULT ${b.width}x${b.height}</text></svg>`);
    const out=await sharp({create:{width:w,height:h,channels:4,background:'#101820'}}).composite([{input:await png(a.raw,a.width,a.height),left:0,top:caption},{input:await png(b.raw,b.width,b.height),left:a.width+gap,top:caption},{input:label,left:0,top:0}]).raw().toBuffer();raw=out;
  }
  const file=path.join(p.dir,p.kind+'.png');await fs.writeFile(file,await sharp(raw,rawOptions(w,h)).withIccProfile('srgb').png().toBuffer());
  const report={schemaVersion:1,kind:p.kind,width:w,height:h,background:p.background,gain:p.gain,alpha:p.alpha,metricUnits:'0-255 sRGB channel values; independent alpha',canonicalizationVersion:'srgb8-straight-v2',sourceHash:p.sourceHash,resultHash:p.resultHash};
  const reportFile=file+'.json';await fs.writeFile(reportFile,JSON.stringify(report,null,2));return {artifact:await describeArtifact(file,'png'),report:await describeArtifact(reportFile,'json'),width:w,height:h};
}
module.exports={canonical,composite,stats,png,run,observe,exportImage,hash,inspectHeader,MAX_PIXELS};
if(require.main===module){const send=m=>process.parentPort?process.parentPort.postMessage(m):process.send(m);const receive=async message=>{try{const stage=s=>send({type:'progress',stage:s});const op=message.operation||'process';const result=await(op==='observe'?observe(message.payload,stage):op==='export'?exportImage(message.payload,stage):run(message.payload,stage));send({type:'result',result});}catch(e){send({type:'error',message:e.message,code:e.code||'IMAGE_FAILED'});}};if(process.parentPort)process.parentPort.on('message',e=>receive(e.data));else process.on('message',receive);}
