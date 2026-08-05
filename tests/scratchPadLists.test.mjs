import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { continueListOnNewline, normalizeOrderedLists, prepareTaskListPreview, toggleTaskCheckbox } = loadTsCommonJs(
  "src/renderer/src/components/scratchPad/scratchPadLists.ts",
);

test("scratch pad preview pads marker-only task lines so micromark parses them", () => {
  const padded = prepareTaskListPreview("- [x]\n- [ ] jiush\n- [ ]  ");
  const lines = padded.split("\n");

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^- \[x\] \u200b$/);
  assert.equal(lines[1], "- [ ] jiush");
  assert.match(lines[2], /^- \[ \] \u200b$/);
});

test("scratch pad preview renders task checkboxes as small native inputs", () => {
  const panel = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");

  assert.match(panel, /text=\{prepareTaskListPreview\(content\)\}/);
  assert.match(panel, /scratch-pad-checkbox/);
  assert.match(panel, /key=\{`scratch-pad-\$\{content\}`\}/);
  assert.doesNotMatch(panel, /input: \(\{ \.\.\.inputProps \}\) => \(\s*<Input/);
});

test("scratch pad toggles a task only when its checkbox itself is clicked", () => {
  const panel = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");

  assert.match(panel, /if \(!target\.closest\('input\[type="checkbox"\]'\)\) return;/);
  // 任务行 li 不再整体可点：onClick 仅出现在 checkbox 判定处
  assert.match(panel, /onClick=\{/);
});

test("scratch pad toggles only the task marker on the selected Markdown line", () => {
  const source = "- [ ] first\n- [x] second\nplain [ ] text";

  assert.equal(toggleTaskCheckbox(source, 0), "- [x] first\n- [x] second\nplain [ ] text");
  assert.equal(toggleTaskCheckbox(source, 1), "- [ ] first\n- [ ] second\nplain [ ] text");
  assert.equal(toggleTaskCheckbox(source, 2), source);
});

test("scratch pad renumbers ordered Markdown after a middle item is deleted", () => {
  assert.equal(
    normalizeOrderedLists("1. first\n3. third\n4. fourth"),
    "1. first\n2. third\n3. fourth",
  );
  assert.equal(
    normalizeOrderedLists("1. first\n\n3. separate list"),
    "1. first\n\n3. separate list",
  );
});

test("scratch pad continues an ordered list without leaving duplicate markers", () => {
  const result = continueListOnNewline("1. first\n2. second", "1. first".length);

  assert.equal(result.next, "1. first\n2. \n3. second");
  assert.equal(result.cursor, "1. first\n2. ".length);
});
