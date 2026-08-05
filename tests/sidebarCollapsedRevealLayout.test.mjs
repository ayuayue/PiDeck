import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();

test("collapsed sidebar reveal does not override the v3 conversation list layout", () => {
  assert.doesNotMatch(
    css,
    /\.conversation-list \{\n  display: block;/,
  );
  assert.match(
    css,
    /\.chat-list-pane\.v3-braun \.sidebar-body \.conversation-list \{[\s\S]*?display: flex;/,
  );
  // The hover-reveal selectors were removed; restoring the sidebar is now
  // handled by a titlebar button which does not depend on CSS hover rules.
});


test("collapsed sidebar offsets the session tab bar from the floating restore button", () => {
  assert.match(
    css,
    /\.wechat-shell\.list-collapsed \.chat-header,\n\.wechat-shell\.list-collapsed \.session-tabs-bar \{\n  padding-left: 56px;/,
  );
  assert.doesNotMatch(css, /\.list-collapsed \.chat-list-pane::before/);
  assert.match(css, /\.list-toggle-native\.floating \{[\s\S]*?top: calc\(var\(--window-drag-height\) \+ 4px\);/);
});
