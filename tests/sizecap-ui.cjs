// 界面级验证：体积上限输入框 → 触发真实重编码 → 反馈文案与实际体积一致。
//
// 必须走真实界面导入：若绕过界面直接调主进程的 process，渲染层 source 状态仍是空，
// 之后任何参数变化都会被 process() 的 `if(!source...)` 提前返回，测出来的是假失败。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function sizecapUI({ app, win, queued }) {
  const gone = [];
  const errors = [];
  win.webContents.on('render-process-gone', (_e, d) => gone.push(d));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 || /Uncaught/.test(message)) errors.push(message);
  });

  // 夹具：有足够细节，保证质量变化真实反映到字节数
  const width = 1200, height = 900;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    raw[i] = (x * 7 + y * 13 + (x * y) % 97) & 255;
    raw[i + 1] = (x * 11 + y * 3 + (x ^ y)) & 255;
    raw[i + 2] = (x * 5 + y * 17) % 251;
    raw[i + 3] = 255;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sizecap-ui-'));
  const fixture = path.join(dir, 'src.png');
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(fixture);

  await win.webContents.executeJavaScript(`
    window.__setCap = (kb) => {
      const el = document.querySelector('input[aria-label="体积上限"]');
      if (!el) return { ok: false, why: 'no input' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, kb === null ? '' : String(kb));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, now: el.value };
    };
    window.__capState = () => {
      const el = document.querySelector('input[aria-label="体积上限"]');
      const p = [...document.querySelectorAll('aside p')].map((n) => n.textContent.trim())
        .find((t) => t.includes('上限') || t.includes('已达') || t.includes('无法达成')) || null;
      const size = document.querySelector('.size')?.textContent?.trim() || null;
      const view = document.querySelector('.viewbar span')?.textContent?.trim() || null;
      const err = document.querySelector('.error')?.textContent?.trim() || null;
      return { input: el ? el.value : null, feedback: p, size, view, err };
    };
    'ready';
  `);

  const state = async () => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__capState())'));
  const setCap = async (kb) => JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__setCap(${kb === null ? 'null' : kb}))`));

  // 走真实界面导入：排队一个打开对话框结果，然后点"导入原图"
  queued.open.push(fixture);
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('button')].find((x) => ['导入原图', '选择图片'].includes(x.textContent.trim()));
      if (!b) return { ok: false, why: 'button not found', buttons: [...document.querySelectorAll('button')].map((x) => x.textContent.trim()).slice(0, 40) };
      b.click();
      return { ok: true, label: b.textContent.trim() };
    })()
  `);
  console.log('[cap] 点击导入: ' + JSON.stringify(clicked));

  // 等首次真实结果（界面出现体积数字）
  let baseline = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const s = await state();
    if (s.err) { console.log('[cap] 界面报错: ' + s.err); break; }
    if (s.size) { baseline = s; break; }
  }
  if (!baseline) {
    console.log('[cap] 首次结果未出现，终止');
    console.log('[cap] RESULT: FAILED TO PRODUCE RESULT');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    app.exit(1);
    return;
  }
  console.log('[cap] 初始: ' + JSON.stringify(baseline));
  const baselineKiB = parseFloat(baseline.size.replace(/[^\d.]/g, ''));

  // 1) 设一个可达上限（基准的 55%）
  const capKiB = Math.max(4, Math.floor(baselineKiB * 0.55));
  console.log('[cap] 设置上限 ' + capKiB + ' KiB -> ' + JSON.stringify(await setCap(capKiB)));
  let ok = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const s = await state();
    if (s.feedback && s.feedback.includes('已达上限')) { ok = s; break; }
  }
  console.log('[cap] 可达上限结果: ' + JSON.stringify(ok));

  // 2) 设一个不可能的上限
  await setCap(1);
  let impossible = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const s = await state();
    if (s.feedback && s.feedback.includes('无法达成')) { impossible = s; break; }
  }
  console.log('[cap] 不可达上限结果: ' + JSON.stringify(impossible));

  // 3) 清空 -> 反馈消失
  await setCap(null);
  let cleared = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const s = await state();
    if (!s.feedback) { cleared = s; break; }
  }
  console.log('[cap] 清空后: ' + JSON.stringify(cleared));

  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass }); console.log(`[cap] ${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

  add('渲染进程存活', gone.length === 0, gone.length ? JSON.stringify(gone) : '无崩溃');
  add('无未捕获异常', errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : '无');
  add('界面导入后出现真实体积', baselineKiB > 0, `${baseline.size}`);
  add('输入框存在且初始为空', baseline.input === '', `input="${baseline.input}"`);
  add('无上限时没有上限反馈', baseline.feedback === null, `feedback=${JSON.stringify(baseline.feedback)}`);
  add('可达上限时给出"已达上限"', !!ok, ok ? ok.feedback : '超时未出现');
  if (ok) {
    const shown = parseFloat(ok.size.replace(/[^\d.]/g, ''));
    add('实际体积不超过设定上限', shown <= capKiB + 0.01, `显示 ${shown} KiB ≤ 上限 ${capKiB} KiB`);
    const q = ok.feedback.match(/质量 (\d+)/);
    add('反馈里的质量在 1—100', !!q && +q[1] >= 1 && +q[1] <= 100, q ? '质量 ' + q[1] : ok.feedback);
  }
  add('不可达上限时如实报"无法达成"', !!impossible, impossible ? impossible.feedback : '超时未出现');
  add('清空上限后反馈消失', !!cleared, cleared ? '已消失' : '仍存在');

  const failed = checks.filter((c) => !c.pass);
  console.log(gone.length ? '[cap] RESULT: CRASHED'
    : failed.length ? `[cap] RESULT: ${failed.length} CHECK(S) FAILED`
    : `[cap] RESULT: PASS (${checks.length} checks)`);

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (gone.length || failed.length) app.exit(1);
};
