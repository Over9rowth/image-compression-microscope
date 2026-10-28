// 体积上限（sizeCap）的自动测试。
//
// 这一组的重点不是"能跑通"，而是三件事必须对齐：
//   1. 搜索阶段量到的字节数 == 最终产物的真实字节数（同一个编码器构造器）；
//   2. 命中上限时，质量确实是"不超上限的最大值"（用 quality+1 实编复核）；
//   3. 上限不可能达成时，必须如实报 satisfied=false，而不是悄悄给个超标的产物。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {run}=require('../src/workers/image.cjs');

const base={format:'jpeg',quality:80,chroma:'4:2:0',compressionLevel:6,lossless:false,matte:'#ffffff',sizeCap:0};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

// 高熵夹具：质量变化能真实反映到字节数上，避免"怎么调都一样大"的假通过。
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sizecap-'));
  const w=160,h=120,raw=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    raw[i]=(x*7+y*13+(x*y)%97)&255;
    raw[i+1]=(x*11+y*3+(x^y))&255;
    raw[i+2]=(x*5+y*17)%251;
    raw[i+3]=255;
  }
  const source=path.join(root,'源图.png');
  await sharp(raw,{raw:{width:w,height:h,channels:4}}).png().toFile(source);
  return {root,source,w,h};
}

let seq=0;
async function once(f,spec){
  const dir=path.join(f.root,'work-'+(++seq));
  await fs.mkdir(dir);
  return run({source:f.source,dir,mode:'encode',spec:{...base,...spec},background:'#ffffff',gain:1});
}

test('S01 无上限时不搜索，按给定质量编码',async()=>{
  const f=await fixture();
  const r=await once(f,{quality:80,sizeCap:0});
  assert.equal(r.sizeSearch,null);
  assert.equal(r.result.width,f.w);
  await fs.rm(f.root,{recursive:true});
});

test('S02 上限命中：产物不超过上限，且搜索字节数与真实产物一致',async()=>{
  const f=await fixture();
  const plain=await once(f,{quality:60});
  const cap=plain.artifact.byteLength;
  const r=await once(f,{quality:60,sizeCap:cap});
  assert.equal(r.sizeSearch.ignored,false);
  assert.equal(r.sizeSearch.satisfied,true,'以质量为 60 的真实体积作为上限，必须能达成');
  assert.equal(r.sizeSearch.byteLength,r.artifact.byteLength,'搜索量到的字节数必须等于真实产物字节数');
  assert.ok(r.artifact.byteLength<=cap);
  assert.ok(r.sizeSearch.quality>=1&&r.sizeSearch.quality<=100);
  await fs.rm(f.root,{recursive:true});
});

test('S03 命中时质量确为"不超上限的最大值"（quality+1 实编越界）',async()=>{
  const f=await fixture();
  const plain=await once(f,{quality:60});
  const cap=plain.artifact.byteLength;
  const r=await once(f,{quality:60,sizeCap:cap});
  assert.equal(r.sizeSearch.monotonic,true,'质量+1 必须真的超过上限，否则二分结果不是最大值');
  if(r.sizeSearch.quality<100){
    const above=await once(f,{quality:r.sizeSearch.quality+1});
    assert.ok(above.artifact.byteLength>cap,`质量 ${r.sizeSearch.quality+1} 的 ${above.artifact.byteLength} 字节应当超过上限 ${cap}`);
  }
  await fs.rm(f.root,{recursive:true});
});

test('S04 上限过小时如实报告无法达成，不伪造达标',async()=>{
  const f=await fixture();
  const r=await once(f,{quality:80,sizeCap:1});
  assert.equal(r.sizeSearch.satisfied,false);
  assert.equal(r.sizeSearch.quality,1,'无法达成时应退到最低质量');
  assert.ok(r.artifact.byteLength>1);
  assert.equal(r.sizeSearch.byteLength,r.artifact.byteLength);
  await fs.rm(f.root,{recursive:true});
});

test('S05 PNG 上限被明确忽略并给出原因',async()=>{
  const f=await fixture();
  const r=await once(f,{format:'png',sizeCap:50*1024});
  assert.equal(r.sizeSearch.ignored,true);
  assert.equal(r.sizeSearch.satisfied,null);
  assert.match(r.sizeSearch.reason,/PNG/);
  await fs.rm(f.root,{recursive:true});
});

test('S06 WebP 无损上限被明确忽略并给出原因',async()=>{
  const f=await fixture();
  const r=await once(f,{format:'webp',lossless:true,sizeCap:50*1024});
  assert.equal(r.sizeSearch.ignored,true);
  assert.match(r.sizeSearch.reason,/无损/);
  await fs.rm(f.root,{recursive:true});
});

test('S07 同一上限重复搜索给出相同质量与相同产物字节（确定性）',async()=>{
  const f=await fixture();
  const plain=await once(f,{quality:70});
  const cap=Math.floor(plain.artifact.byteLength*0.8);
  const a=await once(f,{quality:70,sizeCap:cap});
  const b=await once(f,{quality:70,sizeCap:cap});
  assert.equal(a.sizeSearch.quality,b.sizeSearch.quality);
  assert.equal(a.artifact.sha256,b.artifact.sha256);
  await fs.rm(f.root,{recursive:true});
});

test('S08 搜索不修改源文件',async()=>{
  const f=await fixture();
  const before=sha(await fs.readFile(f.source));
  const plain=await once(f,{quality:50});
  await once(f,{quality:50,sizeCap:plain.artifact.byteLength});
  assert.equal(sha(await fs.readFile(f.source)),before);
  await fs.rm(f.root,{recursive:true});
});
