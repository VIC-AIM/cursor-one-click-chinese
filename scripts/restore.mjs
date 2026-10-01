#!/usr/bin/env node
/**
 * 恢复英文界面：移除汉化补丁，Cursor 专有界面还原为原始英文状态。
 *
 * 说明：微软中文语言包不会被动；若连菜单/命令面板的中文也不想要，
 * 自行在 ~/.cursor/argv.json 把 "locale" 改回 "en"，或卸载语言包扩展。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const EXT_ID = 'ggbdpq.cursor-language-pack-zh-hans';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function findCursorInstallRoot() {
  try {
    const lines = sh('where cursor').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of lines) {
      let dir = join(p, '..');
      for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'Cursor.exe'))) return dir;
        dir = join(dir, '..');
      }
    }
  } catch { /* ignore */ }
  for (const p of [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor'),
    join(process.env.ProgramFiles || '', 'Cursor'),
  ]) {
    if (p && existsSync(join(p, 'Cursor.exe'))) return p;
  }
  return null;
}

async function main() {
  const root = findCursorInstallRoot();
  if (!root) {
    console.error('[失败] 未找到 Cursor 安装目录。');
    process.exit(1);
  }
  // 还原前先退出 Cursor，避免文件占用
  try {
    if (/Cursor\.exe/i.test(sh('tasklist /FI "IMAGENAME eq Cursor.exe" /NH'))) {
      console.log('检测到 Cursor 正在运行，先将其关闭…');
      try { sh('taskkill /IM Cursor.exe'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 4000));
      try { sh('taskkill /F /IM Cursor.exe'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  const extRoot = join(homedir(), '.cursor', 'extensions');
  const dirs = readdirSync(extRoot).filter((d) => d.startsWith(`${EXT_ID}-`)).sort();
  if (dirs.length === 0) {
    console.log('未安装汉化扩展，无需恢复。');
    return;
  }
  const extDir = join(extRoot, dirs[dirs.length - 1]);
  const core = await import(pathToFileURL(join(extDir, 'bundled', 'patch-core', 'dist', 'index.js')).href);
  const res = await core.revertPatch(root);
  console.log((res.lines || []).join('\n'));
  console.log(res.ok
    ? '\n[成功] 已恢复英文界面，请重新打开 Cursor。'
    : '\n[失败] 恢复未完成，请把上面的输出反馈到项目仓库。');
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
  process.exit(1);
});
