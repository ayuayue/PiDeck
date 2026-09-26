/**
 * GUI 扩展桥 —— S1 拦截可行性的**端到端回归测试**。
 *
 * 这是整个桥方案的**地基**：桥必须在 pi 的 RPC 降级之后、仍能拦到
 * **其他扩展**调用的 `ctx.ui`。不成立则整个方案没有支点。
 *
 * 与 `guiBridge.test.mjs` 的区别：那边用替身验证桥自身逻辑，
 * 这边用 **pi 真实的 `ExtensionRunner`**（`dist/core/extensions/runner.js`）
 * 验证拦截链路真的通。
 *
 * ## 环境依赖与跳过策略
 *
 * 需要本机装有 pi（`@earendil-works/pi-coding-agent`）。CI/无 pi 环境下
 * **优雅跳过**而不是失败 —— 这条测试的价值在于「有 pi 时能证明地基成立」，
 * 而不是给没有 pi 的机器制造红灯。
 *
 * ## 为什么断言的是「另一个扩展」
 *
 * 桥自己拿到包装版毫无意义（它自己 patch 的）。真正要证明的是：
 * 扩展 B 在**完全不知道桥存在**的情况下调用 `ctx.ui.setFooter(...)`，
 * 这次调用落到桥的包装里。这才是 S1。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 加载桥的运行时模块（无扩展名相对 import，由现成 helper 解析；不用自写钩子）。
 *
 * 注意：pi 包本身仍走**原生 ESM import**（见下方 `runnerPath`）—— 它的
 * `package.json#exports` 只有 import 条件、且是 ESM-only，不能进 CJS 沙箱。
 * 桥这一侧是我们自己的 TS，走沙箱即可；两者在同一个 Node 进程里协作。
 */
const loadBridgeModule = createTsSandbox({ globals: { fetch: globalThis.fetch } });

/**
 * 在常见位置找 pi 的安装目录；找不到返回 null。
 *
 * ⚠️ 必须用**文件系统探测**而不是 `createRequire().resolve()`：
 * `@earendil-works/pi-coding-agent` 的 `package.json#exports` 只有 `import` 条件
 * （ESM-only，没有 `require`），CJS 解析会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 * （`pi-tui` 有 require 条件，所以桥的加载器可以直接 resolve 它。）
 */
function findPiPackageDir() {
	const { join } = require_("node:path");
	const { homedir } = require_("node:os");
	const execDir = require_("node:path").dirname(process.execPath);
	const globalRoots = [
		// Windows：npm 全局前缀是 %APPDATA%\npm（不是 node 安装目录旁边）
		process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
		// Unix
		join(execDir, "..", "lib", "node_modules"),
		join(execDir, "node_modules"),
		// nvm / 用户级全局
		join(homedir(), ".npm-global", "lib", "node_modules"),
	].filter(Boolean);

	const probe = (dir) => {
		if (!dir) return null;
		const pkgJson = join(dir, "@earendil-works", "pi-coding-agent", "package.json");
		return existsSync(pkgJson) ? { pkgDir: join(dir, "@earendil-works", "pi-coding-agent"), require: require_ } : null;
	};

	// 1) 显式注入的 pi 路径（PiDeck spawn 时会注入）
	const explicit = process.env.PIDECK_BRIDGE_PI_PATH?.trim();
	if (explicit) {
		// 可能是 <pi>/dist/bundle/cli.js，也可能是包目录
		const fromExplicit = explicit.replace(/[\\/]dist[\\/].*$/, "");
		const hit = probe(require_("node:path").dirname(fromExplicit)) ?? probe(fromExplicit);
		if (hit) return hit;
	}
	// 2) 全局安装位置逐个探测
	for (const root of globalRoots) {
		const hit = probe(root);
		if (hit) return hit;
	}
	return null;
}

const require_ = createRequire(import.meta.url);
const piLocation = findPiPackageDir();
const runnerPath = piLocation ? `${piLocation.pkgDir.replace(/\\/g, "/")}/dist/core/extensions/runner.js` : null;
const hasRunner = Boolean(runnerPath && existsSync(runnerPath));

// 环境没有 pi → 跳过（不是失败）
const maybeDescribe = hasRunner ? describe : describe.skip;
if (!hasRunner) {
	console.log("[guiBridgeS1] 未找到 pi 安装（@earendil-works/pi-coding-agent），跳过 S1 端到端测试。");
}

const { ExtensionRunner } = hasRunner ? await import(`file:///${runnerPath}`) : {};

