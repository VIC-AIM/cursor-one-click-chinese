#!/usr/bin/env node
/**
 * Cursor 一键汉化（Windows）
 *
 * 做四件事：
 *   1. 安装微软官方中文语言包（翻译 编辑器/菜单/命令面板 等底座界面）
 *   2. 把显示语言设置为 zh-cn（~/.cursor/argv.json）
 *   3. 从 open-vsx 下载安装「Cursor 专有界面汉化」扩展（翻译 Agents 侧栏 /
 *      设置页 / 聊天气泡等 Cursor 自有界面，微软语言包管不到的部分）
 *   4. 给该扩展的翻译引擎打两个增强补丁 + 合入本项目补充词典：
 *      - 把 body 加入扫描根，启动后才挂载的界面（侧栏等）也能被翻译
 *      - 把 body 加入观察区域，运行中新出现的界面元素实时翻译
 *      - 补充 Cursor 3.20 新增文案的词典条目（见 scripts/dict/extras.json）
 *
 * 可重复执行（幂等）。Cursor 更新后界面变回英文时，重新运行本脚本即可。
 *
 * 用法：node install.mjs [--yes]
 *   --yes  不做任何询问（关闭 Cursor、最后启动 Cursor 均自动执行）
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/* ---------------- 常量 ---------------- */

