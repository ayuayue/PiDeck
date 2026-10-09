import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 飞书桥 run 生命周期回归（2027-03 深审）：
 * 四个已验证缺陷——cardTerminalSucceeded 永久残留、waitForAgentEnd 注册晚于
 * 卡片创建、300s 超时误删仍在运行 run 的注册表、sendPrompt 失败遗留孤儿卡片。
 * 契约用空白容忍正则（AGENTS.md：源码扫描测试必须空白容忍）。
 */
const source = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");

test("cardTerminalSucceeded 预占必须在 agent_end 消费，不得跨轮残留压制文本同步", () => {
	// 门控块：agent_end 时先取 deliveredByCard 并删除预占，再决定是否文本同步。
	// 残留会让「曾有一次卡片终态成功」的会话在后续无卡片 run 的结果永久失去同步通道。
	const gate = source.match(/if\s*\(\s*typed\.type\s*===\s*"agent_end"\s*\)\s*\{[\s\S]*?syncPiMessageToFeishu\(agentId,\s*chatId\)/);
	assert.ok(gate, "agent_end 同步门控块应存在");
	assert.match(gate[0], /deliveredByCard/, "门控必须先读取本轮卡片交付标记");
	assert.match(gate[0], /cardTerminalSucceeded\.delete\(\s*agentId\s*\)/, "agent_end 必须消费预占（防跨轮残留）");
	assert.match(gate[0], /!\s*deliveredByCard/, "文本同步必须以本轮交付标记为条件");
});

test("waitForAgentEnd 必须在 sendPrompt 之前注册（快速失败的 run 不得错过 agent_end）", () => {
	// 若监听注册晚于卡片创建（一次网络往返），秒失败的 run 在窗口内广播 agent_end，
	// 错过后等满 300s，processingChats 持有 chatId 期间该聊天消息被静默丢弃。
	const listenPos = source.indexOf("agentEndPromise = this.waitForAgentEnd");
	const sendPos = source.indexOf("await this.runtimeBindings.sendPrompt");
	assert.ok(listenPos > 0, "应提前创建 agentEndPromise");
	assert.ok(sendPos > 0, "sendPrompt 调用应存在");
	assert.ok(listenPos < sendPos, "agentEndPromise 创建必须先于 sendPrompt");
});

test("300s 超时不得删除仍在运行 run 的卡片注册表（终态事件仍需收尾通道）", () => {
	// 超时时 run 可能仍在运行；删除注册表会让卡片永久停在中间态、最终结果无任何交付。
	// 保留注册表让 handleAgentEvent 终态分支在真正结束时 flush+close+清理。
	const timeoutBranch = source.match(/if\s*\(\s*timedOut\s*\)\s*\{[\s\S]*?\n\t\t\t\}/);
	assert.ok(timeoutBranch, "waitForAgentEnd 超时分支应存在");
	assert.doesNotMatch(timeoutBranch[0], /streamingCards\.delete|streamingRunStates\.delete|pendingCardEvents\.delete/, "超时分支不得清理注册表");
	// waitForAgentEnd 需返回是否超时供调用方分流
	assert.match(source, /waitForAgentEnd\([\s\S]*?\):\s*Promise<boolean>/, "waitForAgentEnd 应返回 timedOut 标记");
});

test("sendPrompt 失败必须关闭可能随后创建成功的卡片（孤儿骨架卡）", () => {
	// CardStream.open 与 sendPrompt 并发：open 较慢时 sendPrompt 先失败，
	// catch 若不关闭 cardPromise，open 成功后的卡片成为群里永久「运行中」的孤儿卡。
	const sendPos = source.indexOf("await this.runtimeBindings.sendPrompt");
	assert.ok(sendPos > 0, "sendPrompt 调用应存在");
	const catchPos = source.indexOf("} catch (e) {", sendPos);
	assert.ok(catchPos > sendPos, "sendPrompt 失败 catch 应存在");
	const catchBlock = source.slice(catchPos, source.indexOf("throw e;", catchPos) + 9);
	assert.match(catchBlock, /cardPromise\.then/, "catch 必须善后 cardPromise");
	assert.match(catchBlock, /close\(\)/, "善后必须关闭卡片");
});

test("startSessionMirrorRun 必须缓冲卡片创建窗口内的 agent 事件", () => {
	// 不设 pendingCardEvents：窗口内事件（含快速失败终态）被 handleAgentEvent 丢弃，
	// 卡片永久停在初始骨架态；成功后需回放，失败需清理缓冲。
	const mirrorFn = source.match(/async startSessionMirrorRun\([\s\S]*?\n\t\}/);
	assert.ok(mirrorFn, "startSessionMirrorRun 应存在");
	assert.match(mirrorFn[0], /pendingCardEvents\.set\(agentId,\s*\[\]\)/, "open 前必须建事件缓冲");
	assert.match(mirrorFn[0], /replayBufferedEvents\(agentId,\s*cardStream\)/, "卡片就绪后必须回放缓冲");
	const catchBlock = mirrorFn[0].match(/catch[\s\S]*$/);
	assert.match(catchBlock[0], /pendingCardEvents\.delete\(agentId\)/, "open 失败必须清理缓冲");
});

test("syncPiMessageToFeishu 指纹只能发送成功后记录（先记账会永久丢失结果）", () => {
	// sendSmartMessage 吞错；指纹先记账后发送，瞬时失败的结果被指纹永久去重。
	const syncFn = source.match(/private async syncPiMessageToFeishu[\s\S]*?\n\t\}/);
	assert.ok(syncFn, "syncPiMessageToFeishu 应存在");
	const addPos = syncFn[0].indexOf("syncedFingerprints.add");
	const sendPos = syncFn[0].indexOf("sendSmartMessage(chatId, cleanText)");
	assert.ok(addPos > 0 && sendPos > 0, "指纹记录与发送都应存在");
	assert.ok(addPos > sendPos, "指纹 add 必须在发送之后");
	assert.match(syncFn[0], /!delivered/, "发送失败必须提前返回（不记指纹）");
});

