import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync(
  "src/renderer/src/styles/foundation.css",
  "utf8",
);

/**
 * 侧边栏卡片右侧对齐契约：会话/agent 行是 <button>，Chromium 中 button 的
 * width:auto 是 shrink-to-fit（宽度跟随内容），导致短名行过短、长名行超宽被裁。
 * 项目行是 <div>（width:100% 撑满）。修复：行类用 fill-available/stretch
 * 扣除 margin 后撑满，使会话卡片右边缘与项目卡片对齐。
 * 不能用 w-full(100%)：100% 不扣 margin-left，会向右溢出被 overflow-x:hidden 裁掉。
 */
test("session/agent sidebar rows use fill-available width, not content-sized auto", () => {
  // 每个目标类规则块：选择器到对应 {} 内容（支持组合选择器与注释）
  const ruleBlocks = foundation.match(/[^{}]*\{[^{}]*\}/g) ?? [];
  const targets = [".agent-row", ".session-row", ".agent-more-row", ".session-more-row"];
  for (const target of targets) {
    // 找「选择器恰为该 target（或组合选择器中含它）且非伪类/子代」的块
    const blocks = ruleBlocks.filter((block) => {
      const selectorPart = block.slice(0, block.indexOf("{"));
      return selectorPart
        .split(",")
        .map((s) => s.trim())
        .some((s) => s === target);
    });
    assert.ok(blocks.length > 0, `rule for ${target} not found`);
    for (const block of blocks) {
      // 剥离注释，避免注释里提到 width:auto 字样误触发；
      // 只断言包含 width 声明的块（另有仅调整 margin 的微调块不设 width）。
      const declarations = block.replace(/\/\*[\s\S]*?\*\//g, "");
      if (!/width\s*:/.test(declarations)) continue;
      assert.match(declarations, /width:\s*-webkit-fill-available/, `${target} should use fill-available`);
      assert.match(declarations, /width:\s*stretch/, `${target} should use stretch`);
      assert.doesNotMatch(declarations, /width:\s*auto/, `${target} must not use width:auto (button shrink-to-fit)`);
    }
  }
});
