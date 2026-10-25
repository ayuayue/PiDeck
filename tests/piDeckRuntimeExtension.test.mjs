import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * pi-deck-runtime 扩展是 RPC 模式下 `/reload` 的唯一执行入口：只注册一个
 * `reload` 命令，idle 时调用 pi 的 ctx.reload()，非 idle 时拒绝执行。
 */
function loadExtension() {
	return loadTsCommonJs("resources/extensions/pi-deck-runtime.ts").default;
}

test("registers only the reload command", () => {
	const extension = loadExtension();
	const commands = new Map();
	extension({ registerCommand: (name, options) => commands.set(name, options) });
	assert.deepEqual([...commands.keys()], ["reload"]);
	assert.match(commands.get("reload").description, /Reload/i);
});

test("rejects reload while the session is busy", async () => {
	const extension = loadExtension();
	const commands = new Map();
	extension({ registerCommand: (name, options) => commands.set(name, options) });
	let reloadCalls = 0;
	const ctx = {
		isIdle: () => false,
		reload: async () => {
			reloadCalls += 1;
		},
	};
	await assert.rejects(() => commands.get("reload").handler("", ctx), /Wait for the current response/);
	assert.equal(reloadCalls, 0);
});

test("calls ctx.reload exactly once when idle", async () => {
	const extension = loadExtension();
	const commands = new Map();
	extension({ registerCommand: (name, options) => commands.set(name, options) });
	let reloadCalls = 0;
	const ctx = {
		isIdle: () => true,
		reload: async () => {
			reloadCalls += 1;
		},
	};
	await commands.get("reload").handler("", ctx);
	assert.equal(reloadCalls, 1);
});
