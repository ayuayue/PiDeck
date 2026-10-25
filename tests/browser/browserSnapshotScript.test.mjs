import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// 页面内快照脚本的回归测试：用极简 DOM 桩直接调用 collectBrowserSnapshotInPage。
// loadTsCommonJs 的 globals 在模块加载时注入 vm 沙箱，因此用**可变 stub 对象**：
// 每个测试重置 domState 即可切换"页面内容"，引用保持稳定。
//
// 关键回归点：
// 1. 两段式——所有布局读（getBoundingClientRect）先于所有写（setAttribute data-pideck-ref），
//    读写交错会让每个 setAttribute 都触发整页样式/布局重算（复杂页面冻结数百 ms）；
// 2. 每个收录元素恰好一次 gBCR（可见性与 box 复用同一次读取）；
// 3. 密码遮蔽 / disabled 保留 / 无名容器不占预算 / opacity:0 祖先子树排除。

class FakeElement {
	constructor(tag, options = {}) {
		this.tagName = tag.toUpperCase();
		this.attrs = new Map(options.attrs ?? []);
		this.innerText = options.innerText ?? "";
		this.textContent = options.textContent ?? this.innerText;
		this.isContentEditable = Boolean(options.contentEditable);
		this.value = options.value ?? "";
		this.labels = options.labels ?? [];
		this.shadowRoot = options.shadowRoot ?? null;
		this.interactive = options.interactive ?? false;
		this.style = options.style ?? { display: "block", visibility: "visible", opacity: "1" };
		this.rect = options.rect ?? { x: 10, y: 20, width: 120, height: 30 };
		this.events = options.events ?? null;
		this.id = options.id ?? "";
		this.parentElement = options.parentElement ?? null;
		this.type = options.attrs instanceof Map && options.attrs.has("type") ? options.attrs.get("type") : (options.type ?? "");
	}
	getAttribute(name) {
		return this.attrs.has(name) ? this.attrs.get(name) : null;
	}
	hasAttribute(name) {
		return this.attrs.has(name);
	}
	setAttribute(name, value) {
		this.attrs.set(name, value);
		this.events?.push(`setAttribute:${name}`);
	}
	removeAttribute(name) {
		this.attrs.delete(name);
	}
	getBoundingClientRect() {
		this.events?.push("gBCR");
		return this.rect;
	}
	appendChild(child) {
		this.children = this.children ?? [];
		this.children.push(child);
		child.parentElement = this;
	}
	remove() {
		if (this.parentElement?.children) this.parentElement.children = this.parentElement.children.filter((entry) => entry !== this);
	}
}
class HTMLElement extends FakeElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}

const domState = { elements: [], iframes: [], created: [] };
const windowStub = {
	getComputedStyle: (element) => element.style,
	innerWidth: 1280,
	innerHeight: 800,
	scrollX: 0,
	scrollY: 40,
	devicePixelRatio: 1.5,
};
const documentRoot = new HTMLElement("html");
const documentStub = {
	title: "Test Page",
	body: documentRoot,
	documentElement: documentRoot,
	createElement(tag) {
		const node = new HTMLElement(tag);
		domState.created.push(node);
		return node;
	},
	querySelectorAll(selector) {
		if (selector === "*") return [...domState.elements];
		if (selector.includes("data-pideck-ref")) return domState.elements.filter((element) => element.hasAttribute("data-pideck-ref"));
		if (selector === "iframe") return domState.iframes;
		return domState.elements.filter((element) => element.interactive);
	},
	getElementById(id) {
		return domState.elements.find((element) => element.id === id) ?? null;
	},
};
const locationStub = { href: "https://example.test/page" };

const { collectBrowserSnapshotInPage, buildSnapshotExpression } = loadTsCommonJs("src/main/browser/browserSnapshotScript.ts", {
	globals: {
		window: windowStub,
		document: documentStub,
		location: locationStub,
		HTMLElement,
		HTMLInputElement,
		HTMLTextAreaElement,
		HTMLSelectElement,
	},
});

function installDom(elements) {
	const events = [];
	for (const element of elements) element.events = events;
	domState.elements = elements;
	domState.created = [];
	documentRoot.children = [];
	return events;
}

test("snapshot assigns refs in document order, masks passwords and keeps disabled visible", () => {
	const stale = new HTMLElement("button", { interactive: true, attrs: new Map([["data-pideck-ref", "e99"]]), innerText: "旧按钮" });
	const password = new HTMLInputElement("input", {
		interactive: true,
		attrs: new Map([
			["type", "password"],
			["aria-label", "密码"],
		]),
		value: "secret-token",
	});
	const disabled = new HTMLElement("button", { interactive: true, attrs: new Map([["disabled", ""]]), innerText: "提交" });
	const hidden = new HTMLElement("div", { interactive: true, style: { display: "none", visibility: "visible", opacity: "1" } });
	const plain = new HTMLElement("span", { interactive: false, innerText: "只是文字" });
	const events = installDom([stale, password, disabled, hidden, plain]);

	const result = collectBrowserSnapshotInPage({ maxElements: 50, includeBoxes: true });

	assert.deepEqual(
		Array.from(result.elements, (element) => element.ref),
		["e1", "e2", "e3"],
		"refs follow document order of visible interactive elements",
	);
	assert.equal(stale.getAttribute("data-pideck-ref"), "e1", "stale ref from a previous snapshot is replaced");
	assert.equal(result.elements[1].value, "[password]", "password values must be masked");
	assert.equal(result.elements[2].disabled, true, "disabled elements stay visible with a flag");
	assert.equal(result.totalElements, 3);
	assert.equal(result.truncated, false);
	assert.equal(result.iframeCount, 0);
	assert.equal(result.viewport.height, 800);
	assert.equal(result.scroll.y, 40);
	assert.equal(result.devicePixelRatio, 1.5);
	assert.equal(result.url, "https://example.test/page");
	// rect 复用回归：每个收录元素恰好一次 gBCR（可见性与 box 不再各读一次）；
	// display:none 的隐藏元素在样式阶段就被排除，不触发布局读。
	assert.equal(events.filter((event) => event === "gBCR").length, 3, "one layout read per collected element");
});

