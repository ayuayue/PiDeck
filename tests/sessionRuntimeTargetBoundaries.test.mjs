import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const main = readFileSync("src/main/index.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const terminalDock = readFileSync(
	"src/renderer/src/components/terminal/TerminalDock.tsx",
	"utf8",
);
const pet = readFileSync("src/main/pet/index.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const browserApi = readFileSync("src/renderer/src/browserApi.ts", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const sessionsPreload = preload.slice(
	preload.indexOf("\tsessions: {"),
	preload.indexOf("\n\tcodexSessions:", preload.indexOf("\tsessions: {")),
);
const sessionActions = readFileSync(
	"src/renderer/src/hooks/useSessionActions.ts",
	"utf8",
);
const sessionReferenceModal = readFileSync(
	"src/renderer/src/components/app/SessionReferenceModal.tsx",
	"utf8",
);

test("terminal creation and listing cross IPC with an owner-validated target", () => {
	// 终端目标区分 agent（校验 runtime 绑定）与 project（引导页/未激活 agent/历史会话，
	// 按 cwd 隔离）；preload/Dock/IPC 全链路统一 TerminalTarget。
	assert.match(preload, /terminal: \{[\s\S]*list: \(target: TerminalTarget\)/);
	assert.match(preload, /ensure: \(target: TerminalTarget\)/);
	assert.match(preload, /create: \(target: TerminalTarget, shell\?: TerminalShell\)/);
	assert.match(terminalDock, /target: TerminalTarget/);
	assert.match(terminalDock, /props\.terminal\.ensure\(props\.target\)/);
	assert.match(terminalDock, /props\.terminal\.create\(props\.target, shell\)/);
	assert.match(
		mainIpcSource,
		/const requireTerminalTarget = \(target: TerminalTarget\)[\s\S]*kind === "project"[\s\S]*validateTarget\(target\)/,
	);
	assert.match(
		mainIpcSource,
		/terminalList[\s\S]*requireTerminalTarget\(target\)[\s\S]*terminalManager\.list\(target\)/,
	);
	assert.match(
		mainIpcSource,
		/terminalCreate[\s\S]*requireTerminalTarget\(target\)[\s\S]*terminalManager\.create\(target, shell\)/,
	);
	assert.doesNotMatch(main, /ipcMain\.handle\(ipcChannels\.terminal/);
});

test("RPC logging controls resolve the current Session target before touching AgentManager", () => {
	assert.match(preload, /setLogging: \(target: SessionRuntimeTarget, enabled: boolean\)/);
	assert.match(preload, /getLogging: \(target: SessionRuntimeTarget\)/);
	assert.match(mainIpcSource, /const resolveRpcRuntimeAgent = \(target\?: SessionRuntimeTarget\)/);
	assert.match(mainIpcSource, /sessionRuntimeCoordinator\.validateTarget\(target\)/);
	assert.match(app, /api\.rpcLogs\.setLogging\(target, enabled\)/);
	assert.doesNotMatch(app, /api\.rpcLogs\.setLogging\(agentId/);
});

test("pet focus crosses into the renderer as a stable Session ID", () => {
	assert.match(pet, /resolveSessionId: \(agentId: string\) => string \| undefined/);
	assert.match(pet, /petFocusAgentTarget, \{ sessionId \}/);
	assert.doesNotMatch(pet, /petFocusAgentTarget, \{ agentId \}/);
	assert.match(app, /onFocusTarget: \(target: \{ sessionId: string \}\)/);
	assert.match(app, /sessionRecordByIdAtomFamily\(target\.sessionId\)/);
});

test("renderer and preload expose no legacy agents command namespace", () => {
	for (const source of [preload, previewApi, browserApi]) {
		assert.doesNotMatch(source, /^\s*agents:\s*\{/m);
	}
	assert.doesNotMatch(
		app,
		/(?:api|desktopApi|piDesktop)\.agents\.|window\.piDesktop!?\.agents/,
	);
	assert.doesNotMatch(main, /ipcMain\.handle\(ipcChannels\.agents/);
	assert.doesNotMatch(
		ipc,
		/agents(List|Create|Rename|Stop|Prompt|Abort|ExportHtml|ForkMessages|ForkSession|CloneSession|PrepareResend|SwitchSession|Reload|EditMessage|DeleteMessage|Restart|Compact|CycleModel|AvailableModels|SetModel|RefreshModels|CycleThinking|SetThinking|UiResponse):/,
	);
});

test("Session file operations resolve stable Session IDs before touching paths", () => {
	assert.match(preload, /copyRecord: \(sessionId: string\)/);
	assert.match(preload, /exportRecordHtml: \(sessionId: string\)/);
	assert.match(preload, /readReferenceMessages: \(sessionId: string\)/);
	assert.match(main, /async function copyCatalogSession\(sessionId: string\)/);
	assert.match(main, /const entry = sessionCatalog\.get\(sessionId\)/);
	assert.match(sessionActions, /copyRecord\(sessionId\)/);
	assert.match(sessionActions, /exportRecordHtml\(session\.id\)/);
	assert.match(sessionReferenceModal, /props\.loadMessages\(props\.session\.id\)/);
	assert.doesNotMatch(
		ipc,
		/sessions(?:Rename|Copy|ExportHtml|Delete|ReadMessages|ReadMeta|ReadChatMessages):/,
	);
	assert.doesNotMatch(
		sessionsPreload,
		/(?:rename|copy|exportHtml|delete|readMessages|readSessionMeta|readChatMessages): \(filePath/,
	);
});
