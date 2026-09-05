import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const heading = readFileSync(
  "src/renderer/src/components/ui-shadcn/section-heading.tsx",
  "utf8",
);
const storage = readFileSync(
  "src/renderer/src/components/app/settings/SettingsStorageTab.tsx",
  "utf8",
);
const piSettings = readFileSync(
  "src/renderer/src/config/SettingsTab.tsx",
  "utf8",
);
const feedback = readFileSync(
  "src/renderer/src/features/feedback/FeedbackDialog.tsx",
  "utf8",
);

test("shared SectionHeading defines one title and description hierarchy", () => {
  assert.match(heading, /text-sm font-semibold leading-5 text-foreground/);
  assert.match(heading, /text-xs font-normal leading-4 text-muted-foreground/);
  assert.match(heading, /props\.description/);
});

test("settings and Pi management sections use the shared heading", () => {
  assert.match(storage, /import \{ SectionHeading \} from "\.\.\/\.\.\/ui-shadcn\/section-heading"/);
  assert.match(storage, /className="settings-section-header pb-2"/);
  assert.match(piSettings, /import \{ SectionHeading \} from "\.\.\/components\/ui-shadcn\/section-heading"/);
  assert.equal((piSettings.match(/<SectionHeading/g) ?? []).length, 5);
  assert.doesNotMatch(piSettings, /config-settings-section-title/);
});

test("feedback uses one accessible dialog title and shared field headings", () => {
  // DialogTitle 现随 FeedbackDialog 组件内嵌（不再由 SessionActionOverlays 提供），
  // 标题可见（非 sr-only）且唯一。
  assert.match(feedback, /<DialogTitle className="flex items-center gap-2 text-base">[\s\S]*?\{t\("feedback\.title"\)\}[\s\S]*?<\/DialogTitle>/);
  assert.equal((feedback.match(/<SectionHeading/g) ?? []).length, 4);
  assert.doesNotMatch(feedback, /modal-header feedback-header/);
});
