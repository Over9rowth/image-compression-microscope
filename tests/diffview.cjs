// 复现并验证"打开差异显影后崩溃"：大图 → 编码 → 切到差异显影 → 驱动增益/Alpha → 读回画布像素。
// 由主进程在 MICROSCOPE_TEST=1 且 MICROSCOPE_TEST_SCRIPT 指向本文件时加载。
//
// 验证目标（不只是"进程没死"）：
//   1. 点击"差异显影"后渲染进程不崩溃、无未捕获异常；
//   2. 画布可被 getImageData 读取（画布未被跨源污染 —— 这是原崩溃的根因）；
//   3. 增益从 ×1 调到 ×32 后，画布亮度单调上升（证明增益真的乘上去了，
//      而不是被 try/catch 静默回退成原始瓦片）；
//   4. 勾选"独立 Alpha 差异"后同样可渲染、可读回。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HELPERS = `
window.__probe = () => {
  const c = document.querySelector('canvas');
  if (!c) return { err: 'no canvas' };
  let d;
  try { d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
  catch (e) { return { err: 'READ FAILED: ' + e.message }; }
  let sum = 0, max = 0, nz = 0, n = 0;
  for (let i = 0; i < d.length; i += 68) {
    const v = d[i] + d[i + 1] + d[i + 2];
    sum += v; if (v > max) max = v; if (v > 0) nz++; n++;
  }
  return { w: c.width, h: c.height, samples: n, sum, max, nz, avg: +(sum / n).toFixed(3) };
};
window.__setGain = (v) => {
  const el = document.querySelector('input[aria-label="显影增益"]');
  if (!el) return { ok: false, why: 'no slider' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, now: el.value };
};
window.__toggleAlpha = (on) => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('独立 Alpha 差异'));
  if (!label) return { ok: false, why: 'no alpha toggle' };
  const cb = label.querySelector('input[type=checkbox]');
  if (cb.checked !== on) cb.click();
  return { ok: true, checked: cb.checked };
};
window.__viewLabel = () => {
  const a = document.querySelector('.viewbar .active');
  return a ? a.textContent.trim() : null;
};
// executeJavaScript 会把脚本的完成值做结构化克隆，最后一条赋值语句的完成值是箭头函数，无法克隆。
'renderer-helpers-ready';
`;

module.exports = async function diffview({ app, win, handles, queued }) {
  console.log('[diff] handles: ' + Object.keys(handles).join(','));

  const gone = [];
  const errors = [];
  win.webContents.on('render-process-gone', (_e, d) => gone.push(d));
  win.webContents.on('unresponsive', () => console.log('[diff] !! renderer unresponsive'));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message}  (${source}:${line})`);
    if (level >= 3 || /SecurityError|Uncaught/.test(message)) errors.push(message);
  });

  // 捕获真实结果事件（process 是异步的，立即返回 {revision}，结果经 job 消息回传）
  const jobs = [];
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...rest) => {
    if (channel === 'job') jobs.push(rest[0]);
    return origSend(channel, ...rest);
  };

  // 大图夹具：3000×2000 渐变 + 局部高频细节，模拟真实照片规模
  const width = 3000, height = 2000;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    raw[i] = Math.round(255 * x / width);
    raw[i + 1] = Math.round(255 * y / height);
    raw[i + 2] = ((x >> 3) + (y >> 3)) % 2 ? 200 : 40;
    raw[i + 3] = x < width / 2 ? 255 : Math.round(255 * (1 - x / width) * 2);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diffview-'));
  const fixture = path.join(dir, 'big.png');
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(fixture);
  console.log(`[diff] fixture ${width}x${height} ${(await fs.stat(fixture)).size} 字节`);

  const src = await handles.drop(fixture);
  console.log('[diff] imported ' + src.name + ' ' + src.byteLength + ' B');

  queued.save.push(path.join(dir, 'out.jpg'));
  const t0 = Date.now();
  await handles.process({
    sourceId: src.id, compareId: undefined, mode: 'encode',
    spec: { format: 'jpeg', quality: 70, chroma: '4:2:0', compressionLevel: 6, lossless: false, matte: '#ffffff' },
    background: '#ffffff', allow16: false, compareAllow16: false,
  });
  // 等待真实结果事件（不是 process 的立即返回）
  for (let i = 0; i < 240 && !jobs.some((j) => j.type === 'result' || j.type === 'error'); i++) await sleep(250);
  const outcome = jobs.find((j) => j.type === 'result' || j.type === 'error');
  if (!outcome || outcome.type === 'error') {
    console.log('[diff] 处理失败: ' + JSON.stringify(outcome));
    return;
  }
  const result = outcome.result;
  console.log(`[diff] result in ${Date.now() - t0} ms; pyramids=` + Object.keys(result.pyramids || {}).join(','));
  const diff = result.pyramids?.difference;
  if (diff) console.log(`[diff] difference pyramid levels=${diff.levels.length} tile=${diff.tileSize} l0=${diff.levels[0].cols}x${diff.levels[0].rows}`);
  if (result.comparison) console.log(`[diff] comparable=${result.comparison.comparable} mae=${result.comparison.mae}`);

  await sleep(1200);
  if (gone.length) { console.log('[diff] 处理阶段渲染进程已崩溃: ' + JSON.stringify(gone)); }

  await win.webContents.executeJavaScript(PAGE_HELPERS);

  // 驱动真实界面：点击"差异显影"
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '差异显影');
      if (!b) return { ok: false, why: 'button not found', buttons: [...document.querySelectorAll('button')].map(x => x.textContent.trim()).slice(0, 40) };
      if (b.disabled) return { ok: false, why: 'button disabled' };
      b.click();
      return { ok: true };
    })()
  `);
  console.log('[diff] click: ' + JSON.stringify(clicked));

  const probe = async (tag) => {
    const r = await win.webContents.executeJavaScript(
      'JSON.stringify(Object.assign({view: window.__viewLabel()}, window.__probe()))'
    ).catch((e) => JSON.stringify({ err: 'eval-failed: ' + e.message }));
    console.log(`[diff] probe ${tag}: ${r}`);
    return JSON.parse(r);
  };
  const setGain = async (v) => {
    const r = await win.webContents.executeJavaScript(`JSON.stringify(window.__setGain(${v}))`);
    return JSON.parse(r);
  };
  const toggleAlpha = async (on) => {
    const r = await win.webContents.executeJavaScript(`JSON.stringify(window.__toggleAlpha(${on}))`);
    return JSON.parse(r);
  };

  // 等瓦片加载完再取基线
  await sleep(1800);
  const pDefault = await probe('默认增益(应为8)');

  console.log('[diff] setGain(1) -> ' + JSON.stringify(await setGain(1)));
  await sleep(1400);
  const p1 = await probe('gain=1');

  console.log('[diff] setGain(32) -> ' + JSON.stringify(await setGain(32)));
  await sleep(1400);
  const p32 = await probe('gain=32');

  console.log('[diff] toggleAlpha(true) -> ' + JSON.stringify(await toggleAlpha(true)));
  await sleep(1400);
  const pAlpha32 = await probe('alpha=true gain=32');

  console.log('[diff] setGain(1) -> ' + JSON.stringify(await setGain(1)));
  await sleep(1400);
  const pAlpha1 = await probe('alpha=true gain=1');

  // 回到默认，模拟用户真实停留状态
  await toggleAlpha(false);
  await setGain(8);
  await sleep(1200);
  const pBack = await probe('恢复 gain=8 alpha=false');

  for (let i = 0; i < 3; i++) {
    await sleep(1000);
    if (gone.length) break;
    const alive = !win.isDestroyed() && !win.webContents.isDestroyed();
    if (!alive) { console.log(`[diff] +${i + 1}s destroyed`); break; }
    const state = await win.webContents.executeJavaScript(
      'JSON.stringify({root:document.querySelector("#root")?.children.length||0,canvas:!!document.querySelector("canvas"),err:document.querySelector(".error")?.textContent||null})'
    ).catch((e) => 'eval-failed: ' + e.message);
    console.log(`[diff] +${i + 1}s ${state}`);
  }

  // ---- 断言 ----
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`[diff] ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

  add('渲染进程存活', gone.length === 0, gone.length ? JSON.stringify(gone) : '无 render-process-gone');
  add('无未捕获异常', errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 3)) : '无 SecurityError/Uncaught');
  add('视图确为差异显影', p1.view === '差异显影', `view=${p1.view}`);
  add('画布可读回(未被跨源污染)', !p1.err && !p32.err, p1.err || p32.err || 'getImageData 成功');
  add('gain=1 有差异内容', p1.nz > 0, `非零采样 ${p1.nz}/${p1.samples}，max=${p1.max}`);
  add('gain=32 比 gain=1 更亮', p32.avg > p1.avg, `avg ${p1.avg} → ${p32.avg}`);
  add('增益近似线性(×32 受 255 截断)', p32.avg >= p1.avg * 2, `比值 ${(p32.avg / Math.max(p1.avg, 1e-6)).toFixed(2)}×`);
  add('Alpha 模式可渲染', !pAlpha1.err && pAlpha1.nz > 0, `avg=${pAlpha1.avg} max=${pAlpha1.max}`);
  add('Alpha 模式增益生效', pAlpha32.avg > pAlpha1.avg, `avg ${pAlpha1.avg} → ${pAlpha32.avg}`);
  add('恢复默认后仍正常', !pBack.err && pBack.nz > 0, `avg=${pBack.avg}`);

  const failed = checks.filter((c) => !c.pass);
  if (gone.length) console.log('[diff] RESULT: CRASHED ' + JSON.stringify(gone));
  else if (failed.length) console.log('[diff] RESULT: SURVIVED BUT ' + failed.length + ' CHECK(S) FAILED');
  else console.log('[diff] RESULT: PASS (' + checks.length + ' checks)');

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  // 主进程在本脚本正常返回后一律 app.exit(0)，断言失败会被吞成"通过"；
  // 这里自己带非零码退出，让 npm run check:diff 真实反映结果。
  if (gone.length || failed.length) app.exit(1);
};
