import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 守卫背景（2026-12 hostPluginsUnmount 修复）：hostPluginsIpc 的 10 个管理入口
// （list/rescan/install/installDirectory/scaffold/setEnabled/openDirectory/mount/
// update/unmount）都只允许主窗口主帧调用——每个 handler 必须先过 trustedWindow(event)。
// hostPluginRequest 是唯一例外：guest 帧正是经 broker 按帧授权使用宿主 API 的，
// 信任判定在 HostPluginBroker 内部做，IPC 层只传 senderFrame 标志。
// 本测试静态钉扎：未来新增管理 handler 漏掉 trustedWindow 会在 CI 红灯。

const source = readFileSync(join(import.meta.dirname, "..", "src", "main", "ipc", "hostPluginsIpc.ts"), "utf8");

/** 逐 handler 切块：从 ipcMain.handle( 起，到下一个 ipcMain.handle( 或 return 前。 */
function handlerChunks(src) {
	const chunks = [];
	let idx = src.indexOf("ipcMain.handle(");
	while (idx !== -1) {
		const next = src.indexOf("ipcMain.handle(", idx + 1);
		const end = next === -1 ? src.length : next;
		chunks.push(src.slice(idx, end));
		idx = next;
	}
	return chunks;
}

test("hostPluginsIpc 每个 ipcMain.handle 注册块都被识别", () => {
	const chunks = handlerChunks(source);
	assert.ok(chunks.length >= 11, `至少 11 个 handler，实际 ${chunks.length}`);
});

test("除 hostPluginRequest 外每个管理 handler 都必须调用 trustedWindow", () => {
	const exceptions = new Set(["hostPluginsChanged", "hostPluginNavigate"]);
	for (const chunk of handlerChunks(source)) {
		const channelMatch = chunk.match(/ipcChannels\.(\w+)/);
		assert.ok(channelMatch, `handler 块必须引用通道常量：${chunk.slice(0, 80)}...`);
		const channel = channelMatch[1];
		if (channel === "hostPluginRequest" || exceptions.has(channel)) continue;
		assert.match(chunk, /trustedWindow\(/, `${channel} 缺少主窗口信任边界：管理入口必须先过 trustedWindow(event)（hostPluginRequest 除外，其按帧授权在 broker 内部）`);
	}
});

test("hostPluginRequest 必须把主帧标志传给 broker（不得自行拦截）", () => {
	assert.match(source, /hostPluginRequest[^;]*senderFrame === event\.sender\.mainFrame/s);
});
