import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const progress = readFileSync(
  "src/renderer/src/components/ui-shadcn/progress.tsx",
  "utf8",
);
const updateCard = readFileSync(
  "src/renderer/src/components/app/settings/AppUpdateCard.tsx",
  "utf8",
);
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("shadcn Progress exposes value through aria semantics", () => {
  assert.match(progress, /ProgressPrimitive\.Root/);
  // value 必须传给 Radix Root，由 Radix 生成 aria-valuenow；同时驱动 Indicator 位移。
  assert.match(progress, /value=\{value\}/);
  assert.match(progress, /bg-primary h-full w-full flex-1 transition-all/);
  assert.match(progress, /`translateX\(-\$\{100 - \(value \|\| 0\)\}%\)`/);
});

test("settings update card uses the shared Progress with an accessible label", () => {
  assert.match(
    updateCard,
    /<Progress value=\{download\.percent \?\? 0\} aria-label=\{t\("settings\.updateDownloading", \{ version: "" \}\)\} \/>/,
  );
  assert.doesNotMatch(updateCard, /update-progress-bar/);
  assert.doesNotMatch(updateCard, /style=\{\{ width:/);
});

test("legacy update modal and progress CSS are removed", () => {
  assert.doesNotMatch(surfaces, /\.update-modal\b/);
  assert.doesNotMatch(surfaces, /\.update-download-progress\b/);
  assert.doesNotMatch(surfaces, /\.update-progress-(?:track|bar|header|meta)\b/);
});
