import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const toolCalls = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
// 重试行与工具卡共用同一套三态徽章语言：颜色改一处必须两处一起改。
const retryStep = readFileSync("src/renderer/src/components/session/turn/RetryStep.tsx", "utf8");
const timelineFormat = readFileSync("src/renderer/src/components/session/TimelineFormat.ts", "utf8");
const toolResult = readFileSync("src/renderer/src/components/agents/tool-result.tsx", "utf8");
const runtimeInjector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
// 文件链接打开路由（含栏级上下文 projectId 闸门）已迁入 useSessionFileLinks。
const app = readFileSync("src/renderer/src/hooks/workspace/useSessionFileLinks.ts", "utf8");
const fileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const sessionFilePathOpener = readFileSync("src/renderer/src/hooks/useSessionFilePathOpener.ts", "utf8");

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
	// 文件修改/工具名解析已迁往 shared/fileChanges（main/renderer 共用）。
	// 2027-02：collectSessionFileChanges 已不再经 TimelineFormat re-export（它只在文件内部供
	// collectRunFileChanges 使用），其余三个仍有外部消费者，故保留兼容导出。
	assert.match(timelineFormat, /export \{ getToolDiffTarget, getToolName, stripAnsi \};/);
	assert.match(timelineFormat, /export function formatDuration/);
	assert.match(timelineFormat, /export function getToolStatus/);
});

