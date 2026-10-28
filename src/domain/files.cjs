const fs=require('node:fs/promises');const crypto=require('node:crypto');const path=require('node:path');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function identity(file){try{const s=await fs.stat(file,{bigint:true});return `${s.dev}:${s.ino}`;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function protect(target,sources){const id=await identity(target);const normalized=path.resolve(target).toLowerCase();for(const source of sources){const src=typeof source==='string'?{path:source}:source;const live=await identity(src.path);if(path.resolve(src.path).toLowerCase()===normalized||(id&&(id===live||id===src.identity)))throw Error('不能覆盖原素材或其链接/硬链接别名，请另选文件名');}}
async function saveArtifact(artifact,target,sources,guard=()=>{}){
  await protect(target,sources);guard();const bytes=await fs.readFile(artifact.path);if(bytes.length!==artifact.byteLength||sha(bytes)!==artifact.sha256)throw Error('待保存产物已变化，请重新生成');
  const temporary=path.join(path.dirname(target),`.compression-${crypto.randomUUID()}.part`);
  try{const f=await fs.open(temporary,'wx');try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}const check=await fs.readFile(temporary);if(sha(check)!==artifact.sha256)throw Error('落盘校验失败');await protect(target,sources);guard();await fs.rename(temporary,target);const saved=await fs.readFile(target);if(saved.length!==bytes.length||sha(saved)!==artifact.sha256)throw Error('保存后校验失败');return {byteLength:saved.length,sha256:sha(saved)};}finally{await fs.rm(temporary,{force:true});}
}
module.exports={identity,saveArtifact,sha,protect};
