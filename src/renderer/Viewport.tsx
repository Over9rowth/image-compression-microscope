import React,{useState,useEffect,useRef} from 'react';
export function Viewport({result,view,gain,alpha,zoom,pan,split,setPan,setZoom,showBaseline,grid,onPointer}:any){
 const ref=useRef<HTMLCanvasElement>(null),drag=useRef<any>(null),cache=useRef<Map<string,any>>(new Map()),gainCache=useRef<Map<string,any>>(new Map()),drawRef=useRef(()=>{});
 useEffect(()=>{cache.current.clear();gainCache.current.clear();},[result?.jobId]);
 useEffect(()=>{
 const c=ref.current!;let live=true,scheduled=false;
 const schedule=()=>{if(!live||scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;if(live)render();});};
 const getTile=(url:string)=>{const cached=cache.current.get(url);if(cached)return cached.image;const entry:any={};cache.current.set(url,entry);const image=new Image();image.crossOrigin='anonymous';image.src=url;image.onload=()=>{entry.image=image;schedule();};image.onerror=()=>{entry.error=true;};if(cache.current.size>160){const first=cache.current.keys().next().value;if(first)cache.current.delete(first);}return null;};
 const render=()=>{const bounds=c.getBoundingClientRect(),dpr=devicePixelRatio;c.width=Math.round(bounds.width*dpr);c.height=Math.round(bounds.height*dpr);const ctx=c.getContext('2d')!;ctx.fillStyle='#111820';ctx.fillRect(0,0,c.width,c.height);if(!result)return;
 const area=view==='side'?c.width/2:c.width,originX=area/2-result.source.width*zoom/2+pan.x*dpr,originY=c.height/2-result.source.height*zoom/2+pan.y*dpr;
 const panel=(key:string,offset:number,clipLeft:number=offset,clipWidth:number=area)=>{const p=result.pyramids?.[key];if(!p)return;ctx.save();ctx.beginPath();ctx.rect(clipLeft,0,clipWidth,c.height);ctx.clip();const checker=12*dpr;for(let y=0;y<c.height;y+=checker)for(let x=offset;x<offset+area;x+=checker){ctx.fillStyle=(Math.floor((x-offset)/checker)+Math.floor(y/checker))%2?'#29313b':'#202731';ctx.fillRect(x,y,checker,checker);}const level=Math.min(p.levels.length-1,Math.max(0,Math.floor(Math.log2(1/zoom)))),l=p.levels[level],factor=zoom/l.scale,tile=p.tileSize;
 const minX=Math.max(0,Math.floor((-originX)/factor/tile)),maxX=Math.min(l.cols-1,Math.floor((area-originX)/factor/tile)),minY=Math.max(0,Math.floor(-originY/factor/tile)),maxY=Math.min(l.rows-1,Math.floor((c.height-originY)/factor/tile));
 ctx.imageSmoothingEnabled=zoom<1;
 for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const url=`${p.url}/${level}-${x}-${y}.png`,img=getTile(url);if(!img)continue;let image:any=img;if((key==='difference'||key==='alpha')&&gain!==1){const gk=url+'@'+gain,hit=gainCache.current.get(gk);if(hit)image=hit;else{try{const off=document.createElement('canvas');off.width=img.width;off.height=img.height;const oc=off.getContext('2d')!;oc.drawImage(img,0,0);const values=oc.getImageData(0,0,off.width,off.height);for(let i=0;i<values.data.length;i+=4)for(let k=0;k<3;k++)values.data[i+k]=Math.min(255,values.data[i+k]*gain);oc.putImageData(values,0,0);image=off;if(gainCache.current.size>120){const first=gainCache.current.keys().next().value;if(first)gainCache.current.delete(first);}gainCache.current.set(gk,off);}catch{/* 画布被污染或内存不足时退回原始瓦片，不让整帧渲染中断 */}}}ctx.drawImage(image,offset+originX+x*tile*factor,originY+y*tile*factor,img.width*factor,img.height*factor);}
 if(grid&&zoom>=8){ctx.strokeStyle='#7c99aa55';ctx.lineWidth=1;for(let x=Math.max(0,Math.floor(-originX/zoom));originX+x*zoom<area;x++){ctx.beginPath();ctx.moveTo(offset+originX+x*zoom,0);ctx.lineTo(offset+originX+x*zoom,c.height);ctx.stroke();}for(let y=Math.max(0,Math.floor(-originY/zoom));originY+y*zoom<c.height;y++){ctx.beginPath();ctx.moveTo(offset,originY+y*zoom);ctx.lineTo(offset+area,originY+y*zoom);ctx.stroke();}}
 ctx.restore();};
 if(view==='side'){panel(showBaseline?'baseline':'source',0);panel('result',area);ctx.fillStyle='#526171';ctx.fillRect(area-1,0,2,c.height);}else if(view==='split'){panel(showBaseline?'baseline':'source',0);panel('result',0,c.width*split/100,c.width*(1-split/100));ctx.fillStyle='#79d8c8';ctx.fillRect(c.width*split/100,0,2,c.height);}else panel(alpha?'alpha':'difference',0);
 ctx.fillStyle='#a7b5c4';ctx.font=`${12*dpr}px sans-serif`;ctx.fillText(view==='side'?`${showBaseline?'合成基准':'原图'}                                          结果 / 比较图`:view==='difference'?`${alpha?'Alpha':'颜色'}差异 ×${gain}`:'原图 / 结果分割',16*dpr,24*dpr);
 };drawRef.current=render;render();const ro=new ResizeObserver(schedule);ro.observe(c);return()=>{live=false;ro.disconnect();};
 },[result,view,gain,alpha,zoom,pan,split,showBaseline,grid]);
 // 滚轮缩放以光标为锚点：保持光标下的那个图像点不动，而不是围绕画布中心缩放。
 // 推导：图像像素 ix 在画布上的设备像素位置 = originX + ix*zoom，
 // 其中 originX = area/2 − W*zoom/2 + pan.x*dpr。要求缩放前后 ix 不变，即可解出新的 pan。
 const wheel=(e:any)=>{
  const z0=zoom,z1=Math.max(.03125,Math.min(64,z0*(e.deltaY>0?.8:1.25)));
  if(z1===z0)return;
  const c=ref.current;if(!c){setZoom(z1);return;}
  const r=c.getBoundingClientRect(),dpr=devicePixelRatio,side=view==='side';
  const areaCss=side?r.width/2:r.width,areaDev=Math.round(r.width*dpr)/(side?2:1),hDev=Math.round(r.height*dpr);
  const wrap=(v:number)=>((v%areaCss)+areaCss)%areaCss;
  const cx=wrap(e.clientX-r.left)*dpr,cy=(e.clientY-r.top)*dpr;
  if(!result){setZoom(z1);return;}
  const W=result.source.width,H=result.source.height;
  const originX=areaDev/2-W*z0/2+pan.x*dpr,originY=hDev/2-H*z0/2+pan.y*dpr;
  const ix=(cx-originX)/z0,iy=(cy-originY)/z0;
  setPan({x:(cx-ix*z1-areaDev/2+W*z1/2)/dpr,y:(cy-iy*z1-hDev/2+H*z1/2)/dpr});
  setZoom(z1);
 };
 return <canvas ref={ref} aria-label="图像同步观察区" onPointerDown={e=>{drag.current={x:e.clientX,y:e.clientY,pan};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(drag.current)setPan({x:drag.current.pan.x+e.clientX-drag.current.x,y:drag.current.pan.y+e.clientY-drag.current.y});const r=e.currentTarget.getBoundingClientRect(),area=view==='side'?r.width/2:r.width;const local=(e.clientX-r.left)%area;onPointer({x:Math.floor((local-area/2-pan.x)*devicePixelRatio/zoom+(result?.source.width||0)/2),y:Math.floor((e.clientY-r.top-r.height/2-pan.y)*devicePixelRatio/zoom+(result?.source.height||0)/2)});}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null} onWheel={wheel}/>;
}
