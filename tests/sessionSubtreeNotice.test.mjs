import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #539 的尾项：归档/删除已成功、但平铺子会话文件没处理掉时，用户要能看见。
 * 能力本身（catalog 子树 + 文件处理）在 sessionSubtreeFiles.test.mjs 里；这里只管提示送达。
 */
const { sendAgentsNotice } = loadTsCommonJs("src/main/ipc/agentsNotice.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeSender({ destroyed = false } = {}) {
	const sent = [];
	return { sent, isDestroyed: () => destroyed, send: (channel, payload) => sent.push({ channel, payload }) };
}

test("提示走 sessions:runtime-event 的 agents:notice 信封（渲染层直接弹 toast）", () => {
	const sender = fakeSender();
	sendAgentsNotice(sender, { sessionId: "session-1", i18nKey: "notice.subtreeArchiveLeftover", i18nParams: { count: 2 }, message: "fallback copy" });
	assert.equal(sender.sent.length, 1);
	assert.equal(sender.sent[0].channel, "sessions:runtime-event");
	const envelope = plain(sender.sent[0].payload);
	assert.equal(envelope.sourceChannel, "agents:notice");
	assert.equal(envelope.sessionId, "session-1");
	assert.deepEqual(envelope.payload, { i18nKey: "notice.subtreeArchiveLeftover", i18nParams: { count: 2 }, kind: "warning", duration: 8000, message: "fallback copy" });
});

test("窗口已销毁时静默，不抛错（归档结果已经落定，提示不能反过来打断返回）", () => {
	const sender = fakeSender({ destroyed: true });
	assert.doesNotThrow(() => sendAgentsNotice(sender, { i18nKey: "notice.subtreeDeleteLeftover", message: "x" }));
	assert.deepEqual(sender.sent, []);
});

test("归档/删除两条 IPC 都在 leftover 时调用提示，且失败不抛错", () => {
	const archive = readFileSync("src/main/ipc/sessionCatalogArchiveIpc.ts", "utf8");
	const deletion = readFileSync("src/main/ipc/sessionCatalogWriteIpc.ts", "utf8");
	for (const [name, source, key] of [
		["归档", archive, "notice.subtreeArchiveLeftover"],
		["删除", deletion, "notice.subtreeDeleteLeftover"],
	]) {
		const block = source.slice(source.indexOf(`i18nKey: "${key}"`) - 400, source.indexOf(`i18nKey: "${key}"`) + 400);
		assert.ok(source.includes(`i18nKey: "${key}"`), `${name}路径缺提示`);
		assert.match(block, /sendAgentsNotice\(event\.sender/, `${name}路径没有把提示送到发起窗口`);
		assert.match(block, /leftover\.length > 0/, `${name}路径只在有失败时提示`);
	}
});
