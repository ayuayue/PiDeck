import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = () => readFileSync("src/main/index.ts", "utf8");
const bridgeSource = () => readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");
const configSource = () => readFileSync("src/main/feishu/FeishuConfig.ts", "utf8");

test("FeishuBridge.start propagates startup failure to IPC callers", () => {
	const source = bridgeSource();
	const catchBlock = source.match(/async start\(\): Promise<void> \{[\s\S]*?\n\t\t\} catch \(error\) \{([\s\S]*?)\n\t\t\}\n\t\}/)?.[1] ?? "";
	assert.match(catchBlock, /throw error;/);
});

test("updating a saved bot only hot-updates the active bridge for that bot", () => {
	const source = mainSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.feishuBotConfig,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /feishuBridge\.getStatus\(\)\.botId === botId/);
});

test("assigning a session bot refuses to bind through a different active bot", () => {
	const source = mainSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.feishuSessionBotSet,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /status\.botId !== botId/);
	assert.doesNotMatch(handler, /setSessionBotId\(agentId, botId \?\? undefined\);[\s\S]*?status\.botId !== botId/);
});

test("renderer bot list never receives stored app secrets", () => {
	const source = configSource();
	const listBots = source.match(/export function listBots\(\): FeishuBotConfig\[\] \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(listBots, /appSecret: ""/);
});

test("bound Feishu sessions tell the agent to use PiDeck SEND_FILE markers instead of asking for chat_id", () => {
	const source = mainSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.agentsPrompt,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	const boundBranch = handler.match(/\} else if \(hasFeishuBinding\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
	assert.match(boundBranch, /agentInstruction =/);
	assert.match(handler, /\[SEND_FILE:本地文件路径\]/);
	assert.match(handler, /不要询问 chat_id/);
});

test("bound Feishu sessions pass the current chat_id into the agent context", () => {
	const main = mainSource();
	const bridge = bridgeSource();
	assert.match(bridge, /getSessionChatId\(agentId: string\): string \| undefined/);
	const handler = main.match(/ipcMain\.handle\(ipcChannels\.agentsPrompt,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /bridge\.getSessionChatId\(input\.agentId\)/);
	assert.match(handler, /当前绑定的飞书 chat_id/);
	assert.match(handler, /严禁调用 lark-cli/);
	assert.doesNotMatch(handler, /如必须使用飞书工具/);
});

test("FeishuBridge prefers the current sessionToChat mapping over stale mirror bindings", () => {
	const source = bridgeSource();
	const method = source.match(/private getBestChatId\(agentId: string\): string \| undefined \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	const sessionIndex = method.indexOf("this.sessionToChat.get(agentId)");
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

test("agentsPrompt intercepts Feishu file-send requests before sending them to the agent", () => {
	const source = mainSource();
	const handler = source.match(/ipcMain\.handle\(ipcChannels\.agentsPrompt,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	const sendIndex = handler.indexOf("bridge.sendFileForSession(input.agentId");
	const promptIndex = handler.indexOf("agentManager.sendPrompt(");
	assert.match(handler, /resolveFeishuFileSendIntent\(input\.message, agentManager\.getCwd\(input\.agentId\)\)/);
	assert.ok(sendIndex >= 0, "should send via bridge");
	assert.ok(promptIndex >= 0, "should keep normal agent prompt path");
	assert.ok(sendIndex < promptIndex, "host send must happen before agent prompt");
});
