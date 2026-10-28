// 验证"滚轮缩放跟随光标"：缩放前后，光标下的那个图像像素必须留在原地。
//
// 判据用界面自己的坐标读数（页脚 x / y px），不是重算一遍公式——否则等于用实现验证实现。
// 若仍按画布中心缩放，偏离中心的锚点在 100%→125% 时会漂移数十像素，远大于这里的容差。
//
// 注意：合成事件的 clientX 在不同事件类型间取整行为不一致（实测 WheelEvent 截断、
// PointerEvent 进位），两次若传同一个浮点坐标会落到相邻整数上，锚点就不是同一点了。
// 因此这里一律用整数 client 坐标，保证两个事件看到完全相同的像素位置。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function zoomCursor({ app, win, queued }) {
  const gone = [];
  const errors = [];
  win.webContents.on('render-process-gone', (_e, d) => gone.push(d));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught/.test(message)) errors.push(message);
  });

  const width = 1200, height = 900;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    raw[i] = (x * 3) & 255; raw[i + 1] = (y * 5) & 255; raw[i + 2] = ((x ^ y) * 7) & 255; raw[i + 3] = 255;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zoomcursor-'));
  const fixture = path.join(dir, 'src.png');
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(fixture);

  await win.webContents.executeJavaScript(`
    window.__geom = () => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, dpr: devicePixelRatio };
    };
    window.__coord = () => {
      const t = document.querySelector('.coordinate').textContent;
      const m = t.match(/x (-?\\d+) \\/ y (-?\\d+) px · ([\\d.]+)%/);
      return { x: +m[1], y: +m[2], zoom: +m[3] };
    };
    window.__moveAt = (cx, cy) => {
      document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    };
    window.__wheelAt = (cx, cy, dy) => {
      document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: dy, bubbles: true, cancelable: true }));
    };
    window.__reset = () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('重置位置'));
      if (!b) return false;
      b.click();
      return true;
    };
    'ready';
  `);

  const geom = async () => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__geom())'));
  const coord = async () => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__coord())'));
  const moveAt = async (cx, cy) => { await win.webContents.executeJavaScript(`window.__moveAt(${cx},${cy})`); await sleep(130); return coord(); };
  const wheelAt = async (cx, cy, dy) => { await win.webContents.executeJavaScript(`window.__wheelAt(${cx},${cy},${dy})`); await sleep(240); return coord(); };
  const reset = async () => { await win.webContents.executeJavaScript('window.__reset()'); await sleep(240); return coord(); };

  // 走真实界面导入
  queued.open.push(fixture);
  await win.webContents.executeJavaScript(`
    (() => { const b = [...document.querySelectorAll('button')].find((x) => ['导入原图','选择图片'].includes(x.textContent.trim())); if (b) b.click(); })()
  `);
  let ready = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    // 必须等真实结果出现：结果未到时 result 为空，指针读数会少掉图宽/2 的偏移，
    // 那样量到的"漂移"其实是测量时机问题，不是缩放锚点问题。
    const s = await win.webContents.executeJavaScript(`JSON.stringify({
      coord: window.__coord(),
      hasSize: !!document.querySelector('.size'),
      err: document.querySelector('.error')?.textContent || null
    })`).then(JSON.parse).catch(() => null);
    if (s?.err) { console.log('[zoom] 界面报错: ' + s.err); break; }
    if (s?.hasSize) { ready = s.coord; break; }
  }
  if (!ready) { console.log('[zoom] 未取得界面坐标读数'); app.exit(1); return; }

  const g = await geom();
  const panelW = g.width / 2;
  console.log(`[zoom] 画布 ${Math.round(g.width)}×${Math.round(g.height)} CSS px，dpr=${g.dpr}，并排模式下单面板宽 ${Math.round(panelW)}`);

  // 锚点：左面板内、明显偏离中心（62% 处）
  const ax = Math.round(g.left + panelW * 0.62);
  const ay = Math.round(g.top + g.height * 0.40);
  // 中心点：面板正中
  const cx0 = Math.round(g.left + panelW * 0.5);
  const cy0 = Math.round(g.top + g.height * 0.5);
  console.log(`[zoom] 锚点 client=(${ax},${ay})，中心 client=(${cx0},${cy0})`);

  await reset();

  // A. 偏离中心处放大
  const a0 = await moveAt(ax, ay);
  const a1 = await wheelAt(ax, ay, -100);
  const a2 = await moveAt(ax, ay);
  console.log(`[zoom] A 放大前 ${a0.x},${a0.y} @${a0.zoom}% → ${a1.zoom}% → 再读 ${a2.x},${a2.y}`);

  // B. 同一位置缩回
  const b1 = await wheelAt(ax, ay, +100);
  const b2 = await moveAt(ax, ay);
  console.log(`[zoom] B 缩回后 ${b1.zoom}% → 读数 ${b2.x},${b2.y}`);

  // C. 面板正中放大（此处锚点与中心重合，本来就不该漂移）
  await reset();
  const c0 = await moveAt(cx0, cy0);
  const c1 = await wheelAt(cx0, cy0, -100);
  const c2 = await moveAt(cx0, cy0);
  console.log(`[zoom] C 中心 ${c0.x},${c0.y} @${c0.zoom}% → ${c1.zoom}% → 再读 ${c2.x},${c2.y}`);

  // D. 连续放大到高倍率，检查累积误差
  await reset();
  const d0 = await moveAt(ax, ay);
  let dLast = d0;
  for (let i = 0; i < 6; i++) dLast = await wheelAt(ax, ay, -100);
  const d2 = await moveAt(ax, ay);
  console.log(`[zoom] D 连续放大到 ${dLast.zoom}% → 再读 ${d2.x},${d2.y}`);

  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass }); console.log(`[zoom] ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

  add('渲染进程存活', gone.length === 0, gone.length ? JSON.stringify(gone) : '无崩溃');
  add('无未捕获异常', errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : '无');
  add('滚轮确实放大了', a1.zoom > a0.zoom, `${a0.zoom}% → ${a1.zoom}%`);

  const dxA = Math.abs(a2.x - a0.x), dyA = Math.abs(a2.y - a0.y);
  add('放大后光标下的图像点不动', dxA <= 2 && dyA <= 2, `偏移 dx=${dxA} dy=${dyA} px（反向对照：按中心缩放实测漂移 13/12 px）`);

  add('滚轮确实缩回了', b1.zoom < a1.zoom, `${a1.zoom}% → ${b1.zoom}%`);
  const dxB = Math.abs(b2.x - a0.x), dyB = Math.abs(b2.y - a0.y);
  add('缩回后回到原处', dxB <= 3 && dyB <= 3, `相对初始偏移 dx=${dxB} dy=${dyB} px`);

  add('中心缩放仍可用', c1.zoom > c0.zoom, `${c0.zoom}% → ${c1.zoom}%`);
  const dxC = Math.abs(c2.x - c0.x), dyC = Math.abs(c2.y - c0.y);
  add('中心处缩放不产生漂移', dxC <= 2 && dyC <= 2, `偏移 dx=${dxC} dy=${dyC} px`);

  add('连续 6 次放大不累积漂移', dLast.zoom >= 380, `${d0.zoom}% → ${dLast.zoom}%（1.25^6 ≈ 381.5%；按中心缩放时此步会累积到 50/43 px）`);
  const dxD = Math.abs(d2.x - d0.x), dyD = Math.abs(d2.y - d0.y);
  add('高倍率下锚点仍不动', dxD <= 3 && dyD <= 3, `偏移 dx=${dxD} dy=${dyD} px`);

  const failed = checks.filter((c) => !c.pass);
  console.log(gone.length ? '[zoom] RESULT: CRASHED'
    : failed.length ? `[zoom] RESULT: ${failed.length} CHECK(S) FAILED`
    : `[zoom] RESULT: PASS (${checks.length} checks)`);

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (gone.length || failed.length) app.exit(1);
};
