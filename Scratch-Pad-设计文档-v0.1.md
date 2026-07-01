# Scratch Pad 草稿本功能设计

> 版本：v0.1 · 2026-06-30 · 设计稿（待实现）

---

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 竞品参考](#2-竞品参考)
- [3. 功能规格](#3-功能规格)
- [4. 数据设计](#4-数据设计)
- [5. UI 与交互](#5-ui-与交互)
- [6. 动画规格](#6-动画规格)
- [7. 技术实现方案](#7-技术实现方案)
- [8. IPC 接口](#8-ipc-接口)
- [9. 文件结构](#9-文件结构)
- [10. 实现步骤与工时估算](#10-实现步骤与工时估算)
- [11. 风险与权衡](#11-风险与权衡)

---

## 1. 背景与目标

### 背景

PiDeck 是多 pi RPC Agent 会话的桌面工作台。用户在日常使用中，经常出现：
- 正在与某个 Agent 对话时突然产生与当前会话无关的灵感
- 需要临时记一段代码片段、会议笔记或待办清单
- 想记录中间材料供后续多个会话复用

目前 PiDeck 没有**不绑定项目的常驻临时记录区域**，用户只能切换到外部编辑器或开一个新的通用 Chat 会话承载临时内容，体验割裂。

### 目标

在 PiDeck 中增加一个**独立的草稿本（Scratch Pad）**：
- 从对话区头部快速呼出/收起
- 自动保存，重启恢复
- 支持 Markdown 格式编辑
- 动画优雅，不打断当前工作流

---

## 2. 竞品参考

| 产品 | 形态 | 特点 |
|---|---|---|
| **Proma Scratch Pad** | 标签栏首位常驻 tab | 自动保存到 `~/.proma/scratch-pad.md`，富文本 Markdown 编辑，导出到项目目录 |
| **Apple Notes 快速备忘录** | 全局快捷键 `Fn+Q` 或热角触发 | 角落浮层，写完消失，下次唤起内容还在 |
| **VS Code Scratch File** | 命令面板 `Create: New Scratch File` | 临时文件，不保存则丢弃 |
| **飞书妙记/备忘录** | 独立浮窗 | 不是编辑器场景 |

### 借鉴点

| 来源 | 借鉴项 |
|---|---|
| Proma | 自动保存到用户主目录的独立文件，重启恢复；导出功能 |
| Apple Notes 快速备忘录 | 快速呼出、写完即走的轻量优雅感 |
| VS Code Scratch File | 编辑器即开即用，无需新建文件流程 |

---

## 3. 功能规格

### 3.1 核心功能

| # | 功能 | 描述 |
|---|---|---|
| F1 | 呼出/收起 | 点击对话区头部按钮 → Scratch Pad 面板从右侧滑入；再次点击或外部点击/Esc 触发收起 |
| F2 | Markdown 编辑 | 编辑区直接编辑 Markdown 源码，支持 GFM、代码块语法高亮、Todo checkbox、KaTeX 公式 |
| F3 | 预览/源码切换 | 工具栏可切换"编辑"与"实时预览"模式 |
| F4 | 自动保存 | 停止输入 1.5s 后自动写入本地文件；面板收起时立即 flush；窗口关闭/应用退出前自动写盘 |
| F5 | 重启恢复 | 启动时读取本地文件恢复内容，记住上次是否停留在 Scratch Pad 状态 |
| F6 | 导出 Markdown | 可导出到：当前项目会话目录 / 当前工作区 / 系统对话框选任意位置 |
| F7 | 快捷键 | `Cmd/Ctrl + Shift + S` 呼出/收起；`Esc` 关闭浮层 |

### 3.2 不做的事

- 不做多标签/多草稿（单份全局草稿，与 Proma 对齐）
- 不做富文本 WYSIWYG（仅源码编辑 + 预览切换，降低复杂度）
- 不做跨设备同步（未来可考虑，MVP 不做）
- 不做与现有会话/文件树的直接交互（无"插入到聊天"等联动）

---

## 4. 数据设计

### 4.1 存储位置

```
~/.pideck/scratch-pad.md        ← 草稿正文
~/.pideck/scratch-pad.meta.json ← 元数据（最后编辑时间、打开状态等）
```

### 4.2 元数据格式

```json
{
  "version": 1,
  "lastEditedAt": 1719734400000,
  "wasOpen": true,
  "cursorPosition": 450
}
```

### 4.3 状态流转

```
[用户输入] --1.5s debounce--> [写入 .md 文件]
[面板关闭] --> [立即 flush 一次]
[App 退出] --> [同步写入一次]
[App 启动] --> [读取 .md + .meta.json 恢复]
```

### 4.4 异常处理

| 场景 | 处理 |
|---|---|
| 文件不存在 | 创建空文件，视为"全新的草稿本" |
| 磁盘写入失败 | 静默失败 + Input 框右上角短暂红色提示（3s 后消失） |
| 文件被外部修改 | 取最新 mtime 版本，弹出 toast 提示用户选择保留哪个版本 |
| 内容超长大文件 | 不做特殊限制，但建议 1MB 以上时禁用实时预览（懒渲染） |

---

## 5. UI 与交互

### 5.1 入口位置

**对话区头部右上角**，与其他操作按钮（模型选择、New Session、Settings 等）同行：

```
┌────────────────────────────────────────────────────────┐
│  ←  PiDeck · 项目名                          [📝] [⟳] │
│                                                        │
│  [对话内容...]                                          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

按钮使用 Pencil 或 StickyNote 图标，hover 时显示 tooltip "Scratch Pad (⌘⇧S)"，当前 Scratch Pad 打开时图标切换为高亮态（填充色或颜色强调）。

### 5.2 面板形态

**右侧抽屉式面板**，整体结构与终端 Dock 不冲突：

```
┌────────────────────────────────┬───────────────────────┐
│                                │  📝 Scratch Pad   [×] │
│      对话内容                  │───────────────────────│
│                                │  [编辑 | 预览]  [导出] │
│                                │───────────────────────│
│                                │                       │
│                                │  (编辑区 / 预览区)     │
│                                │                       │
│                                │                       │
├────────────────────────────────┴───────────────────────┤
│  [Composer 输入框]                      [Enter 发送]  │
└──────────────────────────────────────────────────────┘
```

### 5.3 面板规格

| 属性 | 值 |
|---|---|
| 宽度 | 460px（桌面）/ 80vw（< 700px 窄屏）|
| 最大宽度 | 640px |
| 最小宽度 | 320px |
| 高度 | 占满对话区高度（底部对齐 Composer） |
| z-index | 高于消息列表，低于模态对话框 |
| 背景 | `--color-surface`（自动适配暗色） |
| 边框 | 左侧 1px `--color-border` |

### 5.4 编辑区

- 使用轻量 `textarea`（非 Monaco），保持启动性能
- 字体使用 `--font-family-commit-mono`（等宽，代码友好）
- 字号 `--font-size-sm`，行高 `--line-height-base`
- 支持标准 Markdown 快捷键缩进（Tab 缩进等）
- 占位符提示文字：开始记录灵感… （placeholder）

### 5.5 预览区

- 复用现有 `AppParts` 中的 Markdown 渲染管线（react-markdown + remarkGfm + rehypeKaTeX + remarkMath）
- Mermaid 图表懒加载渲染（与聊天消息一致）
- 预览区为只读，点击"编辑"切回源码模式

### 5.6 工具栏

| 按钮 | 快捷键 | 行为 |
|---|---|---|
| 编辑/预览切换 | — | 切换显示模式 |
| 导出 | — | 弹出选择：项目目录 / 工作区 / 任意位置 |
| 关闭 | Esc | 收起草稿本 |

---

## 6. 动画规格

### 6.1 面板滑入/滑出

```css
/* 进入 */
@keyframes scratch-pad-enter {
  from {
    transform: translateX(100%);
    opacity: 0.6;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 退出 */
@keyframes scratch-pad-exit {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}

.scratch-pad-panel {
  animation: scratch-pad-enter 280ms cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

.scratch-pad-panel.closing {
  animation: scratch-pad-exit 220ms cubic-bezier(0.4, 0, 1, 1) forwards;
}
```

### 6.2 关键动画参数

| 阶段 | 时长 | 缓动函数 | 说明 |
|---|---|---|---|
| 滑入 | 280ms | cubic-bezier(0.32, 0.72, 0, 1) | 先慢后快自然停住，有"吸入感" |
| 滑出 | 220ms | cubic-bezier(0.4, 0, 1, 1) | 快速退出，干脆利落 |
| 遮罩显隐 | 200ms | ease-out | 面板背景遮罩 |
| 图标状态切换 | 150ms | ease | 入口图标点击反馈 |

### 6.3 缓动函数说明

`cubic-bezier(0.32, 0.72, 0, 1)` 是 Apple 风格的"减速入"曲线：
- 起始速度中等（0.32）
- 中途加速（0.72）
- 末尾减速至停止

整体感受像 **iOS 通知中心/控制中心** 的滑入动画——温柔、克制、不打扰。

### 6.4 遮罩层

```css
.scratch-pad-overlay {
  background: var(--color-scrim, rgba(0, 0, 0, 0.25));
  backdrop-filter: blur(2px);
  transition: opacity 200ms ease-out;
}
```

- 半透暗色遮罩 + 轻微毛玻璃
- 点击遮罩 = 关闭 Scratch Pad
- 不影响左侧列表和终端的交互

---

## 7. 技术实现方案

### 7.1 架构概览

```
┌────────────────────────────────────────┐
│              Renderer                   │
│  ┌─────────────────────────────────┐   │
│  │  ChatHeader                     │   │
│  │  └── ScratchPadButton (icon)    │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  ScratchPadPanel                │   │
│  │  ├── Toolbar                     │   │
│  │  ├── Editor (textarea)           │   │
│  │  └── Preview (Markdown)          │   │
│  └─────────────────────────────────┘   │
│              ↕ IPC                      │
│  ┌─────────────────────────────────┐   │
│  │  Preload (contextBridge)        │   │
│  └─────────────────────────────────┘   │
└────────────────────────────────────────┘
                ↕
┌────────────────────────────────────────┐
│           Main Process                 │
│  ┌─────────────────────────────────┐   │
│  │  scratchPad.ts                  │   │
│  │  ├── load() → 读文件            │   │
│  │  ├── save() → 写文件            │   │
│  │  └── export() → 对话框 + 写入    │   │
│  └─────────────────────────────────┘   │
└────────────────────────────────────────┘
```

### 7.2 状态管理（渲染进程）

新增 hook `useScratchPad`：

```ts
type ScratchPadState = {
  isOpen boolean;           // 面板是否打开
  content: string;          // 当前内容
  mode: 'edit' | 'preview'; // 编辑/预览模式
  isSaving: boolean;        // 保存状态（用于 UI 反馈）
  lastSavedAt: number;      // 上次成功保存时间
};

// Actions
open(), close(), toggle()
setContent(value), toggleMode()
save() → debounced auto-save
export() → 弹出对话框
```

### 7.3 自动保存策略

```ts
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoSave(content: string) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    setIsSaving(true);
    const ok = await api.scratchPad.save(content);
    setIsSaving(false);
    if (ok) setLastSavedAt(Date.now());
    else showSaveError();  // 红色提示 3s
  }, 1500);
}
```

### 7.4 快捷键实现

复用现有的全局快捷键注册方式，在 `App.tsx` 中监听 `Cmd/Ctrl + Shift + S`：

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      toggleScratchPad();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

---

## 8. IPC 接口

### 8.1 主进程（main）新增处理器

在 `src/main/` 中新增 `scratchPad.ts`：

```ts
// 读取草稿内容
ipcMain.handle('scratchPad:load', async (): Promise<{ content: string; meta: ScratchPadMeta }> => {
  const filePath = getScratchPadPath();
  const metaPath = getScratchPadMetaPath();
  // 读取两个文件，返回合并结果
});

// 保存草稿内容
ipcMain.handle('scratchPad:save', async (_e, content: string): Promise<boolean> => {
  const filePath = getScratchPadPath();
  const metaPath = getScratchPadMetaPath();
  // 写入内容 + 更新 meta.lastEditedAt
  // 异常时扔出，由 renderer 处理
});

// 导出草稿到指定路径
ipcMain.handle('scratchPad:export', async (_e, targetPath: string): Promise<boolean> => {
  // 1. showSaveDialog 让用户选择路径
  // 2. 将当前内容复制到目标路径
});
```

### 8.2 Preload 暴露

在现有 preload 中增加 `scratchPad` 命名空间：

```ts
scratchPad: {
  load: () => ipcRenderer.invoke('scratchPad:load'),
  save: (content: string) => ipcRenderer.invoke('scratchPad:save', content),
  export: (targetPath: string) => ipcRenderer.invoke('scratchPad:export', targetPath),
}
```

---

## 9. 文件结构

```
PiDeck体验优化/
├── src/
│   ├── main/
│   │   └── scratchPad.ts                ← 新增：主进程读写/导出逻辑
│   ├── preload/
│   │   └── index.ts                     ← 修改：暴露 scratchPad API
│   └── renderer/
│       └── src/
│           ├── App.tsx                  ← 修改：加按钮 + 快捷键 + 面板挂载
│           ├── components/
│           │   └── scratchPad/
│           │       ├── ScratchPadPanel.tsx   ← 新增：面板主体
│           │       ├── ScratchPadButton.tsx  ← 新增：头栏入口按钮
│           │       └── ScratchPadToolbar.tsx ← 新增：编辑/预览/导出工具栏
│           ├── hooks/
│           │   └── useScratchPad.ts          ← 新增：状态 + 自动保存 hook
│           └── styles/
│               └── scratch-pad.css           ← 新增：动画与面板样式
```

---

## 10. 实现步骤与工时估算

| # | 任务 | 文件 | 估算（行） |
|---|---|---|---|
| 1 | 主进程 `scratchPad.ts`（读写文件 + 导出对话框） | `main/scratchPad.ts` | 60 |
| 2 | Preload 暴露 + types 扩展 | `preload/index.ts`, `shared/types.ts` | 25 |
| 3 | `useScratchPad` hook（状态 + debounce 自动保存） | `hooks/useScratchPad.ts` | 80 |
| 4 | `ScratchPadButton`（入口按钮） | `components/scratchPad/ScratchPadButton.tsx` | 30 |
| 5 | `ScratchPadToolbar`（编辑/预览切换 + 导出） | `components/scratchPad/ScratchPadToolbar.tsx` | 50 |
| 6 | `ScratchPadPanel`（面板主体 + 编辑器 + 预览） | `components/scratchPad/ScratchPadPanel.tsx` | 150 |
| 7 | 面板样式 + 动画 | `styles/scratch-pad.css` | 80 |
| 8 | App.tsx 集成（按钮 + 快捷键 + 状态注入） | `App.tsx` | 40 |
| 9 | i18n（新增文案） | `i18n.ts` | 15 |
| **合计** | | | **~530 行** |

### 开发顺序建议

1. **P0 数据层**：主进程 + Preload + types（步骤 1、2）
2. **P1 状态层**：useScratchPad hook（步骤 3）
3. **P2 UI 组件**：Button → Toolbar → Panel（步骤 4、5、6）
4. **P3 外观**：样式 + 动画（步骤 7）
5. **P4 集成**：App.tsx + i18n（步骤 8、9）

---

## 11. 风险与权衡

### 11.1 风险项

| 风险 | 影响 | 缓解 |
|---|---|---|
| 与终端 Dock 的区域冲突 | 面板与终端同时打开时视觉拥挤 | 面板与终端可以并存（面板右侧，终端底部），但优先保证 Composer 不被遮挡 |
| textarea 大文件卡顿 | 内容过长时输入体验下降 | MVP 接受，后续可做虚拟滚动或懒渲染 |
| 自动保存写盘失败 | 数据丢失风险 | 收起时立即同步写入 + window close 前 flush + 写入失败红色提示 |

### 11.2 技术权衡

| 选择 | 理由 |
|---|---|
| textarea 而非 Monaco | Scratch Pad 定位是"轻量草稿"，Monaco 的 Web Worker 体积和启动开销不值得 |
| 单份全局草稿 | 对齐 Proma 的做法；多头草稿增加状态复杂度，MVP 不做 |
| 右侧抽屉而非居中浮层 | 对话区本身就是右向阅读流；抽屉与终端、右侧面板体系一致，视觉统一 |
| 源码编辑 + 预览切换 | 富文本编辑器成本高；Markdown 源码 + 预览切换满足大多数场景 |

---

## 附录：草稿本元数据格式

```json
{
  "version": 1,
  "lastEditedAt": 0,
  "wasOpen": false,
  "cursorPosition": 0
}
```

- `version`：未来元数据 schema 升级时的兼容标识
- `lastEditedAt`：毫秒时间戳，UI 显示"上次保存时间"
- `wasOpen`：启动时是否自动展开草稿本
- `cursorPosition`：恢复时的光标位置（可选，MVP 可不做）