test("sendSmartMessage 必须返回送达结果", () => {
	assert.match(source, /private async sendSmartMessage[\s\S]*?: Promise<boolean>/, "签名应返回 boolean");
});

test("同步指纹集合需 FIFO 上限且 stop 清空（不得用 __feishuSyncFp 挂 this）", () => {
	assert.doesNotMatch(source, /__feishuSyncFp/, "不得用隐藏属性挂集合");
	assert.match(source, /private syncedFingerprints = new Set<string>\(\)/, "应为显式字段");
	assert.match(source, /syncedFingerprints\.size > 200/, "FIFO 上限 200");
	const stopFn = source.match(/\tstop\(\): void \{[\s\S]*?\n\t\}/);
	assert.ok(stopFn, "stop() 应存在");
	assert.match(stopFn[0], /syncedFingerprints\.clear\(\)/, "stop() 必须清空指纹集合");
});

test("pendingAttachments 必须有单 chat 上界，removeBinding 必须释放", () => {
	// 只发文件不发指令的聊天会让每个文件（最大 50MB）Buffer 无限驻留；解绑也不释放。
	const stashBlock = source.match(/只有附件没有文字[\s\S]*?pendingAttachments\.set\(chatId, merged\)/);
	assert.ok(stashBlock, "附件暂存块应存在");
	assert.match(stashBlock[0], /heldCount \+ incomingCount > 20/, "数量上界 20");
	assert.match(stashBlock[0], /20 \* 1024 \* 1024/, "字节上界 20MB");
	assert.match(stashBlock[0], /attachment\.pendingFull/, "超限必须提示用户");
	const removeFn = source.match(/removeBinding\(chatId: string\): boolean \{[\s\S]*?return true;/);
	assert.ok(removeFn, "removeBinding 应存在");
	assert.match(removeFn[0], /pendingAttachments\.delete\(chatId\)/, "解绑必须释放暂存附件");
	assert.match(removeFn[0], /pendingAsks/, "解绑必须清理待答 ask");
});

test("runAgent 收尾必须删除本轮图片临时文件", () => {
	// 每次写 %TEMP%/pi-feishu-images/ 后不删，长期使用磁盘无限增长。
	const finallyBlock = source.match(/finally \{[\s\S]*?feishuDrivenRuns\.delete\(agentId\);[\s\S]*?\n\t\}/);
	assert.ok(finallyBlock, "runAgent finally 应存在");
	assert.match(finallyBlock[0], /unlink/, "finally 必须删除临时图片");
});
