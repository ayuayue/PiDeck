import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// Controller 的截图函数来自依赖 electron 的模块；测试里只需要一个空壳（截图路径不参与动作测试）。
const electronStub = { nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) } };
const { BrowserController } = loadTsCommonJs("src/main/browser/BrowserController.ts", { stubs: { electron: electronStub } });
const { BrowserAgentError } = loadTsCommonJs("src/main/browser/browserErrors.ts");

const META = { sessionId: "sess-1" };

function makeGuest(overrides = {}) {
	return {
		id: 7,
		isDestroyed: () => false,
		getURL: () => "https://example.com/",
		getTitle: () => "Example",
		executeJavaScript: async () => true,
		...overrides,
	};
}

function makeRegistry(guest) {
	return { resolve: () => (guest ? { guest, id: guest.id, url: guest.getURL(), title: guest.getTitle() } : null) };
}

function makeCdp(handler) {
	const calls = [];
	return {
		calls,
		withGuest: async (guest, run) =>
			run(async (method, params) => {
				calls.push({ method, params });
				return handler(method, params);
			}),
	};
}

function evaluateResult(value) {
	return { result: { value } };
}

const RESOLVED = { found: true, visible: true, disabled: false, name: "Go", tag: "button", rect: { x: 100, y: 200, width: 40, height: 20 } };

const SNAPSHOT_ELEMENT = { ref: "e1", role: "button", name: "Go", tag: "button" };

// ref 动作现在要求先有快照（身份校验防页面搬运 data-pideck-ref）：按表达式区分返回。
function makeSnapshotCdp(overrides = {}) {
	const calls = [];
	const resolved = overrides.resolved ?? RESOLVED;
	return {
		calls,
		withGuest: async (guest, run) =>
			run(async (method, params) => {
				calls.push({ method, params });
				if (method === "Runtime.evaluate") {
					const expression = String(params?.expression ?? "");
					if (expression.includes("collectBrowserSnapshotInPage")) {
						return evaluateResult({ url: "https://example.com/", title: "Example", viewport: { width: 800, height: 600 }, elements: [SNAPSHOT_ELEMENT], totalElements: 1 });
					}
					if (expression.includes("data-pideck-ref")) return evaluateResult(resolved);
					return evaluateResult(true);
				}
				return {};
			}),
	};
}

function makeController({ registry, cdp, gate = { check: async () => ({ allowed: true, reason: "auto_approve" }) } } = {}) {
	return new BrowserController({
		registry: registry ?? makeRegistry(makeGuest()),
		cdp: cdp ?? makeCdp(() => ({})),
		gate,
		capture: async () => ({ base64: "", mimeType: "image/jpeg", width: 1, height: 1, cssWidth: 1, cssHeight: 1, scaleFactor: 1, source: "cdp" }),
	});
}

async function rejectsWithCode(promise, code) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
		return true;
	});
}

test("browser_not_open when no guest is resolvable", async () => {
	const controller = makeController({ registry: { resolve: () => null } });
	await rejectsWithCode(controller.getState(), "browser_not_open");
	await rejectsWithCode(controller.snapshot(), "browser_not_open");
});

test("snapshot normalizes the page payload and assigns increasing snapshot ids", async () => {
	const cdp = makeCdp(() =>
		evaluateResult({
			url: "https://example.com/",
			title: "Example",
			viewport: { width: 800, height: 600 },
			scroll: { x: 0, y: 0 },
			elements: [{ ref: "e1", role: "button", name: "Go", tag: "button" }],
			totalElements: 1,
		}),
	);
	const controller = makeController({ cdp });
	const first = await controller.snapshot();
	assert.equal(first.snapshotId, 1);
	assert.match(first.text, /- button "Go" \[ref=e1\]/);
	assert.equal(first.totalElements, 1);
	const second = await controller.snapshot();
	assert.equal(second.snapshotId, 2);
});

