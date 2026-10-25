// writeClipboard 三级回退契约（utils/clipboard.ts）。
//
// 背景：该函数是渲染层唯一的剪贴板写入入口（toast 复制按钮、MarkdownLink 复制路径、
// 侧栏会话菜单、配置页命令复制…共十余处）。原先只返回 void 且**不 await** preload
// bridge 的 writeText（Electron 38 起它是主进程 invoke，返回 Promise<boolean>）——
// 后果有两个：把「还在写」当成功、invoke 的 rejection 变成未处理拒绝。
// 现在返回 boolean 并逐级判真值，本测试锁住回退顺序与返回值语义。
//
// 三级顺序：preload 主进程 bridge → navigator.clipboard → textarea + execCommand。

import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const CLIPBOARD_MODULE = "src/renderer/src/utils/clipboard.ts";

/**
 * 按场景装配沙箱：每个模式只驱动一级路径，便于断言「谁被调用、谁没被调用」。
 * native 覆盖 bridge 的真实形态（Electron 38 起是 Promise<boolean>，旧实现同步返回 boolean）。
 */
function loadClipboard({ native = "missing", web = "missing", fallback = false } = {}) {
	const calls = { native: [], web: 0, fallback: 0 };
	const writeText = (() => {
		if (native === "missing") return undefined;
		return (text) => {
			calls.native.push(text);
			switch (native) {
				case "sync-true":
					return true;
				case "sync-false":
					return false;
				case "promise-true":
					return Promise.resolve(true);
				case "promise-false":
					return Promise.resolve(false);
				case "throw":
					throw new Error("bridge boom");
				case "reject":
					return Promise.reject(new Error("ipc boom"));
				default:
					throw new Error(`unknown native mode: ${native}`);
			}
		};
	})();

	const navigatorStub =
		web === "missing"
			? {}
			: {
					clipboard: {
						writeText: async () => {
							calls.web += 1;
							if (web === "throw") throw new Error("Document is not focused");
						},
					},
				};

	const load = createTsSandbox({
		globals: {
			window: { piDesktop: { clipboard: { writeText } } },
			navigator: navigatorStub,
			document: {
				createElement: () => ({ style: {}, value: "", select() {}, remove() {} }),
				body: { appendChild() {}, removeChild() {} },
				execCommand: () => {
					calls.fallback += 1;
					return fallback;
				},
			},
		},
	});
	return { writeClipboard: load(CLIPBOARD_MODULE).writeClipboard, calls };
}

test("uses the preload bridge first and reports its success", async () => {
	const { writeClipboard, calls } = loadClipboard({ native: "promise-true" });
	assert.equal(await writeClipboard("hello"), true);
	assert.deepEqual(calls.native, ["hello"]);
	assert.equal(calls.web, 0);
	assert.equal(calls.fallback, 0);
});

test("legacy sync bridge return value is honoured", async () => {
	const { writeClipboard, calls } = loadClipboard({ native: "sync-true" });
	assert.equal(await writeClipboard("hi"), true);
	assert.equal(calls.web, 0);
});

test("bridge resolving false falls through to the web API (regression: unresolved promise used to look like success)", async () => {
	const { writeClipboard, calls } = loadClipboard({ native: "promise-false", web: "ok" });
	assert.equal(await writeClipboard("payload"), true);
	assert.deepEqual(calls.native, ["payload"]);
	assert.equal(calls.web, 1);
});

test("bridge rejection or throw falls through instead of surfacing an unhandled rejection", async () => {
	for (const native of ["throw", "reject"]) {
		const { writeClipboard, calls } = loadClipboard({ native, web: "ok" });
		assert.equal(await writeClipboard("x"), true, `mode ${native}`);
		assert.equal(calls.web, 1, `mode ${native}`);
	}
});

test("falls back to textarea + execCommand when the web API is unavailable or throws", async () => {
	for (const web of ["missing", "throw"]) {
		const { writeClipboard, calls } = loadClipboard({ web, fallback: true });
		assert.equal(await writeClipboard("x"), true, `web ${web}`);
		assert.equal(calls.fallback, 1, `web ${web}`);
	}
});

test("reports false only when every tier fails", async () => {
	const { writeClipboard, calls } = loadClipboard({ web: "throw", fallback: false });
	assert.equal(await writeClipboard("x"), false);
	assert.equal(calls.fallback, 1);
});
