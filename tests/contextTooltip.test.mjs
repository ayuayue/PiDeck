import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);
const tooltip = readFileSync(
  "src/renderer/src/components/ui-shadcn/tooltip.tsx",
  "utf8",
);
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("context tooltip exposes a titled, readable detail surface", () => {
  // 标题、分隔和对比度契约避免统计行再次退化成无层级的黑色文字块。
  assert.match(surface, /t\("ctx\.detail\.title"\)/);
  assert.match(surface, /border-b border-border\/70/);
  assert.match(surface, /text-popover-foreground/);
  assert.match(surface, /text-muted-foreground/);
  assert.match(surface, /arrowClassName=/);
  assert.match(tooltip, /arrowClassName\?: string/);
  assert.match(zh, /"ctx\.detail\.title": "上下文详情"/);
  assert.match(en, /"ctx\.detail\.title": "Context details"/);
});