const MS_PACK_ID = 'ms-ceintl.vscode-language-pack-zh-hans';
const EXT_PUBLISHER = 'ggbdpq';
const EXT_NAME = 'cursor-language-pack-zh-hans';
const EXT_ID = `${EXT_PUBLISHER}.${EXT_NAME}`;
// 本项目完整验证过的扩展版本；如想追新版可改为 'latest'
const EXT_VERSION = '0.0.11';
const OPEN_VSX_API = 'https://open-vsx.org';
const AUTO_YES = process.argv.includes('--yes');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extrasPath = join(scriptDir, 'dict', 'extras.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, msg) => console.log(`\n===== [${n}/8] ${msg} =====`);
const info = (msg) => console.log(`  ${msg}`);
const die = (msg) => {
  console.error(`\n[失败] ${msg}`);
  console.error('如无法解决，请到本项目仓库提 Issue，附上上面的完整输出。');
  process.exit(1);
};

/* ---------------- 小工具 ---------------- */

function sh(cmd, timeoutMs = 300000) {
  // 统一走 cmd 执行，编码取 utf8；带超时，避免任何子命令卡死整个安装
  return execSync(cmd, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

async function askYesNo(question, fallbackYes = true) {
  if (AUTO_YES) return fallbackYes;
  const rl = createInterface({ input, output });
  const a = (await rl.question(`${question} (Y/n): `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

function findCursorInstallRoot() {
  // 1) PATH 中的 cursor 命令（…\resources\app\bin\cursor.cmd / cursor 脚本）
  try {
    const lines = sh('where cursor').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of lines) {
      let dir = dirname(resolve(p));
      for (let i = 0; i < 6 && dir !== dirname(dir); i++) {
        if (existsSync(join(dir, 'Cursor.exe'))) return dir;
        dir = dirname(dir);
      }
    }
  } catch { /* where 没找到，继续往下 */ }

  // 2) 注册表（Inno Setup 安装记录）
  try {
    const out = sh(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor_is1" /v InstallLocation'
    );
    const m = out.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
    if (m && existsSync(join(m[1].trim(), 'Cursor.exe'))) return m[1].trim();
  } catch { /* 没有注册表项，继续往下 */ }

  // 3) 常见安装路径
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor'),
    join(process.env.ProgramFiles || '', 'Cursor'),
    join(process.env['ProgramFiles(x86)'] || '', 'Cursor'),
  ];
  for (const p of candidates) {
    if (p && existsSync(join(p, 'Cursor.exe'))) return p;
  }
  return null;
}

function cursorRunning() {
  try {
    return /Cursor\.exe/i.test(sh('tasklist /FI "IMAGENAME eq Cursor.exe" /NH'));
  } catch {
    return false;
  }
}

async function closeCursor() {
  if (!cursorRunning()) {
    info('Cursor 未在运行。');
    return;
  }
  const ok = await askYesNo('检测到 Cursor 正在运行，需要完全关闭后才能打补丁。现在关闭吗？');
  if (!ok) die('已取消。请手动完全退出 Cursor 后重新运行。');
  try { sh('taskkill /IM Cursor.exe'); } catch { /* 可能已退出 */ }
  await sleep(4000);
  try { sh('taskkill /F /IM Cursor.exe'); } catch { /* 已全部退出 */ }
  await sleep(1500);
  if (cursorRunning()) die('无法关闭 Cursor，请手动退出后重试。');
  info('Cursor 已完全退出。');
}

async function downloadTo(url, dest, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'cursor-one-click-chinese' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      if (i === retries) throw e;
      info(`下载失败（${e.message}），第 ${i}/${retries} 次重试…`);
      await sleep(2000 * i);
    }
  }
}

function runCursorCli(root, args) {
  const cli = join(root, 'resources', 'app', 'bin', 'cursor.cmd');
  if (!existsSync(cli)) die(`未找到 Cursor 命令行工具：${cli}`);
  const argStr = args.map((a) => `"${a}"`).join(' ');
  return sh(`cmd /c ""${cli}" ${argStr}"`);
}

/* ---------------- 各步骤 ---------------- */

function installMsLanguagePack(root) {
  step(3, '安装微软官方中文语言包（编辑器 / 菜单 / 命令面板）');
  runCursorCli(root, ['--install-extension', MS_PACK_ID]);
  const list = runCursorCli(root, ['--list-extensions']);
  if (!list.toLowerCase().includes(MS_PACK_ID)) {
    die('微软中文语言包安装失败，请检查网络后重试。');
  }
  info(`${MS_PACK_ID} 已就绪。`);
}

function setDisplayLanguage() {
  step(4, '设置显示语言为 简体中文 (zh-cn)');
  const dir = join(homedir(), '.cursor');
  const argvPath = join(dir, 'argv.json');
  mkdirSync(dir, { recursive: true });
  let text = existsSync(argvPath)
    ? readFileSync(argvPath, 'utf8')
    : '// 该文件用于给 Cursor 传启动参数。\n';
  if (/"locale"\s*:/.test(text)) {
    text = text.replace(/("locale"\s*:\s*)"[^"]*"/, '$1"zh-cn"');
  } else {
    text = text.replace(/\}\s*$/, '\t// 显示语言：简体中文\n\t"locale": "zh-cn"\n}');
  }
  writeFileSync(argvPath, text);
  info(`已写入 ${argvPath} ("locale": "zh-cn")`);
}

async function installProprietaryExtension(root) {
  step(5, `下载并安装「Cursor 专有界面汉化」扩展 (${EXT_VERSION})`);
  // 查询下载地址（固定版本，保证补丁模式匹配；详见 README）
  const metaRes = await fetch(`${OPEN_VSX_API}/api/${EXT_PUBLISHER}/${EXT_NAME}/${EXT_VERSION}`, {
    headers: { 'User-Agent': 'cursor-one-click-chinese' },
    signal: AbortSignal.timeout(60000),
  });
  if (!metaRes.ok) die(`查询 open-vsx 元数据失败：HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const vsixUrl = meta.files && meta.files.download;
  if (!vsixUrl) die('open-vsx 返回数据里没有下载地址。');

  const vsixPath = join(tmpdir(), `${EXT_ID}-${EXT_VERSION}.vsix`);
  rmSync(vsixPath, { force: true });
  info('下载 VSIX 中…');
  await downloadTo(vsixUrl, vsixPath);
  runCursorCli(root, ['--install-extension', vsixPath]);
  rmSync(vsixPath, { force: true });

  // 定位已安装的扩展目录
  const extRoot = join(homedir(), '.cursor', 'extensions');
  const dirs = readdirSync(extRoot)
    .filter((d) => d.startsWith(`${EXT_ID}-`))
    .sort();
  if (dirs.length === 0) die('扩展安装后未找到目录，请把完整输出反馈到仓库 Issue。');
  const extDir = join(extRoot, dirs[dirs.length - 1]);
  info(`扩展已安装：${extDir}`);
  return extDir;
}

function patchEngineAsset(extDir) {
  step(6, '给翻译引擎打增强补丁（覆盖侧栏等动态挂载区域）');
  const assetPath = join(extDir, 'bundled', 'patch-core', 'dist', 'assets', 'cursor.inject.js');
  if (!existsSync(assetPath)) die(`未找到注入引擎文件：${assetPath}`);
  let s = readFileSync(assetPath, 'utf8');

  // 首次打补丁前留一份原始备份，方便排错；重复运行不覆盖
  const backupPath = `${assetPath}.orig-backup`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, s);

  const applied = [];
  const skipped = [];

  // 补丁 1：初始扫描根加入 body —— 启动后才挂载、且不在默认翻译区域里的界面（如侧栏）也能被扫描
  const R1_OLD = "ROOT_SELECTORS = ZONE_SELECTORS.concat(['.workbench'])";
  const R1_NEW = "ROOT_SELECTORS = ZONE_SELECTORS.concat(['.workbench', 'body'])";
  if (s.includes(R1_NEW)) {
    skipped.push('补丁1（扫描根 +body）：已是补丁状态');
  } else if (s.includes(R1_OLD)) {
    s = s.replace(R1_OLD, R1_NEW);
    applied.push('补丁1：扫描根加入 body');
  } else {
    info('[警告] 引擎代码结构有变化，补丁1 未应用（不影响其余步骤）。');
  }

  // 补丁 2：观察区域加入 body —— 运行期间新出现的界面元素（菜单、弹窗等）实时翻译
  const R2_TEST = /ZONE_SELECTORS = \[\s*\r?\n\s*'body',/.test(s);
  const R2_RE = /ZONE_SELECTORS = \[\r?\n(\s*)'\.monaco-dialog-box',/;
  if (R2_TEST) {
    skipped.push('补丁2（观察区域 +body）：已是补丁状态');
  } else if (R2_RE.test(s)) {
    s = s.replace(R2_RE, (_m, ind) => `ZONE_SELECTORS = [\r\n${ind}'body',\r\n${ind}'.monaco-dialog-box',`);
    applied.push('补丁2：观察区域加入 body');
  } else {
    info('[警告] 引擎代码结构有变化，补丁2 未应用（不影响其余步骤）。');
  }

  writeFileSync(assetPath, s);
  if (applied.length) applied.forEach((a) => info(a));
  if (skipped.length) skipped.forEach((a) => info(a));
}

async function applyLocalization(extDir, root) {
  step(7, '应用汉化（上游词典 + 本项目补充词典）');
  const core = await import(pathToFileURL(join(extDir, 'bundled', 'patch-core', 'dist', 'index.js')).href);
  const bundle = JSON.parse(
    readFileSync(join(extDir, 'generated', 'replacements.bundle.json'), 'utf8')
  );
  const extras = JSON.parse(readFileSync(extrasPath, 'utf8'));
  const replacements = bundle.replacements.concat(extras);
  info(`词典条目：上游 ${bundle.replacements.length} + 本项目补充 ${extras.length}`);

  // 若已打过旧补丁，先还原再打，保证用的是最新词典
  const metaPath = join(root, 'resources', 'app', 'out', 'cursor-zh-patch-meta.json');
  if (existsSync(metaPath)) {
    const r = await core.revertPatch(root);
    if (!r.ok) die('还原旧补丁失败：' + (r.lines || []).join(' / '));
    info('已还原旧补丁，重新应用…');
  }

  const res = await core.applyPatch({ installRoot: root, replacements });
  if (!res.ok) die((res.lines || []).join('\n'));
  (res.lines || []).forEach((l) => info(l));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('=========================================');
  console.log('       Cursor 一键汉化 (Windows)         ');
  console.log('=========================================');

  step(1, '检测 Cursor 安装位置');
  const root = findCursorInstallRoot();
  if (!root) {
    die('未找到 Cursor 安装目录。请先安装 Cursor，或把安装路径反馈到仓库 Issue。');
  }
  info(`Cursor 位置：${root}`);

  step(2, '关闭 Cursor');
  await closeCursor();

  installMsLanguagePack(root);
  setDisplayLanguage();
  const extDir = await installProprietaryExtension(root);
  patchEngineAsset(extDir);
  await applyLocalization(extDir, root);

  step(8, '完成');
  console.log(`
[成功] 汉化已应用，即将启动 Cursor 查看效果。

  - 菜单 / 编辑器 / 命令面板：来自微软官方语言包
  - Agents 侧栏 / 设置页 / 聊天界面：来自专有界面汉化补丁
  - 模型名、账号名、仓库名等专有名词保持英文属正常现象

以后 Cursor 更新导致界面变回英文时，重新运行本脚本即可。
想恢复英文界面：运行「恢复英文.bat」，或在本扩展命令面板执行
「Cursor 中文：恢复英文界面」。
`);
  try {
    sh(`cmd /c start "" "${join(root, 'Cursor.exe')}"`);
    info('Cursor 已启动。');
  } catch { /* 启动失败不打紧，用户自己开也行 */ }
  process.exit(0); // 显式退出：网络库的保活连接不应拖住安装器
}

main().catch((e) => die(e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)));
