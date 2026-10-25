import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// electron 只在「未注入 clipboard」时被引用；这里给一个空替身，其余分支全部走注入替身。
const reader = loadTsCommonJs("src/main/selection/systemSelectionReader.ts", {
	stubs: { electron: { clipboard: { readText: () => "", writeText: () => undefined } } },
});
const { resolveSystemSelectionPlan, createSelectionSentinel, normalizeClipboardSelection, classifySystemSelectionTriggerError, readSystemSelection, SELECTION_POLL_INTERVAL_MS, SELECTION_POLL_TIMEOUT_MS, SELECTION_COPY_INJECT_DELAY_MS, MACOS_COPY_COMMAND, X11_COPY_COMMAND } = reader;
const { SELECTION_TOOL_TEXT_MAX_CHARS } = loadTsCommonJs("src/shared/types/selectionTool.ts");

/** 生产模块在 vm 沙箱里创建的对象原型属于另一个 realm，深度比较前转成本 realm 的普通对象。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 可控剪贴板：记录每次写入，便于断言「哨兵 → 恢复原文」的写入序列。 */
function createFakeClipboard(initialText = "") {
	let text = initialText;
	const writes = [];
	return {
		clipboard: {
			readText: () => text,
			writeText: (next) => {
				text = String(next);
				writes.push(String(next));
			},
		},
		writes,
		read: () => text,
		setText: (next) => {
			text = next;
		},
	};
}

test("resolveSystemSelectionPlan maps each platform to its copy strategy", () => {
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "win32" })), { supported: true, strategy: "win32-keys" });
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "darwin" })), { supported: true, strategy: "command", command: "osascript", args: plain(MACOS_COPY_COMMAND.args) });
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "linux" })), { supported: true, strategy: "command", command: "xdotool", args: plain(X11_COPY_COMMAND.args) });
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "linux", sessionType: "x11" })), { supported: true, strategy: "command", command: "xdotool", args: plain(X11_COPY_COMMAND.args) });
	// Wayland（大小写/空白不敏感）不做无效尝试：xdotool 没有 Wayland 后端。
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "linux", sessionType: " Wayland " })), { supported: false, reason: "unsupported" });
	assert.deepEqual(plain(resolveSystemSelectionPlan({ platform: "freebsd" })), { supported: false, reason: "unsupported" });
	// 复制命令必须是数组参数形式（禁止 shell 拼接，AGENTS.md 安全约束 4）。
	assert.ok(Array.isArray(MACOS_COPY_COMMAND.args) && MACOS_COPY_COMMAND.args.length === 2);
	assert.deepEqual(plain(X11_COPY_COMMAND.args), ["key", "--clearmodifiers", "ctrl+c"]);
});

test("sentinel detection rejects the probe itself and blank clipboard content", () => {
	const sentinel = createSelectionSentinel("fixed-id");
	assert.equal(sentinel, "pideck-selection-probe:fixed-id");
	assert.equal(createSelectionSentinel().startsWith("pideck-selection-probe:"), true);
	assert.equal(normalizeClipboardSelection(sentinel, sentinel), null);
	assert.equal(normalizeClipboardSelection("", sentinel), null);
	assert.equal(normalizeClipboardSelection("   \n\t ", sentinel), null);
	assert.equal(normalizeClipboardSelection("\u0000\u0000", sentinel), null);
	// 真实选区：去首尾空白但保留段落结构，NUL 清理掉。
	assert.equal(normalizeClipboardSelection("  hello\nworld  ", sentinel), "hello\nworld");
	assert.equal(normalizeClipboardSelection("a\u0000b", sentinel), "ab");
	// 超长截断到一次性调用上限，避免把整篇文档塞进请求。
	const long = "字".repeat(SELECTION_TOOL_TEXT_MAX_CHARS + 50);
	assert.equal(normalizeClipboardSelection(long, sentinel).length, SELECTION_TOOL_TEXT_MAX_CHARS);
});

test("classifySystemSelectionTriggerError separates missing binaries from real failures", () => {
	assert.equal(classifySystemSelectionTriggerError(Object.assign(new Error("spawn xdotool ENOENT"), { code: "ENOENT" })), "unsupported");
	assert.equal(classifySystemSelectionTriggerError(Object.assign(new Error("not allowed assistive access"), { code: "EACCES" })), "capture-failed");
	assert.equal(classifySystemSelectionTriggerError(new Error("timeout")), "capture-failed");
	assert.equal(classifySystemSelectionTriggerError(null), "capture-failed");
	assert.equal(classifySystemSelectionTriggerError("boom"), "capture-failed");
});

test("macOS copy command captures the selection and restores the original clipboard", async () => {
	const fake = createFakeClipboard("原有内容");
	const result = await readSystemSelection({
		injectDelayMs: 0,
		platform: "darwin",
		clipboard: fake.clipboard,
		execFile: (file, args, options, callback) => {
			assert.equal(file, "osascript");
			assert.deepEqual([...args], [...MACOS_COPY_COMMAND.args]);
			assert.equal(options.timeout > 0, true);
			fake.setText("Hello world");
			callback(null, "", "");
		},
		wait: async () => undefined,
	});
	assert.deepEqual(plain(result), { ok: true, text: "Hello world" });
	// 两次写入 = 哨兵 + 恢复原文（用户剪贴板不能被划词悄悄改掉）。
	assert.equal(fake.writes.length, 2);
	assert.equal(fake.writes[0].startsWith("pideck-selection-probe:"), true);
	assert.equal(fake.read(), "原有内容");
});

