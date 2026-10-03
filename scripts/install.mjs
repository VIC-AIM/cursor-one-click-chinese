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
// 允许显式指定 Cursor 安装目录：node install.mjs "D:\我的Cursor" 或 --dir=...
const ARG_DIR = (() => {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--dir=')) return a.slice(6);
    if (a === '--dir') return undefined; // --dir 后面跟单独参数的形式不支持，略
  }
  const bare = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== '--yes');
  return bare || undefined;
})();

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

function isValidInstallRoot(dir) {
  return !!dir && existsSync(join(dir, 'Cursor.exe'));
}

function findCursorInstallRoot() {
  // 0) 用户显式指定的目录（命令行参数）
  if (ARG_DIR && isValidInstallRoot(ARG_DIR)) return ARG_DIR;

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

  // 2) 注册表（Inno Setup 安装记录：HKCU 用户级 / HKLM 系统级 / 32 位视图）
  const regKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor_is1',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor_is1',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cursor_is1',
  ];
  for (const key of regKeys) {
    try {
      const out = sh(`reg query "${key}" /v InstallLocation`);
      const m = out.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      if (m && isValidInstallRoot(m[1].trim())) return m[1].trim();
    } catch { /* 该键不存在，继续 */ }
  }

  // 3) 常见安装路径（官方默认 = 用户级 LOCALAPPDATA）
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor'),
    join(process.env.ProgramFiles || '', 'Cursor'),
    join(process.env['ProgramFiles(x86)'] || '', 'Cursor'),
  ];
  for (const p of candidates) {
    if (p && isValidInstallRoot(p)) return p;
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

  // 补丁 3：分组文本节点回退 —— 菜单标题因助记符渲染被拆成
  // <mnemonic>F</mnemonic>ile 的形态，单节点匹配不上词典；
  // 用父元素合并文本整体匹配，仅当元素子节点都是装饰性标签时替换。
  const R3_ANCHOR = '      this.nodeCache.set(textNode, originalText);\r\n      return false;\r\n    }';
  const R3_ANCHOR_LF = R3_ANCHOR.replace(/\r\n/g, '\n');
  const R3_INSERT = `      // [cursor-zh-grouped] 拆分文本节点回退：菜单标题因助记符渲染被拆成\r\n      // <mnemonic>F</mnemonic>ile 的形态，单节点匹配不上词典。\r\n      // 用父元素合并文本整体匹配；仅当元素子节点都是装饰性标签时替换。\r\n      var parentEl = textNode.parentElement;\r\n      if (parentEl && parentEl.textContent && parentEl.textContent.length <= 80) {\r\n        var decoOnly = true;\r\n        var decoKids = parentEl.children;\r\n        for (var dk = 0; dk < decoKids.length; dk++) {\r\n          var dkTag = decoKids[dk].tagName;\r\n          if (dkTag !== 'MNEMONIC' && decoKids[dk].getAttribute('aria-hidden') !== 'true') {\r\n            decoOnly = false;\r\n            break;\r\n          }\r\n        }\r\n        if (decoOnly) {\r\n          var groupHit = exactMap.get(normalizeForMatch(parentEl.textContent));\r\n          if (groupHit !== undefined && groupHit !== parentEl.textContent) {\r\n            parentEl.textContent = groupHit;\r\n            return true;\r\n          }\r\n        }\r\n      }\r\n\r\n`;
  if (s.includes('[cursor-zh-grouped]')) {
    skipped.push('补丁3（分组文本回退）：已存在');
  } else if (s.includes(R3_ANCHOR)) {
    s = s.replace(R3_ANCHOR, R3_INSERT + R3_ANCHOR);
    applied.push('补丁3：分组文本节点回退（助记符菜单标题）');
  } else if (s.includes(R3_ANCHOR_LF)) {
    s = s.replace(R3_ANCHOR_LF, R3_INSERT.replace(/\r\n/g, '\n') + R3_ANCHOR_LF);
    applied.push('补丁3：分组文本节点回退（LF 版本）');
  } else {
    info('[警告] 引擎代码结构有变化，补丁3 未应用（不影响其余步骤）。');
  }

  // 补丁 4：启动竞态兜底 —— 初始扫描与观察器生效之间存在窗口期，
  // 工作区面板（大纲、标签页等）此时挂载或被模型重写为英文后会永久停留；
  // 延迟补扫两轮（nodeCache 让已翻译节点秒过）。
  const R4_ANCHOR = '      runInitialPass();\r\n      startMutationObservers();\r\n    } catch (_error) {';
  const R4_ANCHOR_LF = R4_ANCHOR.replace(/\r\n/g, '\n');
  const R4_TAIL = `      runInitialPass();\r\n      startMutationObservers();\r\n\r\n      // [cursor-zh-catchup] 启动竞态兜底：延迟补扫两轮，覆盖初始扫描与\r\n      // 观察器生效之间的挂载/重写窗口（nodeCache 保证已翻译节点秒过）。\r\n      setTimeout(function () { try { runInitialPass(); } catch (_eCatchup1) {} }, 2500);\r\n      setTimeout(function () { try { runInitialPass(); } catch (_eCatchup2) {} }, 9000);\r\n    } catch (_error) {`;
  const R4_TAIL_LF = R4_TAIL.replace(/\r\n/g, '\n');
  if (s.includes('[cursor-zh-catchup]')) {
    skipped.push('补丁4（启动竞态补扫）：已存在');
  } else if (s.includes(R4_ANCHOR)) {
    s = s.replace(R4_ANCHOR, R4_TAIL);
    applied.push('补丁4：启动竞态兜底补扫');
  } else if (s.includes(R4_ANCHOR_LF)) {
    s = s.replace(R4_ANCHOR_LF, R4_TAIL_LF);
    applied.push('补丁4：启动竞态兜底补扫（LF 版本）');
  } else {
    info('[警告] 引擎代码结构有变化，补丁4 未应用（不影响其余步骤）。');
  }

  // 补丁 5：周期性兜底补扫 —— 界面模型可能在任意时刻把已翻译节点重写回
  // 英文（上下文菜单复用模板、面板刷新等），观察器无法覆盖全部写入时机。
  // 每 5 秒调度一次空闲分片重扫，nodeCache 让未变化节点近乎零成本跳过。
  const R5_TAIL = `  if (document.readyState === 'loading') {\r\n    document.addEventListener('DOMContentLoaded', task);\r\n  } else {\r\n    task();\r\n  }\r\n})();`;
  const R5_TAIL_LF = R5_TAIL.replace(/\r\n/g, '\n');
  const R5_NEW = `  if (document.readyState === 'loading') {\r\n    document.addEventListener('DOMContentLoaded', task);\r\n  } else {\r\n    task();\r\n  }\r\n\r\n  // [cursor-zh-sweep] 周期性兜底补扫：界面模型可能在任意时刻把已翻译节点\r\n  // 重写回英文（上下文菜单复用模板、面板刷新等），观察器无法覆盖全部写入\r\n  // 时机。每 5 秒调度一次空闲分片重扫：nodeCache 让未变化节点近乎零成本\r\n  // 跳过；变化过的节点重新翻译。使用与主扫描相同的禁区过滤器。\r\n  var sweepWalker = null;\r\n  var sweepRunning = false;\r\n  function sweepChunk(deadline) {\r\n    if (!sharedTranslator) { sweepWalker = null; return; }\r\n    var rootEl = document.body || document;\r\n    if (!rootEl) { return; }\r\n    if (!sweepWalker) {\r\n      sweepWalker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, sharedTranslator.createTextNodeFilter());\r\n    }\r\n    try { sharedTranslator.translateAttributes(rootEl); } catch (_eAttr) {}\r\n    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;\r\n    var node;\r\n    while ((node = sweepWalker.nextNode())) {\r\n      if (!node.isConnected) { continue; }\r\n      try { sharedTranslator.translateTextNode(node); } catch (_eSweep) {}\r\n      if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 4) { return; }\r\n      if (t0 && (performance.now() - t0) > 12) { return; }\r\n    }\r\n    sweepWalker = null;\r\n  }\r\n  setInterval(function () {\r\n    if (sweepRunning) { return; }\r\n    sweepRunning = true;\r\n    if (typeof requestIdleCallback === 'function') {\r\n      requestIdleCallback(function (dl) {\r\n        try { sweepChunk(dl); } catch (_eS1) { sweepWalker = null; } finally { sweepRunning = false; }\r\n      }, { timeout: 6000 });\r\n    } else {\r\n      try { sweepChunk(null); } catch (_eS2) { sweepWalker = null; } finally { sweepRunning = false; }\r\n    }\r\n  }, 5000);\r\n})();`;
  const R5_NEW_LF = R5_NEW.replace(/\r\n/g, '\n');
  if (s.includes('[cursor-zh-sweep]')) {
    skipped.push('补丁5（周期性兜底补扫）：已存在');
  } else if (s.includes(R5_TAIL)) {
    s = s.replace(R5_TAIL, R5_NEW);
    applied.push('补丁5：周期性兜底补扫');
  } else if (s.includes(R5_TAIL_LF)) {
    s = s.replace(R5_TAIL_LF, R5_NEW_LF);
    applied.push('补丁5：周期性兜底补扫（LF 版本）');
  } else {
    info('[警告] 引擎代码结构有变化，补丁5 未应用（不影响其余步骤）。');
  }

  // 补丁 6：属性翻译支持 data-placeholder —— 输入框占位符由
  // CSS content:attr(data-placeholder) 渲染，不在默认属性列表里。
  const R6A_OLD = "var ATTR_SELECTOR = 'input[placeholder], textarea[placeholder], input[title], button[title], button[aria-label], [aria-label]';";
  const R6A_NEW = "var ATTR_SELECTOR = 'input[placeholder], textarea[placeholder], input[title], button[title], button[aria-label], [aria-label], [data-placeholder]';";
  const R6B_OLD = "var attrs = ['placeholder', 'title', 'aria-label'];";
  const R6B_NEW = "var attrs = ['placeholder', 'title', 'aria-label', 'data-placeholder'];";
  if (s.includes('[data-placeholder]')) {
    skipped.push('补丁6（data-placeholder 占位符）：已存在');
  } else if (s.includes(R6A_OLD) && s.includes(R6B_OLD)) {
    s = s.replace(R6A_OLD, R6A_NEW).replace(R6B_OLD, R6B_NEW);
    applied.push('补丁6：属性翻译支持 data-placeholder 占位符');
  } else {
    info('[警告] 引擎代码结构有变化，补丁6 未应用（不影响其余步骤）。');
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

  // 静态标签替换：部分右键菜单/悬停标签取自代码常量（label:/hintText:/三元），
  // 运行时 DOM 翻译覆盖不全。仅替换带明确上下文的字面量，不碰按键表与枚举。
  const labelPass = [
    ['?"Restore":"Archive"', '?"恢复":"归档"'],
    ['?"Unpin":"Pin"', '?"取消置顶":"置顶"'],
    ['hintText:"Restore"', 'hintText:"恢复"'],
    ['label:"Open in New Tab"', 'label:"在新标签页中打开"'],
    ['label:"Rename"', 'label:"重命名"'],
    ['label:"Delete"', 'label:"删除"'],
    ['label:"Restore"', 'label:"恢复"'],
    ['label:"Pin"', 'label:"置顶"'],
    ['label:"Unpin"', 'label:"取消置顶"'],
    ['label:"Archive"', 'label:"归档"'],
    ['label:"Edit"', 'label:"编辑"'],
    ['"Copy Branch Name"', '"复制分支名称"'],
    ['"Plan, Build, / for skills, @ for context"', '"规划、构建；输入 / 使用技能，输入 @ 添加上下文"'],
    ['"Copy Request ID"', '"复制请求 ID"'],
  ];
  const workbenchDir = join(root, 'resources', 'app', 'out', 'vs', 'workbench');
  let labelCount = 0;
  for (const f of ['workbench.desktop.main_translated.js', 'workbench.glass.main_translated.js']) {
    const fp = join(workbenchDir, f);
    if (!existsSync(fp)) continue;
    let txt = readFileSync(fp, 'utf8');
    let fileCount = 0;
    for (const [from, to] of labelPass) {
      const parts = txt.split(from);
      if (parts.length > 1) {
        fileCount += parts.length - 1;
        txt = parts.join(to);
      }
    }
    writeFileSync(fp, txt);
    labelCount += fileCount;
  }
  info(`静态标签替换：${labelCount} 处`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('=========================================');
  console.log('       Cursor 一键汉化 (Windows)         ');
  console.log('=========================================');

  step(1, '检测 Cursor 安装位置');
  let root = findCursorInstallRoot();
  if (!root) {
    // 自动检测失败：交互式询问路径（任何目录都能装，兼容自定义安装位置）
    if (!AUTO_YES) {
      const rl0 = createInterface({ input, output });
      const answer = (await rl0.question('未自动找到 Cursor。请粘贴 Cursor 安装目录（含 Cursor.exe 的文件夹，例如 C:\\Users\\你\\AppData\\Local\\Programs\\cursor）：')).trim().replace(/^"|"$/g, '');
      rl0.close();
      if (isValidInstallRoot(answer)) {
        root = answer;
      } else if (answer) {
        die(`该目录下没有找到 Cursor.exe：${answer}`);
      }
    }
    if (!root) {
      die('未找到 Cursor 安装目录。解决方法任选：\n' +
          '  1. 先安装 Cursor 后重试；\n' +
          '  2. 把安装路径作为参数传入：一键汉化.bat "D:\\你的目录\\cursor"；\n' +
          '  3. 命令行运行：node scripts\\install.mjs --dir="D:\\你的目录\\cursor"。');
    }
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
