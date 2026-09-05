import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);
const toolCalls = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const timelineFormat = readFileSync(
  "src/renderer/src/components/session/TimelineFormat.ts",
  "utf8",
);
const toolResult = readFileSync(
  "src/renderer/src/components/agents/tool-result.tsx",
  "utf8",
);
const runtimeInjector = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const fileEditor = readFileSync(
  "src/renderer/src/hooks/useFileEditor.ts",
  "utf8",
);

test("tool-call rendering stays isolated behind the SurfaceComponents facade", () => {
  assert.match(toolCalls, /export const ToolCard = memo/);
  assert.match(toolCalls, /export const ToolGroupCard = memo/);
  assert.match(surface, /from "\.\/ToolCallComponents"/);
  assert.match(surface, /export \{ ToolCard, ToolGroupCard \}/);
  assert.doesNotMatch(surface, /function toolIcon\(toolName/);
  assert.doesNotMatch(surface, /const BUILT_IN_TOOLS = new Set/);
});

test("timeline tool rendering and message rows share formatting helpers", () => {
  assert.match(toolCalls, /from "\.\/TimelineFormat"/);
  assert.match(surface, /from "\.\/TimelineFormat"/);
  // 文件修改/工具名解析已迁往 shared/fileChanges（main/renderer 共用），TimelineFormat re-export 保持兼容
  assert.match(timelineFormat, /export \{ collectSessionFileChanges, getToolDiffTarget, getToolName, stripAnsi \};/);
  assert.match(timelineFormat, /export function formatDuration/);
  assert.match(timelineFormat, /export function getToolStatus/);
});

test("tool and thinking disclosure icons use right-for-collapsed down-for-expanded semantics", () => {
  assert.match(toolCalls, /\{expanded \? \([\s\S]*<ChevronDown[\s\S]*\) : \([\s\S]*<ChevronRight/);
});

test("embedded tool result keeps formatted beUI output while the trigger remains manual", () => {
  assert.match(
    toolCalls,
    /import \{ ToolResult, ToolResultOutput \} from "\.\.\/agents\/tool-result";/,
  );
  assert.match(
    toolCalls,
    /<ToolResult[\s\S]*?showHeader=\{false\}[\s\S]*?<ToolResultOutput>\{displayText\}<\/ToolResultOutput>/,
  );
  // ToolCard's own disclosure stays opt-in even while a tool is streaming.
  assert.match(toolCalls, /useState\(props\.defaultOpen \?\? false\)/);
  // The official header's icon gutter is only used when that header is rendered.
  assert.match(toolResult, /className=\{cn\("pt-1\.5", showHeader && "pl-6"\)\}/);
  // Embedded ToolCard results stay in the timeline instead of gaining a second rounded surface.
  assert.match(
    toolResult,
    /className=\{cn\("min-w-0", showHeader && "overflow-hidden rounded-xl bg-muted\/80"\)\}/,
  );
  assert.match(toolResult, /showHeader \? "p-3" : "py-1"/);
  assert.match(toolResult, /showHeader \? "px-2 pb-1\.5" : "pt-1"/);
  // Tool output follows PiDeck's semantic palette and historical UI-size scale, not Shiki's fixed GitHub colors.
  assert.match(toolResult, /text-\[length:var\(--font-size-caption\)\]/);
  assert.match(toolResult, /leading-\[1\.625\]/);
  assert.match(toolResult, /text-\[color:var\(--color-text-secondary\)\]/);
  assert.match(toolResult, /\[&_span\]:text-\[color:var\(--color-text-secondary\)\]/);
  // Standalone beUI ToolResult states use PiDeck semantics rather than fixed Tailwind hues.
  assert.match(toolResult, /if \(status === "running"\) return "text-info";/);
  assert.match(toolResult, /if \(status === "success"\) return "text-success";/);
  assert.match(toolResult, /if \(status === "error"\) return "text-danger";/);
  assert.match(toolResult, /return "text-text-tertiary";/);
  assert.doesNotMatch(toolResult, /text-blue-600|text-emerald-600|text-rose-600/);
  assert.match(toolResult, /if \(!showHeader\) return;/);
});

test("tool rows share thinking's borderless process-row chrome", () => {
  // Codex/Cursor 把思考与工具都做成过程行。卡片边框/面板底会让工具比思考更「块」。
  assert.doesNotMatch(
    toolCalls,
    /className=\{`tool-card[\s\S]*?border border-border-subtle bg-bg-panel/,
  );
  const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const cardRule = css.match(/\.tool-card \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(cardRule, ".tool-card rule must exist");
  assert.match(cardRule, /border:\s*0/);
  assert.match(cardRule, /background:\s*transparent/);
  assert.doesNotMatch(cardRule, /border:\s*1px/);
  // skill 身份改走图标色，不再给整行铺紫色底（那是卡片语言）
  const skillRule = css.match(/\.tool-card--skill \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(skillRule, /background:\s*transparent/);
  assert.doesNotMatch(skillRule, /border-color/);
});

test("edit/write diff cards expose an accessible open-file action", () => {
  // The action lives beside FileDiff rather than inside its disclosure trigger, avoiding nested buttons.
  assert.match(toolCalls, /onOpenFile\?: \(path: string\) => void/);
  assert.match(toolCalls, /className="mb-1\.5 flex min-w-0 items-start gap-1"/);
  assert.match(toolCalls, /aria-label=\{t\("tool\.openFile"\)\}/);
  assert.match(toolCalls, /title=\{t\("tool\.openFile"\)\}/);
  assert.match(toolCalls, /onClick=\{\(\) => props\.onOpenFile\?\.\(diffTarget\.path\)\}/);
  assert.match(toolCalls, /onOpenFile=\{props\.onOpenFile\}/);
  assert.match(
    readFileSync("src/renderer/src/components/session/turn/ToolStep.tsx", "utf8"),
    /onOpenFile=\{props\.onOpenFile\}/,
  );
  assert.match(
    readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8"),
    /<ToolStep[\s\S]*?onOpenFile=\{props\.onOpenFile\}/,
  );
  assert.match(
    readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
    /"tool\.openFile": "打开文件"/,
  );
  assert.match(
    readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
    /"tool\.openFile": "Open file"/,
  );
  // 每个分屏栏在 injector 绑定自己的 runtime cwd/project；App 只消费这份上下文。
  assert.match(runtimeInjector, /paneProjectId = currentSessionRuntime\?\.projectId \?\? sessionRecord\?\.projectId/);
  assert.match(runtimeInjector, /baseDir: currentSessionRuntime\?\.cwd \?\? paneProject\?\.path/);
  assert.match(runtimeInjector, /projectId: paneProjectId \|\| undefined/);
  assert.match(runtimeInjector, /services\.onOpenFile\(path, line, paneFileContext\)/);
  assert.match(app, /if \(context && !projectId\)/);
  assert.match(app, /resolveFileLinkPath\(path, baseDir, projectRoot\)/);
  assert.match(app, /viewFilePath\(resolved, undefined, line, fileAccessScope\)/);
  assert.match(app, /readBase64\(resolved, undefined, fileAccessScope\)/);
  assert.match(app, /mimeType: imageMimeTypeFromPath\(resolved\)/);
  assert.doesNotMatch(app, /dataUrl\.match\(\/\^data:/);
  // 授权随 editor tab 固化，异步加载不能改用后来聚焦的项目。
  assert.match(fileEditor, /fileAccessScope\?: ProjectFileAccessScope/);
  assert.match(fileEditor, /readFileContent\(path, maxBytes, scope\)/);
  assert.match(fileEditor, /writeFileContent\(path, content, scope\)/);
});

test("thinking and tool logos keep a distinct color even on the default zinc theme", () => {
  // 默认主题会把 brand-purple 洗成灰；过程行 logo 必须用独立 token，否则和 tertiary 糊在一起。
  const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
  const cards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
  const web = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
  assert.match(foundation, /--color-thinking:\s*#6366f1/);
  assert.match(foundation, /--color-thinking:\s*#818cf8/);
  assert.match(css, /\.thinking-row-icon \{[\s\S]*?color:\s*var\(--color-thinking\)/);
  assert.match(css, /\.tool-card-icon \{[\s\S]*?color:\s*var\(--color-info\)/);
  const skillIcon = css.match(/\.tool-card--skill \.tool-card-icon \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(skillIcon, /color:\s*var\(--color-thinking\)/);
  assert.doesNotMatch(skillIcon, /--color-brand-purple/);
  assert.match(cards, /className="thinking-row-icon shrink-0"/);
  assert.match(web, /className="thinking-row-icon"/);
  assert.match(toolCalls, /className="tool-card-icon inline-flex shrink-0 items-center justify-center"/);
  assert.doesNotMatch(toolCalls, /className="tool-card-icon[^"\n]*text-text-tertiary/);
});

// 状态徽章（借鉴 AI Elements Tool 的 getStatusBadge）：running/error/done 三态
// 图标+文案 pill，不再只有 running 有视觉反馈、error 只是灰字。
test("tool card renders tri-state status badges with icons and i18n labels", () => {
  // 三态共用 shadcn Badge 组件
  assert.match(toolCalls, /import \{ Badge \} from "\.\.\/ui-shadcn\/badge"/);
  // running：outline + 琥珀色警示位 + spinner（随 trigger 行紧凑化收紧内边距）
  assert.match(toolCalls, /variant="outline" className="gap-1 border-warning\/40 px-1 py-0 text-micro text-warning"/);
  assert.match(toolCalls, /t\("tool\.statusRunning"\)/);
  // error：soft 红 outline（danger-soft 底 + danger 字 + 描边，与 running 琥珀同构）
  assert.match(toolCalls, /variant="outline" className="gap-1 border-danger\/40 bg-danger-soft px-1 py-0 text-micro text-danger"/);
  assert.match(toolCalls, /<CircleX size=\{9\}/);
  assert.match(toolCalls, /t\("tool\.statusError"\)/);
  // done：secondary 低强调 + CircleCheck 图标；ask_question 已回答时文案替换为「已回答」
  assert.match(toolCalls, /variant="secondary" className="gap-1 px-1 py-0 text-micro"/);
  assert.match(toolCalls, /<CircleCheck size=\{9\}/);
  assert.match(toolCalls, /askCard\?\.answered \? t\("ask\.answered"\) : t\("tool\.statusDone"\)/);
  // 旧实现「完成后不显示状态」的空文案分支已移除
  assert.doesNotMatch(toolCalls, /statusLabel/);
});
