// 实机冒烟驱动：由主进程在 MICROSCOPE_TEST=1 且 MICROSCOPE_TEST_SCRIPT 指向本文件时加载。
// 直接调用真实 handles（与 preload 暴露的同一组函数），走真实 utilityProcess worker、
// 对话框队列与另存校验；并核验渲染进程收到真实结果事件后更新了界面。
// 2026-10-28 扩展：EXIF 1—8 方向端到端对照、辅助导出（差异/对照图+参数JSON）、比较图原字节副本。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 EXIF APP1（TIFF II*，IFD0 单条 Orientation SHORT），手工构造因 sharp.withExif 无法写入该标签。
function exifApp1(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  const e = 10;
  tiff.writeUInt16LE(0x0112, e); tiff.writeUInt16LE(3, e + 2); tiff.writeUInt32LE(1, e + 4);
  tiff.writeUInt16LE(orientation, e + 8); tiff.writeUInt16LE(0, e + 10);
  tiff.writeUInt32LE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4 + body.length);
  app1.writeUInt16BE(0xffe1); app1.writeUInt16BE(body.length + 2, 2);
  body.copy(app1, 4);
  return app1;
}

module.exports = async function smoke({ app, win, handles, queued, getCurrent }) {
  const events = [];
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...rest) => {
    if (channel === 'job') events.push(rest[0]);
    return origSend(channel, ...rest);
  };

  // 1. 渲染进程存活与挂载检查
  const page = JSON.parse(await win.webContents.executeJavaScript(
    'JSON.stringify({api:!!window.microscope, mounted:!!(document.querySelector("#root")&&document.querySelector("#root").children.length), title:document.title})'
  ));
  if (!page.api || !page.mounted) throw Error(`渲染进程异常: ${JSON.stringify(page)}`);
  console.log(`[smoke] renderer ok: api=${page.api} mounted=${page.mounted} title="${page.title}"`);

  // 2. 夹具：60×30 渐变 + 透明（PNG），EXIF 方向用 JPEG 渐变
  const width = 600, height = 400;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    raw[i] = Math.round(255 * x / width);
    raw[i + 1] = Math.round(255 * y / height);
    raw[i + 2] = Math.round(255 - 255 * x / width);
    raw[i + 3] = Math.round(140 + 115 * x / width);
  }
  const fixture = path.join(os.tmpdir(), `microscope-smoke-${Date.now()}.png`);
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(fixture);
  const fixtureSha = sha(await fs.readFile(fixture));

  // 3. EXIF 1—8 方向端到端：应用 compare 模式（EXIF 原件 vs sharp 自动转正基准）应几乎无差异
  const small = { width: 60, height: 30 };
  const sraw = Buffer.alloc(60 * 30 * 4);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) {
    const i = (y * 60 + x) * 4;
    sraw[i] = Math.round(255 * x / 59); sraw[i + 1] = Math.round(255 * y / 29); sraw[i + 2] = 128; sraw[i + 3] = 255;
  }
  const baseJpeg = await sharp(sraw, { raw: { width: 60, height: 30, channels: 4 } }).jpeg({ quality: 92 }).toBuffer();
  for (let o = 1; o <= 8; o++) {
    const withExif = Buffer.concat([baseJpeg.subarray(0, 2), exifApp1(o), baseJpeg.subarray(2)]);
    const meta = await sharp(withExif).metadata();
    if (meta.orientation !== o) throw Error(`EXIF 夹具方向 ${o} 回读 ${meta.orientation}`);
    const oriented = await sharp(withExif).rotate().png().toBuffer(); // sharp 自动转正基准
    const p1 = path.join(os.tmpdir(), `smoke-exif-${o}-a.jpg`);
    const p2 = path.join(os.tmpdir(), `smoke-exif-${o}-b.png`);
    await fs.writeFile(p1, withExif); await fs.writeFile(p2, oriented);
    const a = await handles.drop(p1), b = await handles.drop(p2);
    const rev = await handles.process({ sourceId: a.id, compareId: b.id, mode: 'compare',
      spec: { format: 'jpeg', quality: 80, chroma: '4:4:4', compressionLevel: 6, lossless: false, matte: '#ffffff' },
      background: '#ffffff', allow16: false, compareAllow16: false });
    let cur = null;
    for (let t = 0; t < 200 && !cur; t++) { await sleep(100); cur = getCurrent(); }
    if (!cur) throw Error(`EXIF 方向 ${o}: compare 未完成`);
    const cmp = cur.comparison;
    if (!cmp.comparable) throw Error(`EXIF 方向 ${o}: 不可比 ${cmp.reason || ''}`);
    if (cmp.mae > 5) throw Error(`EXIF 方向 ${o}: 与自动转正基准差异过大 mae=${cmp.mae.toFixed(2)} max=${cmp.max}`);
    console.log(`[smoke] EXIF 方向 ${o}: 规范化 ${cur.source.width}×${cur.source.height} · 方向${cur.source.meta.orientation} · 对照 mae=${cmp.mae.toFixed(3)} max=${cmp.max}`);
  }

  // 4. 真实导入 + 编码
  const asset = await handles.drop(fixture);
  console.log(`[smoke] imported ${asset.name} (${asset.byteLength} B, sha ${asset.sha256.slice(0, 12)}…)`);
  const rev = await handles.process({
    sourceId: asset.id, mode: 'encode',
    spec: { format: 'jpeg', quality: 72, chroma: '4:4:4', compressionLevel: 6, lossless: false, matte: '#102030' },
    background: '#ffffff', allow16: false, compareAllow16: false,
  });
  console.log(`[smoke] process accepted revision=${rev.revision}`);
  let current = null;
  for (let t = 0; t < 300 && !current; t++) { await sleep(100); current = getCurrent(); }
  if (!current) {
    const err = events.filter((e) => e.type === 'error').pop();
    throw Error(`编码未在 30s 内完成: ${err ? `${err.code || ''} ${err.message}` : '无结果事件'}`);
  }
  if (current.jobId == null || current.artifact?.byteLength <= 0 || current.artifact.format !== 'jpeg')
    throw Error(`产物异常: ${JSON.stringify({ jobId: current.jobId, artifact: current.artifact && { byteLength: current.artifact.byteLength, format: current.artifact.format } })}`);
  if (current.result.width !== width || current.result.height !== height)
    throw Error(`尺寸异常: ${current.result.width}x${current.result.height}`);
  console.log(`[smoke] encoded jpeg ${width}x${height} artifact=${current.artifact.byteLength} B jobId=${current.jobId.slice(0, 8)}…`);

  // 5. 渲染进程必须收到真实结果事件并更新状态文案
  let domOk = false, domText = '';
  for (let t = 0; t < 50 && !domOk; t++) {
    await sleep(100);
    domText = await win.webContents.executeJavaScript('document.body.innerText');
    domOk = domText.includes('完整结果已生成');
  }
  if (!domOk) throw Error('渲染进程未收到/未呈现结果事件');
  console.log('[smoke] renderer received real result event and updated status');

  // 6. 真实另存（队列化确认与保存对话框）
  const outPath = path.join(os.tmpdir(), `microscope-smoke-saved-${Date.now()}.jpg`);
  queued.message.push(0);
  queued.save.push(outPath);
  const record = await handles.save('artifact', current.jobId, { background: '#ffffff', gain: 8, alpha: false });
  if (!record || record.cancelled) throw Error(`保存被取消: ${JSON.stringify(record)}`);
  const saved = await fs.readFile(outPath);
  if (saved.length !== record.byteLength || sha(saved) !== record.sha256)
    throw Error('保存文件与产物哈希不一致');
  if (sha(await fs.readFile(fixture)) !== fixtureSha)
    throw Error('源夹具在保存后被修改');
  console.log(`[smoke] saved ${outPath} (${record.byteLength} B, sha ${record.sha256.slice(0, 12)}…) source unchanged`);

  // 7. 辅助导出：差异图 + 参数 JSON（真实 worker export + 队列化两级对话框）
  const diffPng = path.join(os.tmpdir(), `microscope-smoke-diff-${Date.now()}.png`);
  const diffJson = diffPng + '.json';
  queued.message.push(0, 0); queued.save.push(diffPng, diffJson);
  const diffRec = await handles.save('difference', current.jobId, { background: '#ffffff', gain: 8, alpha: false });
  if (!diffRec || diffRec.cancelled || !diffRec.path) throw Error(`差异图导出异常: ${JSON.stringify(diffRec)}`);
  const diffMeta = await sharp(diffPng).metadata();
  if (diffMeta.width !== width || diffMeta.height !== height || diffMeta.format !== 'png')
    throw Error(`差异图尺寸/格式异常: ${diffMeta.width}x${diffMeta.height} ${diffMeta.format}`);
  const savedReport = JSON.parse(await fs.readFile(diffJson, 'utf8'));
  if (savedReport.gain !== 8 || savedReport.background !== '#ffffff')
    throw Error(`参数 JSON 与实际导出参数不一致: ${JSON.stringify(savedReport).slice(0, 200)}`);
  console.log(`[smoke] difference export ok (${diffRec.byteLength} B) + 参数JSON一致`);

  // 8. 对照图导出
  const cmpPng = path.join(os.tmpdir(), `microscope-smoke-cmp-${Date.now()}.png`);
  queued.message.push(0, 0); queued.save.push(cmpPng, cmpPng + '.json');
  const cmpRec = await handles.save('comparison', current.jobId, { background: '#ffffff', gain: 8, alpha: false });
  if (!cmpRec || cmpRec.cancelled) throw Error(`对照图导出异常: ${JSON.stringify(cmpRec)}`);
  const cmpMeta = await sharp(cmpPng).metadata();
  if (cmpMeta.format !== 'png' || cmpMeta.height < height) throw Error(`对照图异常: ${cmpMeta.width}x${cmpMeta.height}`);
  console.log(`[smoke] comparison export ok (${cmpRec.byteLength} B, ${cmpMeta.width}x${cmpMeta.height})`);

  // 9. 已有图片比较模式的另存 = 原字节副本
  const assetB = await handles.drop(fixture); // 同一文件作为第二素材
  const rev2 = await handles.process({ sourceId: asset.id, compareId: assetB.id, mode: 'compare',
    spec: { format: 'jpeg', quality: 80, chroma: '4:4:4', compressionLevel: 6, lossless: false, matte: '#ffffff' },
    background: '#ffffff', allow16: false, compareAllow16: false });
  let cur2 = null;
  for (let t = 0; t < 300 && !cur2; t++) { await sleep(100); cur2 = getCurrent(); }
  if (!cur2 || cur2.mode !== 'compare') throw Error('比较模式未完成');
  const copyPath = path.join(os.tmpdir(), `microscope-smoke-copy-${Date.now()}.png`);
  queued.message.push(0); queued.save.push(copyPath);
  const copyRec = await handles.save('artifact', cur2.jobId, { background: '#ffffff', gain: 8, alpha: false });
  if (!copyRec || copyRec.cancelled) throw Error('比较副本保存异常');
  const originalBytes = await fs.readFile(fixture);
  if (sha(await fs.readFile(copyPath)) !== sha(originalBytes))
    throw Error('比较图副本不是原字节副本');
  console.log('[smoke] compare-mode save is byte-identical copy of original');

  console.log('[smoke] OK: EXIF 1-8 + 编码闭环 + 辅助导出 + 原字节副本 全部通过');
};