test("stale refs, invisible elements and disabled elements are rejected before any input", async () => {
	const staleCdp = makeCdp(() => evaluateResult({ found: false }));
	const staleController = makeController({ cdp: staleCdp });
	await rejectsWithCode(staleController.click({ ref: "e1" }, META), "stale_ref");
	assert.equal(staleCdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0);

	const hiddenCdp = makeCdp(() => evaluateResult({ ...RESOLVED, visible: false }));
	await rejectsWithCode(makeController({ cdp: hiddenCdp }).click({ ref: "e1" }, META), "element_not_visible");

	const disabledCdp = makeCdp(() => evaluateResult({ ...RESOLVED, disabled: true }));
	await rejectsWithCode(makeController({ cdp: disabledCdp }).click({ ref: "e1" }, META), "element_disabled");
});

test("a denied approval gate stops the action and maps CUA reason to browser_disabled", async () => {
	const cdp = makeSnapshotCdp();
	const gate = { check: async () => ({ allowed: false, reason: "cua_disabled" }) };
	const controller = makeController({ cdp, gate });
	await controller.snapshot();
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "browser_disabled");
	assert.equal(cdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0, "no input when the gate denies");
});

test("click re-reads the rect after scrolling and dispatches a full mouse sequence", async () => {
	const cdp = makeSnapshotCdp();
	const gate = {
		check: async (action, sessionId, detail) => {
			gateCalls.push({ action, sessionId, detail });
			return { allowed: true, reason: "auto_approve" };
		},
	};
	const gateCalls = [];
	const controller = makeController({ cdp, gate });
	await controller.snapshot();
	const result = await controller.click({ ref: "e1" }, { sessionId: "sess-9", agentId: "agent-1" });
	assert.equal(result.gate, "auto_approve");
	assert.equal(gateCalls[0].action, "browser_click");
	assert.equal(gateCalls[0].sessionId, "sess-9");
	assert.equal(gateCalls[0].detail.ref, "e1");
	// 动作可视化：点击前应在页面上短暂高亮目标元素（用户看到的「选取效果」）。
	assert.ok(
		cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("__pideck_agent_highlight")),
		"click must flash a highlight on the target element",
	);
	const inputCalls = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
	assert.deepEqual(
		inputCalls.map((call) => call.params.type),
		["mouseMoved", "mousePressed", "mouseReleased"],
	);
	assert.equal(inputCalls[1].params.x, 120);
	assert.equal(inputCalls[1].params.y, 210);
	assert.equal(inputCalls[1].params.clickCount, 1);
});

test("type focuses the element and inserts text; submit presses Enter", async () => {
	const cdp = makeSnapshotCdp();
	const controller = makeController({ cdp });
	await controller.snapshot();
	await controller.type({ ref: "e1", text: "hello", clear: true, submit: true }, META);
	const inserted = cdp.calls.filter((call) => call.method === "Input.insertText");
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].params.text, "hello");
	const keyDowns = cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
	assert.ok(keyDowns.some((call) => call.params.key === "Enter"));
});

test("navigate rejects non-http URLs before asking for approval", async () => {
	let gateCalls = 0;
	const cdp = makeCdp(() => evaluateResult(RESOLVED));
	const controller = makeController({
		cdp,
		gate: {
			check: async () => {
				gateCalls += 1;
				return { allowed: true };
			},
		},
	});
	await rejectsWithCode(controller.navigate({ url: "file:///etc/passwd" }, META), "url_not_allowed");
	assert.equal(gateCalls, 0);
});

test("unsupported keys fail with unsupported_key", async () => {
	const controller = makeController();
	await rejectsWithCode(controller.pressKey({ key: "f13" }, META), "unsupported_key");
});

test("scroll falls back to executeJavaScript when CDP is busy and reports degraded", async () => {
	const cdp = makeCdp((method) => {
		if (method === "Runtime.evaluate") return evaluateResult({ viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } });
		throw new BrowserAgentError("cdp_busy", "debugger already attached");
	});
	const controller = makeController({ cdp });
	const result = await controller.scroll({ deltaY: -200 }, META);
	assert.equal(result.degraded, true);
});

// ── ref 身份校验（防页面搬运 data-pideck-ref 重定向点击） ─────────────────────

test("ref actions without a prior snapshot are rejected as stale_ref", async () => {
	const cdp = makeCdp(() => evaluateResult(RESOLVED));
	const controller = makeController({ cdp });
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "stale_ref");
	assert.equal(cdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0, "a planted attribute must not survive without a snapshot entry");
});

