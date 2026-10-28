import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import electronPath from 'electron';

const root = path.resolve(import.meta.dirname, '..');

// 终端自身可能跑在 Electron 里（例如 IDE 内置终端），会带 ELECTRON_RUN_AS_NODE=1，
// 使 electron 二进制退化成纯 Node，导致 require('electron') 返回路径字符串、app 为 undefined。
const env = {
  ...process.env,
  MICROSCOPE_TEST: '1',
  MICROSCOPE_TEST_SCRIPT: path.join(root, 'tests', 'smoke.cjs'),
};
delete env.ELECTRON_RUN_AS_NODE;

// 冒烟必须用自己的 userData 目录：默认的 %APPDATA%\Electron 被宿主 IDE 占用，
// GPU 持久化缓存会因文件锁反复崩溃，渲染进程随之起不来。
// 另外在远程/无显卡会话里 Chromium GPU 进程无法启动（exit_code=-1073741819），
// 会让 loadFile 以 ERR_FAILED 失败；用进程内 GPU + 软件光栅绕开。这些只是测试开关，不影响产品代码。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'microscope-smoke-'));
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