test("linux without xdotool reports unsupported and still restores the clipboard", async () => {
	const fake = createFakeClipboard("keep me");
	const result = await readSystemSelection({ injectDelayMs: 0, platform: "linux", sessionType: "x11", clipboard: fake.clipboard, execFile: (_file, _args, _options, callback) => callback(Object.assign(new Error("spawn xdotool ENOENT"), { code: "ENOENT" }), "", "") });
	assert.deepEqual(plain(result), { ok: false, reason: "unsupported" });
	assert.equal(fake.read(), "keep me");
});

test("wayland is unsupported before the clipboard is touched", async () => {
	const fake = createFakeClipboard("untouched");
	const result = await readSystemSelection({
		injectDelayMs: 0,
		platform: "linux",
		sessionType: "wayland",
		clipboard: fake.clipboard,
		execFile: () => {
			throw new Error("copy command must not run on wayland");
		},
	});
	assert.deepEqual(plain(result), { ok: false, reason: "unsupported" });
	assert.deepEqual(fake.writes, []);
	assert.equal(fake.read(), "untouched");
});

test("win32 injects Ctrl+C through the CUA key bridge", async () => {
	const fake = createFakeClipboard("");
	const injected = [];
	const result = await readSystemSelection({
		injectDelayMs: 0,
		platform: "win32",
		clipboard: fake.clipboard,
		injectCopyKey: (vk, modifiers) => {
			injected.push([vk, [...modifiers]]);
			fake.setText("  选中文本  ");
		},
	});
	assert.deepEqual(plain(injected), [[0x43, [0x11]]]);
	assert.deepEqual(plain(result), { ok: true, text: "选中文本" });
	assert.equal(fake.read(), "");
});

test("win32 native injection failure is a structured capture failure", async () => {
	const fake = createFakeClipboard("old");
	const result = await readSystemSelection({
		injectDelayMs: 0,
		platform: "win32",
		clipboard: fake.clipboard,
		injectCopyKey: () => {
			throw new Error("koffi native module missing");
		},
	});
	assert.deepEqual(plain(result), { ok: false, reason: "capture-failed" });
	assert.equal(fake.read(), "old");
});

test("polls until a slow copy lands, then stops", async () => {
	const fake = createFakeClipboard("old");
	let reads = 0;
	const clipboard = {
		readText: () => {
			reads += 1;
			return reads >= 3 ? "slow text" : fake.read();
		},
		writeText: fake.clipboard.writeText,
	};
	const waits = [];
	const result = await readSystemSelection({
		injectDelayMs: 0,
		platform: "darwin",
		clipboard,
		execFile: (_file, _args, _options, callback) => callback(null, "", ""),
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	assert.deepEqual(plain(result), { ok: true, text: "slow text" });
	// 首次读取是保存原文、第二次仍读到哨兵 → 等 50ms；第三次才拿到慢应用的复制结果。
	assert.deepEqual(waits, [SELECTION_POLL_INTERVAL_MS]);
	assert.equal(SELECTION_POLL_INTERVAL_MS, 50);
	assert.equal(SELECTION_POLL_TIMEOUT_MS, 600);
	assert.equal(SELECTION_COPY_INJECT_DELAY_MS, 80);
	assert.equal(fake.read(), "old");
});

test("unchanged clipboard times out as capture-failed without throwing", async () => {
	const fake = createFakeClipboard("old");
	const result = await readSystemSelection({ injectDelayMs: 0, platform: "darwin", clipboard: fake.clipboard, execFile: (_file, _args, _options, callback) => callback(null, "", ""), pollTimeoutMs: 0 });
	assert.deepEqual(plain(result), { ok: false, reason: "capture-failed" });
	assert.equal(fake.read(), "old");
});

test("a hostile clipboard degrades to a structured failure", async () => {
	const locked = {
		readText: () => {
			throw new Error("clipboard locked");
		},
		writeText: () => {
			throw new Error("clipboard busy");
		},
	};
	const result = await readSystemSelection({ injectDelayMs: 0, platform: "darwin", clipboard: locked, execFile: (_file, _args, _options, callback) => callback(null, "", "") });
	assert.deepEqual(plain(result), { ok: false, reason: "capture-failed" });
});

test("restore failure does not discard the captured text", async () => {
	let writes = 0;
	const clipboard = {
		readText: () => "captured",
		writeText: () => {
			writes += 1;
			// 第二次写入 = 恢复原文：模拟恢复瞬间剪贴板被别的进程占用。
			if (writes > 1) throw new Error("clipboard busy");
		},
	};
	const result = await readSystemSelection({ injectDelayMs: 0, platform: "darwin", clipboard, execFile: (_file, _args, _options, callback) => callback(null, "", "") });
	assert.deepEqual(plain(result), { ok: true, text: "captured" });
	assert.equal(writes, 2);
});
test("waits for the shortcut chord to be released before injecting the copy key", async () => {
	// 默认 injectDelayMs（80ms）：按下 Ctrl/Cmd+Shift+X 的瞬间物理修饰键还在，
	// 立即注入 Ctrl+C 会被目标应用读成带 Shift 的组合键。
	const waits = [];
	const fake = createFakeClipboard("old");
	const result = await readSystemSelection({
		injectDelayMs: undefined,
		platform: "darwin",
		clipboard: fake.clipboard,
		execFile: (_file, _args, _options, callback) => callback(null, "", ""),
		wait: async (ms) => {
			waits.push(ms);
		},
		// 剪贴板永远停在哨兵上：pollTimeoutMs=0 让轮询只读一次就结束，
		// 否则「瞬间返回的 wait」会把 600ms 轮询跑成百万次空转。
		pollTimeoutMs: 0,
	});
	assert.deepEqual(plain(result), { ok: false, reason: "capture-failed" });
	assert.deepEqual(waits, [SELECTION_COPY_INJECT_DELAY_MS]);
});
