// 回归测试：侧栏/抽屉拖拽状态必须在布局变更完成时（onLayoutChanged）统一回写，
// 禁止在 Panel onResize（每个 pointermove 触发一次）里 setState。
// 背景：拖拽期间每帧 setState 会让整个工作台重渲染，且 defaultSize 随动触发
// react-resizable-panels 重布局，两者叠加造成拖拽抖动。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("resize state commits via Group onLayoutChanged, not per-frame Panel onResize", () => {
  assert.match(shell, /onLayoutChanged=\{handleLayoutChanged\}/);
  assert.doesNotMatch(shell, /onResize=\{handle/);
});

test("programmatic layout changes do not write back into React state", () => {
  // isUserInteraction=false 的变更（effect 同步、挂载）必须被拦截，
  // 否则 effect → resize → 回写 会形成反馈回路
  assert.match(shell, /if \(!meta\.isUserInteraction\) return;/);
});

test("splitter paints a single neutral diffused line", () => {
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
  const block = foundation.slice(foundation.indexOf(".splitter {"), foundation.indexOf(".v-splitter {"));
  // separator 本体不画线（shadcn bg-border 会盖过后加载的 utility），必须显式 transparent，
  // 视觉只留 ::before，避免双线
  assert.match(block, /\.splitter \{[\s\S]*?background:\s*transparent !important/);
  // 分隔条不掺主题色，任何 accent 主题下都不发绿
  assert.doesNotMatch(block, /--color-accent/);
});
