import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const mainSource = () => readFileSync("src/main/index.ts", "utf8");
// 飞书 IPC 处理器已随主进程拆分迁入 ipc/feishuIpc.ts（2027-02），契约同步改读新模块。
const feishuIpcSource = () => readFileSync("src/main/ipc/feishuIpc.ts", "utf8");
const bridgeSource = () => readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");
const connectionSource = () => readFileSync("src/main/feishu/FeishuConnection.ts", "utf8");
const configSource = () => readFileSync("src/main/feishu/FeishuConfig.ts", "utf8");

function promptIntegrationSource(source) {
	return source.match(/async function sendAgentPromptWithIntegrations\([\s\S]*?\n\}\n\nfunction registerIpc/)?.[0] ?? "";
}

test("FeishuBridge.start propagates startup failure to IPC callers", () => {
	const source = bridgeSource();
	const startIdx = source.indexOf("async start(): Promise<void>");
	const afterStart = source.indexOf("\n\tasync ", startIdx + 5);
	const startBlock = source.slice(startIdx, afterStart > 0 ? afterStart : undefined);
	// The error message includes the original detail; both the structured cause and the
	// display text must remain available for the renderer.
	assert.match(startBlock, /throw new Error\([^;]+ \{ cause: error \}\);/);
	assert.match(startBlock, /feishuT\(this\.locale, "connection\.failed"\)/);
});

test("updating a saved bot only hot-updates the active bridge for that bot", () => {
	const source = feishuIpcSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.feishuBotConfig,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /feishuBridgeRef\.current\.getStatus\(\)\.botId === botId/);
});

test("assigning a Session bot is stable-ID addressed and reports rejected bindings", () => {
	const source = feishuIpcSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.feishuSessionBotSet,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /sessionId: string, botId: string \| null/);
	assert.match(handler, /deps\.sessionRuntimeCoordinator\.getTarget\(sessionId\)/);
	assert.match(handler, /status\.botId !== botId/);
	assert.match(handler, /return \{ success: false, message: feishuT\(deps\.getCurrentLocale\(\), "session\.botMismatch"\) \}/);
	assert.match(handler, /ensureSessionMirrorForSession\([\s\S]*?sessionId,[\s\S]*?target\.agentId/);
	assert.ok(handler.indexOf("setSessionBotId(sessionId, botId)") > handler.indexOf("if (!chatId)"), "persistent assignment must happen only after the bridge confirms a chat binding");
});