test("tool and thinking disclosure icons use right-for-collapsed down-for-expanded semantics", () => {
	assert.match(toolCalls, /\{expanded \? \(?[\s\S]*<ChevronDown[\s\S]*\)? : \(?[\s\S]*<ChevronRight/);
});

test("embedded tool result keeps formatted beUI output while the trigger remains manual", () => {
	assert.match(toolCalls, /import \{ ToolResult, ToolResultOutput \} from "\.\.\/agents\/tool-result";/);
	assert.match(toolCalls, /<ToolResult[\s\S]*?showHeader=\{false\}[\s\S]*?<ToolResultOutput>\{displayText\}<\/ToolResultOutput>/);
	// ToolCard's own disclosure stays opt-in even while a tool is streaming.
	assert.match(toolCalls, /useState\(props\.defaultOpen \?\? false\)/);
	// The official header's icon gutter is only used when that header is rendered.
	assert.match(toolResult, /className=\{cn\("pt-1\.5", showHeader && "pl-6"\)\}/);
	// Embedded ToolCard results stay in the timeline instead of gaining a second rounded surface.
	assert.match(toolResult, /className=\{cn\("min-w-0", showHeader && "overflow-hidden rounded-xl bg-muted\/80"\)\}/);
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
	assert.doesNotMatch(toolCalls, /className=\{`tool-card[\s\S]*?border border-border-subtle bg-bg-panel/);
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
	assert.match(readFileSync("src/renderer/src/components/session/turn/ToolStep.tsx", "utf8"), /onOpenFile=\{props\.onOpenFile\}/);
	assert.match(readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8"), /<ToolStep[\s\S]*?onOpenFile=\{props\.onOpenFile\}/);
	assert.match(readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), /"tool\.openFile": "打开文件"/);
	assert.match(readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"), /"tool\.openFile": "Open file"/);
	// 每个分屏栏在 injector 绑定自己的 runtime cwd/project；App 只消费这份上下文。
	assert.match(runtimeInjector, /paneProjectId = currentSessionRuntime\?\.projectId \?\? sessionRecord\?\.projectId/);
	assert.match(runtimeInjector, /baseDir: currentSessionRuntime\?\.cwd \?\? paneProject\?\.path/);
	assert.match(runtimeInjector, /projectId: paneProjectId \|\| undefined/);
	assert.match(runtimeInjector, /services\.onOpenFile\(path, line, paneFileContext\)/);
	assert.match(app, /if \(context && !projectId\)/);
	assert.match(app, /resolveFileLinkPath\(path, baseDir, projectRoot\)/);
	// 打开方式已抽到 hook：既校验 App 传递本栏授权，也校验 hook 消费同一份快照，
	// 不能继续只扫描旧 App 闭包，或只证明 hook 存在而漏掉实际接线。
	assert.match(app, /const\s+openSessionFilePath\s*=\s*useSessionFilePathOpener\(\{\s*onPreviewImage:\s*setPreviewImage,\s*viewFilePath\s*\}\)/);
	assert.match(app, /await\s+openSessionFilePath\(\s*resolved,\s*\{\s*line,\s*scope:\s*projectId\s*\?\s*\{\s*projectId\s*\}\s*:\s*undefined\s*\}\s*\)/);
	assert.match(sessionFilePathOpener, /viewFilePath\(\s*path,\s*undefined,\s*options\.line,\s*options\.scope,\s*options\.readOnly\s*===\s*true\s*\)/);
	// 预览读图必须带字节上界（COMPOSER_IMAGE_MAX_BYTES），不能无界 readBase64。
	assert.match(sessionFilePathOpener, /readBase64\(\s*path,\s*COMPOSER_IMAGE_MAX_BYTES,\s*options\.scope\s*\)/);
	assert.match(sessionFilePathOpener, /mimeType:\s*imageMimeTypeFromPath\(\s*path\s*\)/);
	assert.doesNotMatch(sessionFilePathOpener, /dataUrl\.match\(\/\^data:/);
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
	// #115 后工具 logo 走身份色 --color-tool（与思考靛紫成对、与状态色解耦，皮肤可覆盖），
	// 默认主题里它仍落回 info 蓝——锌灰主题下依然与 tertiary 拉开对比。
	assert.match(css, /\.tool-card-icon \{[\s\S]*?color:\s*var\(--color-tool\)/);
	assert.match(foundation, /--color-tool:\s*var\(--color-info\)/);
	const skillIcon = css.match(/\.tool-card--skill \.tool-card-icon \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(skillIcon, /color:\s*var\(--color-thinking\)/);
	assert.doesNotMatch(skillIcon, /--color-brand-purple/);
	assert.match(cards, /className="thinking-row-icon shrink-0"/);
	assert.match(web, /className="thinking-row-icon"/);
	assert.match(toolCalls, /className="tool-card-icon inline-flex shrink-0 items-center justify-center"/);
	assert.doesNotMatch(toolCalls, /className="tool-card-icon[^"\n]*text-text-tertiary/);
});

// 状态徽章（2026-10 对齐 ZCode 静默完成态）：running/stopped/error 保留 pill 一眼可辨；
// 普通完成不再渲染徽章——「无状态即成功」，完成行回归安静的一行灰（此前常驻绿色
// 「完成」徽章让整屏过程行比正文还吵）。ask_question 已回答保留低强调绿色 pill。
test("tool card keeps status pills only for non-default states; done rows go silent", () => {
	// 三态共用 shadcn Badge 组件
	assert.match(toolCalls, /import \{ Badge \} from "\.\.\/ui-shadcn\/badge"/);
	// running：outline + 琥珀色警示位（随 trigger 行紧凑化收紧内边距）
	// 徽章字号走会话正文轨道（text-chat-detail = 正文 −4px，默认档仍是 11px）
	assert.match(toolCalls, /variant="outline" className="gap-1 border-warning\/40 px-1 py-0 text-chat-detail text-warning"/);
	assert.match(toolCalls, /t\("tool\.statusRunning"\)/);
	// error：soft 红 outline（danger-soft 底 + danger 字 + 描边，与 running 琥珀同构）
	assert.match(toolCalls, /variant="outline" className="gap-1 border-danger\/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger"/);
	assert.match(toolCalls, /<CircleX size=\{9\}/);
	assert.match(toolCalls, /t\("tool\.statusError"\)/);
	// ask_question 已回答：保留 soft 绿低强调确认（「等待 → 已回答」的跃迁对它有信息量）
	assert.match(toolCalls, /variant="outline" className="gap-1 border-success\/40 bg-success-soft px-1 py-0 text-chat-detail text-success"/);
	assert.match(toolCalls, /t\("ask\.answered"\)/);
	// 普通完成静默：分支收尾返回 null，不再渲染绿色「完成」pill
	assert.match(toolCalls, /return null;\s*\}\)\(\);/);
	assert.doesNotMatch(toolCalls, /t\("tool\.statusDone"\)/);
	assert.doesNotMatch(toolCalls, /<CircleCheck/);
	assert.doesNotMatch(toolCalls, /variant="secondary" className="gap-1 px-1 py-0 text-chat-detail"/);
	// 重试行保持三态徽章语言不变：running 琥珀 / failed soft 红 / 成功 soft 绿
	// （重试是值得注意的异常事件，成功态对它有信息量，不随工具行静默化收窄）。
	assert.match(retryStep, /variant="outline" className="gap-1 border-warning\/40 px-1 py-0 text-chat-detail text-warning"/);
	assert.match(retryStep, /variant="outline" className="gap-1 border-danger\/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger"/);
	assert.match(retryStep, /variant="outline" className="gap-1 border-success\/40 bg-success-soft px-1 py-0 text-chat-detail text-success"/);
	assert.doesNotMatch(retryStep, /variant="secondary"/);
	// 旧实现「完成后不显示状态」的空文案分支已移除
	assert.doesNotMatch(toolCalls, /statusLabel/);
});

// 2026-10 对齐 ZCode 过程行排版：主标签 = 语义动词，作用对象进等宽 chip 单行截断，
// 原始工具名/完整参数/完成耗时撤到行 tooltip——行内只留扫读锚点，细节 hover 可达。
test("tool trigger shows verb label with mono object chip; details move to row tooltip", () => {
	// 主标签走 toolPhrase 的动词（不再直接渲染原始工具名）
	assert.match(toolCalls, /isAskCard \? t\("ask\.toolName"\) : phrase\.verb/);
	// chip：等宽 + 极浅底 + 单行截断，内容是作用对象（缺省回退 subtitle）
	assert.match(toolCalls, /min-w-0 flex-\[0_1_auto\] truncate rounded-\[var\(--radius-xs\)\] bg-\[color:color-mix\(in_srgb,var\(--color-text-primary\)_5%,transparent\)\] px-1\.5 font-mono text-chat-detail text-text-tertiary/);
	assert.match(toolCalls, /title=\{phrase\.object \|\| subtitle\}/);
	// 行 tooltip 承接撤下的信息：工具名 + 参数摘要 + 完成耗时
	assert.match(toolCalls, /const rowTitleParts = \[isSkillRead \? `skill:\$\{skillName\}` : toolName, subtitle\]\.filter\(Boolean\);/);
	assert.match(toolCalls, /t\("tool\.durationTitle"\)\} \$\{formatDuration\(durationMs\)\}/);
	// 耗时只在 running 有行内意义（活秒表）；完成后的秒数不再常驻行内
	assert.match(toolCalls, /\{status === "running" && \(\s*<span className="shrink-0 text-chat-detail tabular-nums text-text-tertiary"/);
	assert.doesNotMatch(toolCalls, /formatDuration\(durationMs \?\? 0\)/);
});
