# Cursor 一键汉化（Windows）

给 [Cursor](https://cursor.com) 做完整的简体中文界面汉化：**下载本仓库 → 双击 `一键汉化.bat` → 完成**。

![汉化效果](assets/screenshot.png)

## 它解决什么问题

Cursor 的界面分两层，官方都没有完整中文支持：

| 层 | 内容 | 谁来翻译 |
|----|------|----------|
| 编辑器底座 | 菜单、命令面板、IDE 设置、提示 | 微软官方 [中文语言包](https://marketplace.visualstudio.com/items?itemName=MS-CEINTL.vscode-language-pack-zh-hans) |
| Cursor 自有界面 | Agents 侧栏（New Chat / Automations…）、Cursor 设置页、聊天气泡、按钮等 | 微软语言包**管不到**，官方暂未支持中文（[论坛讨论](https://forum.cursor.com/t/please-add-chinese-support-for-the-agents-window/161942)），由开源扩展 [ggbdpq/cursor-language-pack-zh-hans](https://open-vsx.org/extension/ggbdpq/cursor-language-pack-zh-hans) 补齐 |

本仓库把两者打包成**一键脚本**，并在该扩展之上做了两点增强（已反馈可复现的问题）：

1. **修复扫描盲区**：原版翻译引擎只扫描启动时已存在、且位于预设区域内的界面，
   导致侧栏这类「启动后才异步挂载」的界面永远保持英文。本项目给引擎打了补丁，
   让扫描和实时监听覆盖整个页面（编辑器、终端、代码块仍受原版禁区保护，不会误翻）。
2. **补齐词典**：原版词典跟不上 Cursor 版本迭代，本项目补充了 Cursor 3.20 新增文案
   等 23 条翻译（见 [`scripts/dict/extras.json`](scripts/dict/extras.json)），欢迎 PR 继续補。

## 环境要求

- Windows 10 / 11
- [Cursor](https://cursor.com) 已安装
- Node.js ≥ 18（没装也没关系：`一键汉化.bat` 会尝试用 winget 自动安装，或去 [nodejs.org](https://nodejs.org/zh-cn) 手动装）

## 使用方法

**方式一（推荐）**：打开本仓库 → 绿色 `Code` 按钮 → `Download ZIP` → 解压 → 双击 **`一键汉化.bat`**

**方式二**：

```bat
git clone https://github.com/<你的用户名>/cursor-one-click-chinese.git
cd cursor-one-click-chinese
一键汉化.bat
```

脚本会自动完成：

1. 检测 Cursor 安装位置
2. （如正在运行）关闭 Cursor
3. 安装微软官方中文语言包
4. 显示语言设为 `zh-cn`
5. 从 open-vsx 下载并安装「Cursor 专有界面汉化」扩展（固定版本 `0.0.11`，与本项目补丁严格匹配）
6. 给翻译引擎打增强补丁（修改前自动留 `.orig-backup` 备份）
7. 应用汉化（上游 1508 条 + 本项目补充词典）
8. 重新启动 Cursor

**换新电脑？** 装好 Cursor 和 Node.js，重复上面步骤即可，所有配置随脚本自动完成。

## Cursor 更新后界面变回英文了？

Cursor 每次升级会覆盖程序文件，汉化随之失效。**重新运行 `一键汉化.bat` 即可**（脚本可重复执行，自动还原旧补丁再打新的）。

## 恢复英文界面

双击 **`恢复英文.bat`**，或卸载「Cursor 专有界面汉化」扩展（它会自动还原补丁）。
若连菜单里的中文也不想要，把 `~/.cursor/argv.json` 里的 `"locale"` 改回 `"en"`。

## 常见问题

- **为什么有些地方还是英文？**
  模型名（如 `Cursor Grok 4.6 Medium`）、账号名、仓库名、品牌词保持原文是正常设计。
  其他漏翻欢迎提 Issue / PR（在 `scripts/dict/extras.json` 加一条即可）。
- **杀毒软件报警？**
  脚本的行为是「下载扩展 + 修改 Cursor 安装目录内的两个文件 + 重启进程」，属于补丁类工具的正常操作，
  代码全部开源可审，介意可先阅读 `scripts/install.mjs` 再运行。
- **支持 macOS / Linux 吗？**
  仅适配 Windows。上游扩展本身有 macOS（beta）支持，理论上可参考其文档手动操作，本仓库的脚本暂未适配。
- **安全吗？会不会上传我的代码？**
  不会。全部操作都在本机完成，唯一联网动作是从 open-vsx.org 下载语言包扩展。
  「Cursor 专有界面汉化」扩展本身经审查无网络行为（本地词典替换实现）。

## 项目结构

```
cursor-one-click-chinese/
├── 一键汉化.bat            # 双击运行：自动装 Node（可选）→ 调用安装脚本
├── 恢复英文.bat            # 双击运行：还原 Cursor 原始文件
├── scripts/
│   ├── install.mjs         # 安装主流程（8 步，见上文）
│   ├── restore.mjs         # 恢复英文
│   └── dict/extras.json    # 本项目补充词典（欢迎 PR）
└── assets/screenshot.png   # 效果截图
```

## 工作原理（给想看代码的你）

微软语言包负责 VS Code 底座（NLS 机制）；「Cursor 专有界面汉化」扩展的原理是：
向 `resources/app/out/vs/workbench/` 写入翻译后的 workbench 副本（`*_translated.js`），
并注入一个 DOM 文本替换引擎（`cursor.inject.js`），按词典对界面文本做精确匹配替换。
它自带备份、失败回滚和 `product.json` 校验和同步（避免 Cursor 弹「安装已损坏」警告）。
本项目脚本通过该扩展导出的 `applyPatch / revertPatch` 接口工作，
只是在其词典里合入补充条目、并对其引擎做两处小补丁。

## 致谢与许可

- [ggbdpq/cursor-loc](https://github.com/ggbdpq/cursor-loc)（MIT）—— Cursor 专有界面汉化扩展与补丁引擎
- [MS-CEINTL.vscode-language-pack-zh-hans](https://github.com/microsoft/vscode-loc)（MIT）—— 微软官方简体中文语言包
- 本项目代码以 [MIT](LICENSE) 开源。

> 免责声明：本项目是社区汉化工具，与 Cursor（Anysphere）官方无关；Cursor 大版本更新可能使补丁暂时失效。