test("renderer bot list never receives stored app secrets", () => {
	const source = configSource();
	const listBots = source.match(/export function listBots\(\): FeishuBotConfig\[\] \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(listBots, /appSecret: ""/);
});

test("bound Feishu sessions tell the agent to use PiDeck SEND_FILE markers instead of asking for chat_id", () => {
	const source = mainSource();
	const handler = promptIntegrationSource(source);
	const boundBranch = handler.match(/\} else if \(hasFeishuBinding\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
	assert.match(boundBranch, /agentInstruction =/);
	assert.match(handler, /\[SEND_FILE:本地文件路径\]/);
	assert.match(handler, /不要询问 chat_id/);
});

test("bound Feishu sessions pass the current chat_id into the agent context", () => {
	const main = mainSource();
	const bridge = bridgeSource();
	assert.match(bridge, /getSessionChatId\(sessionOrAgentId: string\): string \| undefined/);
	const handler = promptIntegrationSource(main);
	assert.match(handler, /bridge\.getSessionChatId\(input\.agentId\)/);
	assert.match(handler, /当前绑定的飞书 chat_id/);
	assert.match(handler, /严禁调用 lark-cli/);
	assert.doesNotMatch(handler, /如必须使用飞书工具/);
});

test("Feishu-origin messages also tell the agent to use SEND_FILE markers", () => {
	const source = bridgeSource();
	const method = source.match(/private async runAgent\([\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(method, /严禁调用 lark-cli/);
	assert.match(method, /\[SEND_FILE:本地文件路径\]/);
	assert.match(method, /当前绑定的飞书 chat_id/);
	assert.doesNotMatch(method, /chat_id 是什么/);
});

test("FeishuBridge registers and handles Feishu model picker card actions", () => {
	const source = bridgeSource();
	const conn = connectionSource();
	const method = source.match(/private async handleCardAction\([\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(conn, /"card\.action\.trigger"/);
	assert.match(source, /this\.handleCardAction/);
	assert.match(method, /parseModelActionValue/);
	assert.match(method, /const agentId = await this\.ensureRuntimeBinding\(binding\)/);
	assert.match(method, /this\.runtimeBindings\.listRuntimeModels\(binding\.sessionId\)/);
	assert.match(method, /this\.runtimeBindings\.setRuntimeModel\(binding\.sessionId, action\.provider, action\.modelId\)/);
});

test("FeishuBridge does not keep unreachable workspace/resume command code", () => {
	const source = bridgeSource();
	assert.doesNotMatch(source, /handleWorkspaceCommand/);
	assert.doesNotMatch(source, /handleResumeCommand/);
	assert.doesNotMatch(source, /doSwitchWorkspace/);
	assert.doesNotMatch(source, /doResumeSession/);
	assert.doesNotMatch(source, /`\/workspace /);
	assert.doesNotMatch(source, /`\/resume /);
	assert.equal(existsSync("src/main/feishu/TaskStatusCard.ts"), false);
});

test("FeishuBridge prefers the current sessionToChat mapping over stale mirror bindings", () => {
	const source = bridgeSource();
	const method = source.match(/private getBestChatId\(sessionOrAgentId: string\): string \| undefined \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	const sessionIndex = method.indexOf("this.sessionToChat.get(sessionOrAgentId)");
	const loopIndex = method.indexOf("for (const [chatId, b] of this.chatBindings)");
	assert.ok(sessionIndex >= 0, "should read current sessionToChat mapping");
	assert.ok(loopIndex >= 0, "should keep fallback loop for persisted mirror bindings");
	assert.ok(sessionIndex < loopIndex, "sessionToChat must win over stale mirror bindings");
});

test("FeishuBridge can send a file through the current session binding without agent choosing a group", () => {
	const source = bridgeSource();
	const method = source.match(/async sendFileForSession\(agentId: string, filePath: string\): Promise<string> \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(method, /this\.getBestChatId\(agentId\)/);
	assert.match(method, /this\.sendFeishuFile\(chatId, filePath\)/);
});

test("FeishuBridge only executes agent SEND_FILE markers after explicit user send intent", () => {
	const source = bridgeSource();
	// 签名随网关改造改为（chatId, messages）：消息快照由调用方按后端取好，这里只看显式发送意图。
	const method = source.match(/private async processFeishuActions\([\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.ok(method, "processFeishuActions 应存在");
	assert.match(source, /hasExplicitFeishuFileSendIntent/);
	assert.match(method, /hasExplicitFeishuFileSendIntent\(userText\)/);
	assert.match(method, /忽略 SEND_FILE/);
});

test("Feishu-origin runs do not also trigger local session mirror sync", () => {
	const source = bridgeSource();
	const eventMethod = source.match(/private handleAgentEvent\(agentId: string, event: unknown\): void \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	const runMethod = source.match(/private async runAgent\([\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(source, /feishuDrivenRuns/);
	assert.match(eventMethod, /!this\.feishuDrivenRuns\.has\(agentId\)/);
	assert.match(runMethod, /this\.feishuDrivenRuns\.add\(agentId\)/);
	assert.match(runMethod, /this\.feishuDrivenRuns\.delete\(agentId\)/);
});

test("shared prompt integration intercepts Feishu file-send requests before sending them to the agent", () => {
	const source = mainSource();
	const handler = promptIntegrationSource(source);
	const sendIndex = handler.indexOf("bridge.sendFileForSession(input.agentId");
	const promptIndex = handler.indexOf("agentManager.sendPrompt(");
	assert.match(handler, /resolveFeishuFileSendIntent\(input\.message, agentManager\.getCwd\(input\.agentId\)\)/);
	assert.ok(sendIndex >= 0, "should send via bridge");
	assert.ok(promptIndex >= 0, "should keep normal agent prompt path");
	assert.ok(sendIndex < promptIndex, "host send must happen before agent prompt");
});
