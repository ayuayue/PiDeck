# 自定义与扩展

[返回首页](../README.md) · [使用指南](USER-GUIDE.md) · [插件契约](PLUGINS.md)

主题、提示词、键位与声明式插件都可通过文件管理；相对路径均以应用数据目录为起点。位置与备份范围见[整理数据](USER-GUIDE.md#整理数据)。

## 提示词库

首次启动会往数据目录的 `prompts/starter.json` 写一份起步提示词（代码理解、修改、调试、文档、计划、
学习、性能、安全），之后这个目录就是你的：可以加 `*.json` 或 `*.yaml`，每个文件一包。

```json
{
  "name": "团队提示词",
  "prompts": [
    {"title": "梳理改动", "category": "评审", "tags": ["git"], "body": "看看未提交的改动，用要点说明做了什么、有没有风险。"}
  ]
}
```

- 分类、搜索、标签都来自文件；点一条就放进当前会话的输入框，没有会话时复制到剪贴板
- 「保存当前草稿」写进 `prompts/user.json`，标题取正文第一行
- 起步包只在 `prompts/` 不存在时写一次，不会覆盖你的修改
- 「导入提示词包…」填一个 http(s) 链接（普通包 2 MB 上限），支持 `{prompts:[…]}` 或裸数组，`body` 与 `prompt` 两个字段名都认；小包合并进 `user.json`，大库的新增条目按不超过 4 MiB 的 `import-*.json` 分包保存，与全库已有标题重复的会跳过
- 「提示词商店…」填一个索引链接（`{packs:[{id,name,url}]}` 或数组），加载后一键导入整包；已导入的包会标记；「官方模板」离线导入 PiDeck 的 13 个编程提示词

## 主题文件

主题 `themes/mist.json`（也接受 `.yaml`）：

```json
{
  "name": "雾蓝",
  "author": "你",
  "appearance": "both",
  "radius": 10,
  "sans": "Inter",
  "mono": "JetBrains Mono",
  "tokens": {"font-sans": "Inter", "radius": "10px"},
  "light": {"background": "#f7f9fc", "inset": "#eef2f8", "accent": "#2563eb"},
  "dark":  {"background": "#0f1419", "inset": "#151d24"}
}
```

角色名与 NSGo 调色板一致：`background surface surfaceHover surfacePressed border text
textMuted accent accentHover accentPressed accentText danger warning success selection
focus scrollbar inset raised field fieldBorder line faint accentFill light onLight track
knob code info down`。

`appearance` 为 `light` / `dark` 时，选中该主题会强制对应外观；省略或 `both` 时跟随系统的浅色/深色。
浅深按钮只在两种都提供的主题上生效，会把该配色翻到另一侧并记住（`config.json` 的 `appearance`），
只声明一种外观的主题按下按钮时退回纸白/炭黑。
主题文件也可以直接写 shadcn/ui 的 `cssVars.theme/light/dark`，其中的 `var(--name)` 会解析，
非颜色变量进 `tokens`。

内置主题的视觉方向与对比度要求见[主题说明](THEMES.md)，文字尺寸与阅读层级见[字体规范](TYPOGRAPHY.md)。

## 插件

设置 → 扩展可启停、查看清单、打开市场或「新建插件…」。清单放在 `plugins/*.json` 或 `plugins/<名称>/plugin.json`，使用 `runtime: "pideck-v2"` 与 `schemaVersion: 2`。

| 贡献 | 作用 |
| --- | --- |
| `commands` / `keybindings` | 命令面板入口与未被占用的快捷键 |
| `themes` | 主题文件或内联主题 |
| `settings` | 开关、文本、数字、单选；宿主生成设置控件 |
| `agents` | 提示词 persona，供现有后端使用 |
| `hooks` | 监听既有事件，执行受限的声明式动作 |

插件不执行自己的代码；`send` 可启动智能体，内置命令有各自的副作用，安装前仍需核对清单。下载包的自定义 UI、函数与工具运行时尚未开放；「NSGo 插件预览」只演示随应用携带的内置包。

市场支持单文件清单安装和原位原子更新；下载、校验失败或本地文件已变化时保留旧文件。移除会放入 `trash/plugins/`，可在「已卸载的插件」恢复；同 ID 的设置与停用状态保留，回收区纳入设置备份。Electron 插件只作项目发现，不能直接装入 V2。

完整字段、动作、事件、安全边界与安装生命周期以[插件文档](PLUGINS.md)为准，示例可离线安装：

- [基础界面示例](../internal/workbench/plugin_examples/v2-ui-basics.json)
- [代码审查工具箱](../internal/workbench/plugin_examples/v2-review-kit.json)
- [文档工作流示例](../internal/workbench/plugin_examples/v2-writing-kit.json)
- [NSGo 会话统计预览](../internal/workbench/plugin_examples/nsgo-session-tools/README.md)

## 键位

设置 → 键位列出可绑定的命令。写法是修饰键加键名，`mod` 在 macOS 是 Command、其他平台是 Ctrl；
`ctrl`、`alt`、`shift`、`meta` 也可以组合。回车保存，留空取消绑定，「默认」恢复。

用户键位存在 `config.json`：

```json
{"keybindings": {"new-session": "ctrl+alt+n", "settings": ""}}
```

插件的 `contributes.keybindings` 只占用空闲键；与默认或用户键位冲突时会被跳过，并在
设置 → 键位 的「冲突」里说明。命令 id 不带冒号时，插件内命令会自动加上 `plugin:<插件 id>:`
前缀，内置命令则直接绑定。

## 语言

桌面、手机与 Web 支持简体中文、English、繁體中文、日本語、한국어、Русский 和 Français，译文随应用打包。设置 → 通用中的语言选择立即生效；默认跟随系统，不支持的系统语言回退到简体中文。桌面选择保存在 `config.json` 的 `language`，手机选择保存在 `remote.json`。

新增文案使用 `apptext.T("中文源文本")`，同时补齐 `internal/apptext/locales/` 下的 `en-US`、`zh-TW`、`ja-JP`、`ko-KR`、`ru-RU`、`fr-FR` 六份译文。翻译键、占位符与用户可见文案由测试守护，具体贡献要求见[工程规范](../AGENTS.md#46-国际化)。
