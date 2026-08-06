import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const resizable = readFileSync("src/renderer/src/components/ui-shadcn/resizable.tsx", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

// 只测可执行代码，避免注释里的对照说明触发假阳性
const resizableCode = resizable.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sessionViewCode = sessionView.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const appShellCode = appShell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("resizable handle maps v4 aria-orientation opposite to group layout", () => {
  // WAI-ARIA + react-resizable-panels v4：
  // Group vertical → Separator aria-orientation=horizontal（横线铺满宽）
  // Group horizontal → Separator aria-orientation=vertical（竖线铺满高）
  assert.match(
    resizableCode,
    /aria-\[orientation=horizontal\]:h-px[\s\S]*aria-\[orientation=horizontal\]:w-full/,
  );
  // 禁止把 horizontal 当成竖线（这是导致 composer 拖不动的根因写法）
  assert.doesNotMatch(
    resizableCode,
    /aria-\[orientation=horizontal\]:h-full/,
  );
  assert.doesNotMatch(
    resizableCode,
    /aria-\[orientation=vertical\]:h-px/,
  );
  // 不再依赖 v2/v3 的 data-panel-group-direction / 旧组件名
  assert.doesNotMatch(resizableCode, /data-panel-group-direction/);
  assert.doesNotMatch(resizableCode, /PanelResizeHandle/);
  assert.doesNotMatch(resizableCode, /\bPanelGroup\b/);
});

test("session and shell use v4 Group orientation props only", () => {
  // 标签与 prop 允许跨行（终端布局修复后 Group 多了 groupRef，JSX 折行）
  assert.match(sessionViewCode, /<ResizablePanelGroup[\s\S]*?orientation="vertical"/);
  assert.match(appShellCode, /ResizablePanelGroup orientation="horizontal"/);
  assert.doesNotMatch(sessionViewCode, /\bdirection=/);
  assert.doesNotMatch(appShellCode, /\bdirection=/);
  // 禁止直接用 v2/v3 组件名；允许我们的 ResizablePanelGroup 封装名
  assert.doesNotMatch(sessionViewCode, /\bPanelResizeHandle\b/);
  assert.doesNotMatch(appShellCode, /\bPanelResizeHandle\b/);
  // Group 直系子节点只能是 Panel/Separator；大纲浮层必须在 Group 外
  assert.match(
    appShellCode,
    /<\/ResizablePanelGroup>[\s\S]*\{outlineContent\}/,
  );
  assert.doesNotMatch(
    appShellCode,
    /\{outlineContent\}[\s\S]*ResizableHandle[\s\S]*shell-panel-drawer/,
  );
});

test("splitter CSS uses v4 data-separator active state, not legacy is-resizing", () => {
  assert.match(foundation, /\.splitter\[data-separator="active"\]::before/);
  assert.doesNotMatch(foundation, /body\.is-resizing \.splitter/);
  assert.doesNotMatch(foundation, /body\.is-resizing \.v-splitter/);
  assert.doesNotMatch(foundation, /data-resizing/);
  // 纵向分隔条不再绘制独立线条（composer-box 顶部边框即视觉边界），只保留透明拖拽热区；
  // 宽度仍必须强制铺满，否则中间区域拖不动。
  assert.match(foundation, /\.v-splitter::before \{[\s\S]*content:\s*none;/);
  assert.match(foundation, /\.v-splitter \{[\s\S]*width:\s*100%\s*!important/);
});