/** 模拟 rpc-mode.js 建出来的那份 UI 上下文（靶子：一批空实现）。 */
function makeRpcLikeUi() {
	const seen = [];
	return {
		__seen: seen,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => seen.push({ method: "notify", message, type }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => seen.push({ method: "setStatus", key, text }),
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget(key, content, options) {
			if (content === undefined || Array.isArray(content)) seen.push({ method: "setWidget", key, content, options });
		},
		setFooter() {},
		setHeader() {},
		setTitle: (title) => seen.push({ method: "setTitle", title }),
		custom: async () => undefined,
		pasteToEditor() {},
		setEditorText: (text) => seen.push({ method: "set_editor_text", text }),
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent: () => undefined,
		get theme() {
			return { fg: (_n, t) => t };
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
}

/** 建真实 ExtensionRunner（只测 ui 通路，其余依赖给最小替身）。 */
function makeRunner() {
	const runtime = { getActiveTools: () => [], getAllTools: () => [] };
	return new ExtensionRunner([], runtime, process.cwd(), {}, {});
}

/** 建桥运行时 + 记录推送的 transport（同一个 loader 实例 → 模块只求值一次）。 */
function makeBridge() {
	const runtimeMod = loadBridgeModule("resources/extensions/pi-deck-gui-bridge-runtime.ts");
	const pushed = [];
	const transport = { available: true, push: (u) => pushed.push(u), onEvent: () => {}, close: () => {} };
	return { bridge: runtimeMod.createBridgeRuntime(transport), pushed, runtimeMod };
}

maybeDescribe("S1: ctx.ui 拦截（真实 ExtensionRunner）", () => {
	it("ctx.ui 是共享单例的活 getter（方案支点）", () => {
		const runner = makeRunner();
		runner.setUIContext(makeRpcLikeUi(), "rpc");
		const ctxA = runner.createContext();
		const ctxB = runner.createContext();
		assert.notEqual(ctxA, ctxB, "两次 createContext 的 ctx 应是不同对象");
		assert.equal(ctxA.ui, ctxB.ui, "但 ctx.ui 必须是同一份实例 —— 不共享则 S1 失败");
		assert.equal(ctxA.ui, runner.getUIContext());
	});

	it("★ 桥包装一次后，另一个扩展取到的 ctx.ui 已是包装版", async () => {
		const runner = makeRunner();
		runner.setUIContext(makeRpcLikeUi(), "rpc");
		const { bridge, pushed } = await makeBridge();

		// 桥 patch（模拟桥扩展在 session_start 里做的事）
		bridge.wrapUI(runner.createContext().ui);

		// 「扩展 B」：完全不知道桥存在，按 pi 官方文档调用
		const otherUi = runner.createContext().ui;
		otherUi.setFooter(() => ({ render: () => ["ext B footer"] }));
		otherUi.setHeader(() => ({ render: () => ["ext B header"] }));
		otherUi.setStatus("ext-b", "hello");
		otherUi.setWorkingMessage("B working");
		otherUi.setHiddenThinkingLabel("B thinking");
		otherUi.setTitle("B title");

		assert.ok(
			pushed.some((u) => u.type === "ui-update" && u.targetId === "footer" && u.node),
			"扩展 B 的 setFooter 必须落到桥（RPC 下原本被丢弃）",
		);
		assert.ok(
			pushed.some((u) => u.type === "ui-update" && u.targetId === "header" && u.node),
			"扩展 B 的 setHeader 必须落到桥",
		);
		assert.ok(
			pushed.some((u) => u.type === "status" && u.key === "ext-b"),
			"扩展 B 的 setStatus 必须落到桥",
		);
		assert.ok(
			pushed.some((u) => u.type === "working" && u.message === "B working"),
			"setWorkingMessage 必须落到桥",
		);
		assert.ok(
			pushed.some((u) => u.type === "thinking-label" && u.label === "B thinking"),
			"setHiddenThinkingLabel 必须落到桥",
		);
		assert.ok(
			pushed.some((u) => u.type === "title" && u.title === "B title"),
			"setTitle 必须落到桥",
		);
	});

	it("setWidget 工厂形式（RPC 下原本被丢弃）被桥接", async () => {
		const runner = makeRunner();
		runner.setUIContext(makeRpcLikeUi(), "rpc");
		const { bridge, pushed } = await makeBridge();
		bridge.wrapUI(runner.createContext().ui);

		runner.createContext().ui.setWidget("factory-widget", () => ({ render: () => ["body"] }));
		assert.ok(
			pushed.some((u) => u.type === "ui-update" && String(u.targetId).startsWith("widget:factory-widget")),
			"工厂形式 widget 必须由桥推送",
		);
	});

	it("只补不拆：已有能力仍走原路", async () => {
		const runner = makeRunner();
		const rpcUi = makeRpcLikeUi();
		runner.setUIContext(rpcUi, "rpc");
		const { bridge } = await makeBridge();
		bridge.wrapUI(runner.createContext().ui);
		const ui = runner.createContext().ui;

		// setWidget(string[]) 必须仍转发给原实现（§14.4）
		rpcUi.__seen.length = 0;
		ui.setWidget("lines", ["a", "b"]);
		assert.ok(
			rpcUi.__seen.some((s) => s.method === "setWidget" && s.key === "lines"),
			"字符串 widget 必须走原路",
		);

		// setStatus 必须仍转发 —— 否则 PiDeck 的 pideck:auto-title 自动标题会失效（§7.7）
		rpcUi.__seen.length = 0;
		ui.setStatus("pideck:auto-title", "Auto Title");
		assert.ok(
			rpcUi.__seen.some((s) => s.method === "setStatus" && s.key === "pideck:auto-title"),
			"setStatus 必须转发，否则自动标题失效",
		);

		// notify / setEditorText 不应被桥触碰
		rpcUi.__seen.length = 0;
		ui.notify("hello", "info");
		assert.ok(
			rpcUi.__seen.some((s) => s.method === "notify"),
			"notify 应走原路",
		);
		rpcUi.__seen.length = 0;
		ui.setEditorText("text");
		assert.ok(
			rpcUi.__seen.some((s) => s.method === "set_editor_text"),
			"setEditorText 应走原路",
		);
	});

	it("包装幂等：重复 wrapUI 不叠加（/reload 场景）", async () => {
		const runner = makeRunner();
		runner.setUIContext(makeRpcLikeUi(), "rpc");
		const { bridge } = await makeBridge();
		const ui = runner.createContext().ui;
		bridge.wrapUI(ui);
		const before = ui.setFooter;
		bridge.wrapUI(ui);
		assert.equal(ui.setFooter, before, "重复包装应被 __pideckBridgeWrapped 标记挡住");
	});
});
