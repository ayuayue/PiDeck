import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
// 扩展 UI 请求闸已迁入 extensionUiGate.ts（AgentManager 拆分 Wave 4B）
const uiGate = readFileSync("src/main/pi/extensionUiGate.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const runtimeInjector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
const runtimeUi = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
const composer = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const toolCards = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");

test("catalog scans attach matching existing runtimes in the main process", () => {
	assert.match(coordinator, /attachCatalogRuntimes\(/);
	assert.match(main, /attachCatalogRuntimes\(records\)/);
	assert.match(sessionIpc, /sessionsCatalogList[\s\S]*mergeScanned[\s\S]*attachCatalogRuntimes/);
});

test("unbound interactive UI is cancelled and cannot be surfaced as Session UI", () => {
	assert.match(main, /cancelUnboundUiRequest/);
	assert.match(main, /"batch_ask"/);
	assert.match(main, /sendUIResponse\([^,]+,[^,]+, \{ cancelled: true \}\)/);
	assert.doesNotMatch(app, /bindSessionRuntimeAtom|bindSessionRuntime\(/);
	assert.doesNotMatch(app, /api\.agents\.onUiRequest\(/);
});

test("Ask Question keeps normalized batch requests pending for the session responder", () => {
	assert.match(coordinator, /method === "batch_ask"/);
	assert.match(uiGate, /hasCustomOption/);
	assert.match(uiGate, /option\.startsWith\("✎"\)/);
	assert.match(uiGate, /allowOther: typed\.allowOther === true \|\| hasCustomOption/);
	assert.match(agentManager, /questions: batchQuestions/);
	assert.match(agentManager, /uiGate\.handleUIRequest\(agentId, typed\)/);
});

test("session UI requests remain generation-bound and render in the timeline footer", () => {
	assert.match(runtimeInjector, /createSessionRuntimeUiResponder\(/);
	assert.match(runtimeInjector, /sessionId: currentSessionId/);
	assert.match(runtimeInjector, /runtimeGeneration: latest\.runtimeGeneration/);
	assert.match(runtimeInjector, /<SessionRuntimeUiOverlay/);
	assert.match(runtimeUi, /ask-inline-bar(?:\s+ask-inline-bar--active)?/); // Ask 继续使用稳定的布局锚点类
	assert.match(runtimeUi, /ApprovalCard/);
	assert.doesNotMatch(runtimeUi, /className="modal-backdrop ask-dialog-backdrop"/);
	assert.doesNotMatch(composer, /runtimeUi/);
	assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
	assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
	assert.match(toolCards, /ask-question-card-result-list/);
	assert.match(toolCards, /askCard\.questions/);
});

test("Web wiring is Session-first and exposes no Agent compatibility creation", () => {
	assert.match(main, /createSessionDraft: async \(input\)[\s\S]*sessionCatalog\.createDraft/);
	// 实参是 applyBoundAgentPersona 组合后的载荷（首轮把角色设定拼进去），不是原始 input。
	assert.match(main, /sendSessionPrompt: async \(input\)[\s\S]*applyBoundAgentPersona[\s\S]*sessionRuntimeCoordinator\.send\(applied\.prompt\)/);
	// stopSessionRuntime is now a shared helper called from both IPC and the web deps.
	assert.match(main, /async function stopSessionRuntime\(target[^)]*\)[\s\S]*sessionRuntimeCoordinator\.stopRuntime\(target\)/);
	assert.doesNotMatch(main, /createAgent:/);
	assert.doesNotMatch(main, /LEGACY_EXTERNAL_RUNTIME|ipcChannels\.agentsCreate/);
});

test("catalog deletion unbinds first then waits for the agent exit before touching files", () => {
	assert.match(sessionIpc, /sessionsCatalogDelete[\s\S]*releaseRuntimeForDelete\(sessionId\)/);
	assert.match(sessionIpc, /sessionsCatalogDelete[\s\S]*rememberDismissedDshSession\(/);
	assert.match(main, /deleteSessionRecord: async \(sessionId\)[\s\S]*releaseRuntimeForDelete\(sessionId\)/);
	assert.match(main, /deleteSessionRecord: async \(sessionId\)[\s\S]*rememberDismissedDshSession\(/);
	assert.match(coordinator, /async releaseRuntimeForDelete\(sessionId: string\)/);
	// 先解绑（侧栏立刻可删），但停进程必须等它真的退出：pi 还握着会话文件句柄时删文件会失败（#364）。
	assert.match(coordinator, /unbindAgentUnchecked\(target\.agentId\)[\s\S]*await this\.stopForDelete\(target\.agentId\)/);
	assert.match(coordinator, /stopAndWait\.call\(this\.agents, agentId, DELETE_STOP_TIMEOUT_MS\)/);
	assert.match(coordinator, /isActivating\(sessionId: string\): boolean/);
});

test("replacement restore is gated by full local/SSH origin identity in the session owner", () => {
	// 合并后策略内联进 index.ts（batch A1）：owner 就是这里的 replaceAgentSession，
	// 所以断言落在它的函数体切片上（整文件的 `[\s\S]*?` 会跨函数误命中）。
	const owner = main.slice(main.indexOf("async function replaceAgentSession("), main.indexOf("onDetached: emitSessionRuntimeDetach"));
	assert.ok(owner.length > 0, "index.ts 里必须保留 replaceAgentSession 所有者");
	assert.match(owner, /const\s+originKey\s*=[\s\S]*?originEntry\?\.filePath[\s\S]*?buildSessionOriginKey\s*\(/);
	assert.match(owner, /canRestoreOrigin:\s*\(\)\s*=>\s*\{[\s\S]*?buildSessionOriginKey[\s\S]*?originKey/);
	assert.match(owner, /project\.hostId\s*===\s*originLocator\.hostId/);
	assert.match(owner, /tab\.sessionPath\s*===\s*originLocator\.remotePath/);
	assert.match(coordinator, /failClosedRuntimeReplacement/);
	assert.match(coordinator, /replacementBySession/);
});
