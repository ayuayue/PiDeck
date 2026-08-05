import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const emptyState = readFileSync(
  "src/renderer/src/components/session/ProjectEmptyState.tsx",
  "utf8",
);
const surfaceParts = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);
const sessionActions = readFileSync(
  "src/renderer/src/hooks/useSessionActions.ts",
  "utf8",
);
const composerComponents = readFileSync(
  "src/renderer/src/components/session/ComposerComponents.tsx",
  "utf8",
);
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("project empty state is shared by normal and chat projects when no session is open", () => {
  // 无 currentSessionId 时渲染统一 ProjectEmptyState（普通项目 / Chat 项目共用）。
  assert.match(app, /ProjectEmptyState/);
  assert.match(app, /<ProjectEmptyState/);
  assert.match(app, /currentSessionId/);
  assert.match(app, /runCreateSessionDraft/);
  assert.match(app, /runCreateAnonymousSession/);
  assert.match(app, /addProject/);
});

test("project empty state reuses pi-branded EmptyState and offers quick actions", () => {
  // 视觉与 pi 品牌 EmptyState 完全一致（复用同一组件，而非复制结构）
  assert.match(emptyState, /import \{ EmptyState \} from \"\.\/SurfaceParts\"/);
  assert.match(emptyState, /<EmptyState/);
  assert.match(emptyState, /onCreateAgent/);
  assert.match(emptyState, /onCreateAnonymous/);
  assert.match(emptyState, /onAddProject/);
  assert.match(emptyState, /t\("app\.createAgent"\)/);
  assert.match(emptyState, /t\("app\.anonymousChatShort"\)/);
  assert.doesNotMatch(emptyState, /app\.anonymousChatHint/);
  assert.match(emptyState, /t\("app\.addProject"\)/);
  // 品牌 tagline/subtitle 来自 EmptyState 而非项目标题，普通/聊天项目无差异
  assert.doesNotMatch(emptyState, /t\("app\.projectEmptyTitle"/);
  assert.doesNotMatch(emptyState, /t\("app\.emptyNoProjectTitle"/);
  assert.match(emptyState, /actions=\{/);
  // footer 为启动配置 meta 列表（模型/思考级别），等宽字体 + 浅下划线表达可改参数
  assert.match(emptyState, /footer=\{/);
  // 主按钮用前景/背景反色而非中性灰 accent，保证浅色下纯黑、暗色下纯白
  assert.match(emptyState, /bg-foreground[\s\S]*text-background/);
});

test("empty state keeps compact configuration controls for first-run setup", () => {
  // 模型/思考选择器统一走共享 CommandPicker 面板（与 Git 面板等同一套选择器组件）
  assert.match(emptyState, /<CommandPickerPanel/);
  assert.match(emptyState, /<CommandPickerGroup/);
  assert.match(emptyState, /<CommandItem/);
  assert.match(emptyState, /<Check className=/);
  assert.match(emptyState, /title=\{modelChoice/);
  assert.match(emptyState, /thinkingPickerOpen/);
  assert.match(emptyState, /WELCOME_MODEL_KEY/);
  assert.match(emptyState, /WELCOME_THINKING_KEY/);
});

test("project empty state reads default model/thinking from pi config via IPC, not localStorage", () => {
  // 通过 config.getSettings 读取（renderer→preload→IPC），不直接用 Node/本地偏好。
  assert.match(emptyState, /desktopApi\.config[\s\S]{0,80}getSettings/);
  assert.match(emptyState, /defaultProvider/);
  assert.match(emptyState, /defaultModel/);
  assert.match(emptyState, /defaultThinkingLevel/);
  assert.doesNotMatch(emptyState, /readWelcomeModelPreference|readWelcomeThinkingPreference/);
  assert.match(emptyState, /useState<AvailableModel\[\]>/);
  assert.doesNotMatch(emptyState, /require\(|node:|fs\.read|process\.env|ipcRenderer/);
});

test("empty state model fallback matches main sessionsCatalogCreateDraft rule via getModels", () => {
  // settings 未给全 defaultProvider+defaultModel 时回退 models.json 首 provider 首 model，
  // 与主进程 createDraft 规则一致。
  assert.match(emptyState, /desktopApi\.config[\s\S]{0,60}getModels/);
  assert.match(emptyState, /modelsParsed\.providers/);
  assert.match(emptyState, /Object\.keys\(providersObj\)\[0\]/);
  assert.match(emptyState, /models\[0\]\?\.id/);
  assert.match(emptyState, /\$\{providerName\}\/\$\{firstModel\}/);
  // 只读 provider 名与 model id，不触碰/输出 apiKey、baseUrl 等敏感字段。
  assert.doesNotMatch(emptyState, /apiKey|token\b|baseUrl/);
});

test("project empty state narrows remote config values with unknown guard, not as-casts", () => {
  // 远端 config 是 Record<string, unknown>，字段必须经 typeof 收窄后用，禁 as 强转。
  assert.doesNotMatch(emptyState, /parsed as\s*\{/);
  assert.doesNotMatch(emptyState, / as [A-Za-z_{}\[\] ]+\{/);
  assert.match(emptyState, /typeof parsed\.defaultProvider === "string"/);
  assert.match(emptyState, /typeof parsed\.defaultModel === "string"/);
  assert.match(emptyState, /typeof parsed\.defaultThinkingLevel === "string"/);
});

test("draft creation no longer spreads renderer welcome prefs over pi config", () => {
  // 主进程 createDraft 已按 pi 配置 auto-fill；渲染层不再无条件覆盖。
  assert.doesNotMatch(sessionActions, /readWelcomeModelPreference|readWelcomeThinkingPreference/);
  assert.match(sessionActions, /api\.sessions\.createDraft/);
});

test("composer bottom bar default model/thinking prefer pi-config record over welcome localStorage", () => {
  assert.doesNotMatch(composerComponents, /readWelcomeModelPreference|readWelcomeThinkingPreference|welcomeModel/);
  assert.match(composerComponents, /props\.state\?\.thinkingLevel \?\? props\.record\?\.thinkingLevel/);
  assert.match(composerComponents, /props\.record\?\.model/);
});

test("shadcn Empty primitive was removed in favor of pi-branded EmptyState", () => {
  // 项目空态与 timeline 空态统一走 EmptyState，原 ui-shadcn/empty 原语已删除
  const emptyPrimitivePath = "src/renderer/src/components/ui-shadcn/empty.tsx";
  assert.equal(
    (() => {
      try {
        readFileSync(emptyPrimitivePath, "utf8");
        return false;
      } catch {
        return true;
      }
    })(),
    true,
    "ui-shadcn/empty.tsx should be deleted",
  );
});

test("new empty-state copy is bilingual", () => {
  for (const key of [
    "app.emptyProjectTitleLead",
    "app.emptyProjectTitleAccent",
    "app.emptyProjectTitlePunct",
    "app.emptyNoProjectTitle",
    "app.emptyHasProject",
    "app.emptyNoProject",
  ]) {
    assert.ok(zh.includes(`"${key}"`), `${key} zh-CN copy must exist`);
    assert.ok(en.includes(`"${key}"`), `${key} en-US copy must exist`);
  }
  // 旧的项目标题/描述 key 已随 shadcn Empty 删除，JSX 不再引用
  assert.doesNotMatch(zh, /"app\.projectEmptyTitle"/);
  assert.doesNotMatch(en, /"app\.projectEmptyTitle"/);
  // JSX 不硬编码中英文可见文案
  assert.doesNotMatch(emptyState, />[^<]*(在|开始工作|Start working|尚未)</);
});
