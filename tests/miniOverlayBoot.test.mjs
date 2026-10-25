import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync("src/renderer/index.html", "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

/** 在 React 下载前执行真实 HTML 内联脚本，检查首帧是否仍会出现开屏品牌动画。 */
function runBootstrap(search, storage = {}) {
	const classes = new Set();
	const overlays = [];
	const overlay = { remove: () => overlays.push("removed") };
	const listeners = new Map();
	const nodes = new Map();
	// 内联脚本会注册 DOMContentLoaded 回调（写入自定义品牌名/Logo），也会用
	// querySelector 取延迟节点——stub 必须提供这些 DOM 能力，否则脚本第一行就抛
	// “document.addEventListener is not a function”（品牌自定义提交加入后 CI 红）。
	const document = {
		documentElement: { classList: { add: (name) => classes.add(name) } },
		getElementById: () => overlay,
		querySelector: (selector) => nodes.get(selector) ?? null,
		addEventListener: (type, handler) => listeners.set(type, [...(listeners.get(type) ?? []), handler]),
	};
	vm.runInNewContext(script, {
		URLSearchParams,
		location: { search },
		localStorage: { getItem: (key) => storage[key] ?? null },
		document,
	});
	return {
		classes,
		overlays,
		nodes,
		dispatch: (type) => (listeners.get(type) ?? []).forEach((handler) => handler()),
	};
}

test("悬浮小窗 HTML 首帧隐藏开屏动画，不等 React 或淡出定时器", () => {
	const { classes } = runBootstrap("?mini-overlay=1");
	assert.ok(classes.has("skip-boot-overlay"));
	assert.match(html, /html\.skip-boot-overlay\s+#boot-overlay\s*\{[^}]*display\s*:\s*none\s*;/);
});

test("正常工作台冷启动保留启动交接遮罩", () => {
	assert.equal(runBootstrap("").classes.has("skip-boot-overlay"), false);
});

test("启动内联脚本保持 CSP 内容哈希授权", () => {
	const hash = createHash("sha256").update(script).digest("base64");
	assert.ok(html.includes(`'sha256-${hash}'`));
});

test("自定义品牌名与 Logo 在 React 之前写入开屏元素", () => {
	// 开屏节点是 HTML 静态节点，脚本执行时先拿到引用、等 DOMContentLoaded 再赋值
	const { classes, nodes, dispatch } = runBootstrap("", {
		"pideck:logo-style:v2": "custom",
		"pideck:custom-logo:v1": "data:image/png;base64,AAA",
		"pideck:app-name:v1": "我的 PiDeck",
	});
	assert.ok(classes.has("logo-custom"), "自定义 Logo 需要在首帧就切到 logo-custom 样式");
	nodes.set(".boot-title", { textContent: "PiDeck" });
	nodes.set(".boot-logo-custom", { src: "" });
	dispatch("DOMContentLoaded");
	assert.equal(nodes.get(".boot-title").textContent, "我的 PiDeck");
	assert.equal(nodes.get(".boot-logo-custom").src, "data:image/png;base64,AAA");
});

test("未自定义品牌时不改开屏默认值", () => {
	const { classes, nodes, dispatch } = runBootstrap("");
	assert.equal(classes.has("logo-custom"), false);
	assert.ok(classes.has("logo-pi-tui"), "默认应走内置 Logo 样式");
	nodes.set(".boot-title", { textContent: "PiDeck" });
	nodes.set(".boot-logo-custom", { src: "keep" });
	dispatch("DOMContentLoaded");
	assert.equal(nodes.get(".boot-title").textContent, "PiDeck");
	assert.equal(nodes.get(".boot-logo-custom").src, "keep");
});
