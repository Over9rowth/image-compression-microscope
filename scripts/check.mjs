// 界面级检查的通用启动器。
//
//   npm run check:diff      → tests/diffview.cjs   （差异显影崩溃回归）
//   npm run check:sizecap   → tests/sizecap-ui.cjs （体积上限界面链路）
//
// 环境适配与 smoke.mjs 相同：宿主机若在 Electron 内置终端里会带 ELECTRON_RUN_AS_NODE，
// 必须去掉；远程/无显卡会话需要禁用 GPU 才能起渲染进程。
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import electronPath from 'electron';

const name = process.argv[2];
if (!name) {
  console.error('用法: node scripts/check.mjs <测试名>，例如 diffview 或 sizecap-ui');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'tests', `${name}.cjs`);
if (!fs.existsSync(script)) {
  console.error('找不到测试脚本: ' + script);
  process.exit(2);
}

const env = { ...process.env, MICROSCOPE_TEST: '1', MICROSCOPE_TEST_SCRIPT: script };
delete env.ELECTRON_RUN_AS_NODE;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), `microscope-${name}-`));
const child = spawn(electronPath, [
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu',
  '--disable-gpu-sandbox',
  `--user-data-dir=${userData}`,
  '.',
], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  process.exit(code ?? 1);
});