test("snapshot caps elements and reports the true visible total", () => {
	const elements = Array.from({ length: 4 }, (_value, index) => new HTMLElement("button", { interactive: true, innerText: `按钮${index}` }));
	installDom(elements);
	const result = collectBrowserSnapshotInPage({ maxElements: 2, includeBoxes: false });
	assert.equal(result.elements.length, 2);
	assert.equal(result.totalElements, 4);
	assert.equal(result.truncated, true);
	assert.equal(result.elements[0].box, undefined, "boxes are omitted when includeBoxes is false");
});

test("two-phase snapshot: every layout read happens before any ref write (no layout thrash)", () => {
	const elements = Array.from({ length: 6 }, (_value, index) => new HTMLElement("button", { interactive: true, innerText: `按钮${index}` }));
	const events = installDom(elements);

	collectBrowserSnapshotInPage({ maxElements: 50, includeBoxes: true });

	const lastRead = events.lastIndexOf("gBCR");
	const firstWrite = events.findIndex((event) => event === "setAttribute:data-pideck-ref");
	assert.ok(firstWrite !== -1, "refs were assigned");
	assert.ok(lastRead !== -1, "layout reads happened");
	assert.ok(lastRead < firstWrite, `layout reads must all precede ref writes (lastRead=${lastRead}, firstWrite=${firstWrite})`);
});

test("unnamed layout containers are skipped and do not eat the element budget", () => {
	const container = new HTMLElement("div", { interactive: true, attrs: new Map([["role", "main"]]), innerText: "整页正文都在这里".repeat(50) });
	const namedRegion = new HTMLElement("section", {
		interactive: true,
		attrs: new Map([
			["role", "region"],
			["aria-label", "搜索结果"],
		]),
		innerText: "x",
	});
	const button = new HTMLElement("button", { interactive: true, innerText: "真正的按钮" });
	installDom([container, namedRegion, button]);

	const result = collectBrowserSnapshotInPage({ maxElements: 5, includeBoxes: false });

	assert.deepEqual(
		Array.from(result.elements, (element) => element.name),
		["搜索结果", "真正的按钮"],
		"named containers stay, unnamed layout containers are dropped from the budget",
	);
});

test("elements inside an opacity:0 ancestor are excluded", () => {
	const hiddenParent = new HTMLElement("div", { style: { display: "block", visibility: "visible", opacity: "0" } });
	const child = new HTMLElement("button", { interactive: true, innerText: "看不见的按钮" });
	child.parentElement = hiddenParent;
	const visible = new HTMLElement("button", { interactive: true, innerText: "看得见的按钮" });
	installDom([child, visible]);

	const result = collectBrowserSnapshotInPage({ maxElements: 5, includeBoxes: false });

	assert.deepEqual(
		Array.from(result.elements, (element) => element.name),
		["看得见的按钮"],
		"the subtree of an opacity:0 ancestor must not receive a ref",
	);
});

test("buildSnapshotExpression wraps the self-contained function with serialized options", () => {
	const expression = buildSnapshotExpression({ maxElements: 12, includeBoxes: false, renderOverlay: true });
	assert.match(expression, /^\(function collectBrowserSnapshotInPage\(/);
	assert.ok(expression.endsWith(')({"maxElements":12,"includeBoxes":false,"renderOverlay":true})'), "options are JSON-serialized into the call");
});

test("snapshot renders the recognition overlay with ref tags unless disabled", () => {
	const elements = [new HTMLElement("button", { interactive: true, innerText: "按钮一" }), new HTMLElement("button", { interactive: true, innerText: "按钮二" })];
	installDom(elements);

	collectBrowserSnapshotInPage({ maxElements: 10, includeBoxes: false });
	assert.ok(domState.created.length >= 3, "overlay container + one box per element were created");
	const overlay = domState.created[0];
	assert.ok(String(overlay.style.cssText ?? "").includes("pointer-events:none"), "overlay must not intercept input");
	const tags = domState.created.filter((node) => node.textContent === "e1" || node.textContent === "e2");
	assert.equal(tags.length, 2, "each recognized element gets a ref tag");

	domState.created = [];
	collectBrowserSnapshotInPage({ maxElements: 10, includeBoxes: false, renderOverlay: false });
	assert.equal(domState.created.length, 0, "renderOverlay:false draws nothing");
});