test("an element whose tag no longer matches the snapshot entry is rejected", async () => {
	const cdp = makeSnapshotCdp({ resolved: { ...RESOLVED, tag: "a", name: "Go" } });
	const controller = makeController({ cdp });
	await controller.snapshot();
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "stale_ref");
});

test("an element whose name no longer matches the snapshot entry is rejected", async () => {
	const cdp = makeSnapshotCdp({ resolved: { ...RESOLVED, name: "Transfer money now" } });
	const controller = makeController({ cdp });
	await controller.snapshot();
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "stale_ref");
	assert.equal(cdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0);
});

test("invalidateSnapshot drops ref identity so late write actions are rejected", async () => {
	const cdp = makeSnapshotCdp();
	const controller = makeController({ cdp });
	await controller.snapshot();
	controller.invalidateSnapshot();
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "stale_ref");
});

// ── waitFor 单租约轮询 ───────────────────────────────────────────────────────

test("waitFor polls inside a single CDP lease and reports a match", async () => {
	let withGuestCalls = 0;
	let pollIndex = 0;
	const answers = [false, false, true];
	const cdp = {
		withGuest: async (guest, run) => {
			withGuestCalls += 1;
			return run(async (method, params) => evaluateResult(answers[Math.min(pollIndex++, answers.length - 1)]));
		},
	};
	const controller = makeController({ cdp });
	const result = await controller.waitFor({ text: "ready", timeoutMs: 5000 });
	assert.equal(result.matched, true);
	assert.equal(withGuestCalls, 1, "the whole wait must reuse one CDP lease, not attach per poll");
});

test("click execution runs inside a single CDP lease", async () => {
	const base = makeSnapshotCdp();
	let depth = 0;
	let outerLeases = 0;
	const innerWithGuest = base.withGuest;
	base.withGuest = async (guest, run) => {
		if (depth === 0) outerLeases += 1;
		depth += 1;
		try {
			return await innerWithGuest(guest, run);
		} finally {
			depth -= 1;
		}
	};
	const controller = makeController({ cdp: base });
	await controller.snapshot();
	await controller.click({ ref: "e1" }, META);
	// snapshot 1 次 + click 解析 1 次 + 执行段 1 次（滚动/重读/高亮/Input 全部复用同一租约）。
	// 重构前 click 一条链要 5 次独立 attach/detach，中途被 DevTools 抢占会让 degraded 前后不一致。
	assert.equal(outerLeases, 3, `expected 3 outer leases (snapshot + resolve + execution), got ${outerLeases}`);
});

test("screenshot clears visualization overlays before capturing", async () => {
	const cdp = makeCdp((method) => {
		if (method === "Runtime.evaluate") return evaluateResult({ url: "https://example.com/", title: "t", viewport: { width: 100, height: 50 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1 });
		return {};
	});
	const controller = makeController({ cdp });
	await controller.screenshot();
	assert.ok(
		cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("__pideck_agent_boxes")),
		"recognition/highlight overlays must be cleared before the capture",
	);
});

test("find flashes the matched elements on the page", async () => {
	const cdp = makeSnapshotCdp();
	const controller = makeController({ cdp });
	await controller.snapshot();
	const result = await controller.find({ text: "go" });
	assert.equal(result.matches.length, 1);
	assert.ok(
		cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("__pideck_agent_find")),
		"find matches must be outlined on the page",
	);
});

test("waitFor degrades to executeJavaScript polling when CDP is busy", async () => {
	const execCalls = [];
	const guest = makeGuest({ executeJavaScript: async () => execCalls.push(1) >= 2 });
	const cdp = {
		withGuest: async () => {
			throw new BrowserAgentError("cdp_busy", "debugger already attached");
		},
	};
	const controller = makeController({ registry: makeRegistry(guest), cdp });
	const result = await controller.waitFor({ text: "ready", timeoutMs: 5000 });
	assert.equal(result.matched, true);
	assert.equal(result.degraded, true);
	assert.equal(execCalls.length, 2);
});
