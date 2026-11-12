import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const listState = loadTsCommonJs("src/renderer/src/components/session/remoteSessionListState.ts");
const titleState = loadTsCommonJs("src/renderer/src/components/session/remoteSessionTitleState.ts");
const rootStatusState = loadTsCommonJs("src/renderer/src/components/sidebar/remoteProjectStatusState.ts");

const { readScanResponse, readRegisterResponse, collectRegisteredRemoteSessionIds, createRemoteSessionListController, REMOTE_SESSION_LIMIT_CODES } = listState;
const { readTitleResponse, createRemoteSessionTitleController, isProvisionalTitleOrigin } = titleState;
const { readRootStatusResponse } = rootStatusState;

/** 一条合法的远端会话条目（主进程扫描返回的字段形状）。 */
function entry(id, overrides = {}) {
	return {
		remoteSessionId: id,
		remotePath: id,
		name: id
			.split("/")
			.pop()
			.replace(/\.jsonl$/, ""),
		size: 12,
		mtimeMs: 1_700_000_000_000,
		...overrides,
	};
}

test("扫描响应逐字段收窄：畸形条目不当作空列表", () => {
	const good = readScanResponse({ ok: true, entries: [entry("ws-a/1.jsonl")] });
	assert.equal(good.kind, "ok");
	assert.equal(good.entries.length, 1);
	assert.equal([...readScanResponse({ ok: true, entries: [] }).entries].length, 0);

	// 缺字段/字段类型不对/非字符串 id 一律 rejected：读不懂就不渲染，绝不降级成「没有会话」。
	assert.equal(readScanResponse({ ok: true, entries: [{ name: "x" }] }).kind, "rejected");
	assert.equal(readScanResponse({ ok: true, entries: [entry("ws-a/1.jsonl", { size: -1 })] }).kind, "rejected");
	assert.equal(readScanResponse({ ok: true, entries: [entry("ws-a/1.jsonl", { mtimeMs: "now" })] }).kind, "rejected");
	assert.equal(readScanResponse({ ok: true, entries: "nope" }).kind, "rejected");
	assert.equal(readScanResponse(null).kind, "rejected");
	// 绝对路径/反斜杠/.. 段不是合法的远端会话身份。
	assert.equal(readScanResponse({ ok: true, entries: [entry("/abs/1.jsonl")] }).kind, "rejected");
	assert.equal(readScanResponse({ ok: true, entries: [entry("ws-a/../1.jsonl")] }).kind, "rejected");
	assert.equal(readScanResponse({ ok: true, entries: [entry("ws-a/1.txt")] }).kind, "rejected");
	// 重复身份会让 React key 与登记目标含糊，直接判畸形。
	assert.equal(readScanResponse({ ok: true, entries: [entry("ws-a/1.jsonl"), entry("ws-a/1.jsonl")] }).kind, "rejected");
});

test("扫描失败只认稳定码，上限拒绝与普通失败可区分", () => {
	const failed = readScanResponse({ ok: false, code: "REMOTE_SESSION_HOME_UNAVAILABLE" });
	assert.equal(failed.kind, "failed");
	assert.equal(failed.code, "REMOTE_SESSION_HOME_UNAVAILABLE");
	// 自由文本不是码：当成读不懂的响应，而不是把远端错误原文当码显示。
	assert.equal(readScanResponse({ ok: false, code: "boom: something" }).kind, "rejected");
	assert.equal(readScanResponse({ ok: false }).kind, "rejected");

	// 上限是**拒绝**而不是截断：这些码必须能被界面单独识别。
	for (const code of ["REMOTE_SESSION_DIR_LIMIT_EXCEEDED", "REMOTE_SESSION_FILE_LIMIT_EXCEEDED", "REMOTE_SESSION_BUDGET_EXCEEDED"]) {
		assert.equal(REMOTE_SESSION_LIMIT_CODES.has(code), true, code + " 必须在上限码集合里");
	}
	assert.equal(REMOTE_SESSION_LIMIT_CODES.has("REMOTE_SESSION_SCAN_FAILED"), false);
});

test("未知/新出现的扫描失败码走错误态（不是空列表），并如实把码显示出来", () => {
	// J2 新增 REMOTE_SESSION_SESSION_DIR_INVALID：读取方不认识它也必须按「拒绝」呈现——
	// 退化成 empty（空列表）就等于把「整次扫描被拒绝」说成「远端没有会话」。
	const outcome = readScanResponse({ ok: false, code: "REMOTE_SESSION_SESSION_DIR_INVALID" });
	assert.equal(outcome.kind, "failed");
	assert.equal(outcome.code, "REMOTE_SESSION_SESSION_DIR_INVALID");

	const controller = createRemoteSessionListController();
	const generation = controller.start("host-a");
	assert.equal(controller.settle(generation, outcome), true);
	assert.equal(controller.getState().phase, "error");
	assert.notEqual(controller.getState().phase, "empty");
	assert.equal(controller.getState().errorCode, "REMOTE_SESSION_SESSION_DIR_INVALID");
	assert.equal([...controller.getState().entries].length, 0);

	// 呈现层：错误态与空态是两段独立渲染，未知码落到带 {code} 的兜底文案里（不吞码）。
	const section = readFileSync("src/renderer/src/components/sidebar/RemoteSessionsSection.tsx", "utf8");
	assert.match(section, /t\("sidebar\.remoteSessions\.scanFailed", \{ code \}\)/);
	assert.match(section, /state\.phase === "error"/);
	assert.match(section, /state\.phase === "empty"/);
});

test("列表状态机：旧代次结果作废，切主机不回写", () => {
	const controller = createRemoteSessionListController();
	assert.equal(controller.getState().phase, "idle");

	const first = controller.start("host-a");
	assert.equal(controller.getState().phase, "scanning");
	assert.equal(controller.getState().hostId, "host-a");

	// 切主机 = 新一代：旧代次的结果必须被丢弃，不能覆盖新主机。
	const second = controller.start("host-b");
	assert.equal(controller.settle(first, { kind: "ok", entries: [entry("ws-a/1.jsonl")] }), false);
	assert.equal(controller.getState().phase, "scanning");
	assert.equal(controller.getState().hostId, "host-b");
	assert.equal([...controller.getState().entries].length, 0);

	assert.equal(controller.settle(second, { kind: "ok", entries: [entry("ws-b/1.jsonl")] }), true);
	assert.equal(controller.getState().phase, "entries");
	assert.equal(controller.getState().entries[0].remoteSessionId, "ws-b/1.jsonl");

	// 成功但为空 → empty（与「加载中」「错误」是三件不同的事）。
	const third = controller.start("host-b");
	assert.equal(controller.settle(third, { kind: "ok", entries: [] }), true);
	assert.equal(controller.getState().phase, "empty");
	assert.equal(controller.getState().errorCode, null);

	const fourth = controller.start("host-b");
	assert.equal(controller.settle(fourth, { kind: "failed", code: "REMOTE_SESSION_SCAN_FAILED" }), true);
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, "REMOTE_SESSION_SCAN_FAILED");
	assert.equal([...controller.getState().entries].length, 0);

	const fifth = controller.start("host-b");
	assert.equal(controller.settle(fifth, { kind: "rejected" }), true);
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, null);
});

test("登记响应必须回显同一条远端身份，created=false 是正常结果", () => {
	const created = readRegisterResponse({ ok: true, sessionId: "s-1", created: true, remoteSessionId: "ws-a/1.jsonl", remotePath: "ws-a/1.jsonl" }, "ws-a/1.jsonl");
	assert.equal(created.kind, "ok");
	assert.equal(created.created, true);
	assert.equal(created.sessionId, "s-1");

	const existing = readRegisterResponse({ ok: true, sessionId: "s-1", created: false, remoteSessionId: "ws-a/1.jsonl" }, "ws-a/1.jsonl");
	assert.equal(existing.kind, "ok");
	assert.equal(existing.created, false);

	// 回显别的身份说明这次登记的归属含糊：宁可报读不懂，也不能选中错误的会话。
	assert.equal(readRegisterResponse({ ok: true, sessionId: "s-1", created: true, remoteSessionId: "ws-b/2.jsonl" }, "ws-a/1.jsonl").kind, "rejected");
	assert.equal(readRegisterResponse({ ok: true, sessionId: "", created: true, remoteSessionId: "ws-a/1.jsonl" }, "ws-a/1.jsonl").kind, "rejected");
	assert.equal(readRegisterResponse({ ok: true, sessionId: "s-1", created: "yes", remoteSessionId: "ws-a/1.jsonl" }, "ws-a/1.jsonl").kind, "rejected");
	assert.equal(readRegisterResponse({ ok: false, code: "REMOTE_SESSION_PROJECT_UNRESOLVED" }, "ws-a/1.jsonl").kind, "failed");
});

test("已导入标记只认同主机且带 remoteSessionId 的 ssh locator", () => {
	const sessions = [
		{ id: "s-1", locator: { kind: "ssh", hostId: "host-a", remoteSessionId: "ws-a/1.jsonl" } },
		{ id: "s-2", locator: { kind: "ssh", hostId: "host-b", remoteSessionId: "ws-b/1.jsonl" } },
		{ id: "s-3", locator: { kind: "ssh", hostId: "host-a" } },
		{ id: "s-4", locator: { kind: "local", environment: "windows", filePath: "C:/x.jsonl" } },
		{ id: "s-5" },
	];
	const ids = collectRegisteredRemoteSessionIds(sessions, "host-a");
	assert.deepEqual([...ids], ["ws-a/1.jsonl"]);
});

test("标题响应带 titleOrigin 三档：authoritative 是真名，inferred/fallback 都要标暂定", () => {
	const authoritative = readTitleResponse({ ok: true, title: "Fix the parser", titleOrigin: "authoritative" });
	assert.equal(authoritative.kind, "ok");
	assert.equal(authoritative.title, "Fix the parser");
	assert.equal(authoritative.origin, "authoritative");
	// inferred = 首条消息派生的弱兜底；fallback = 文件名 stem。两者 title 都非空，
	// 界面必须靠 origin（而不是「title 非空」）区分真假，否则会把兜底当解析结果。
	const inferred = readTitleResponse({ ok: true, title: "修复解析器", titleOrigin: "inferred" });
	assert.equal(inferred.kind, "ok");
	assert.equal(inferred.origin, "inferred");
	const fallback = readTitleResponse({ ok: true, title: "1730000000000", titleOrigin: "fallback" });
	assert.equal(fallback.kind, "ok");
	assert.equal(fallback.origin, "fallback");
	// 没有/不认识的 titleOrigin = 读不懂：回退扫描给的 stem 占位，不猜真名。
	assert.equal(readTitleResponse({ ok: true, title: "Fix the parser" }).kind, "rejected");
	assert.equal(readTitleResponse({ ok: true, title: "Fix the parser", titleOrigin: "maybe" }).kind, "rejected");
	// 已废止的旧字面量必须继续被拒绝：契约换档时不能把历史值当合法档位放行。
	assert.equal(readTitleResponse({ ok: true, title: "Fix the parser", titleOrigin: "parsed" }).kind, "rejected");
	assert.equal(readTitleResponse({ ok: true, title: "", titleOrigin: "authoritative" }).kind, "rejected");
	assert.equal(readTitleResponse({ ok: true, title: 42, titleOrigin: "authoritative" }).kind, "rejected");
	assert.equal(readTitleResponse({ ok: false, code: "REMOTE_SESSION_TITLE_UNAVAILABLE" }).kind, "failed");
	assert.equal(readTitleResponse({ ok: false, code: "not a code" }).kind, "rejected");
	assert.equal(readTitleResponse("nope").kind, "rejected");
});

test("「暂定」判据只有一个出处：只有 authoritative 不算暂定", () => {
	// 界面标「暂定」的依据必须与 origin 词表同生命周期，不能在组件里各写一遍。
	assert.equal(isProvisionalTitleOrigin("authoritative"), false);
	assert.equal(isProvisionalTitleOrigin("inferred"), true);
	assert.equal(isProvisionalTitleOrigin("fallback"), true);
	// 还没取到（loading/idle/unavailable/failed）：当然按暂定处理，列表先显示 stem。
	assert.equal(isProvisionalTitleOrigin(null), true);
});

test("标题状态机：按需取一次、旧代次作废、未接线回退占位", () => {
	const controller = createRemoteSessionTitleController();
	const idleEntry = controller.statusOf("ws-a/1.jsonl");
	assert.equal(idleEntry.status, "idle");
	assert.equal(idleEntry.title, null);
	assert.equal(idleEntry.origin, null);
	assert.equal(idleEntry.code, null);

	const first = controller.begin("host-a", "ws-a/1.jsonl");
	assert.equal(controller.statusOf("ws-a/1.jsonl").status, "loading");
	// 已在途/已就绪不重复发起（惰性 = 每条只取一次）。
	assert.equal(controller.begin("host-a", "ws-a/1.jsonl"), null);

	assert.equal(controller.settle(first, "host-a", "ws-a/1.jsonl", { kind: "ok", title: "真实标题", origin: "authoritative" }), true);
	const readyEntry = controller.statusOf("ws-a/1.jsonl");
	assert.equal(readyEntry.status, "ready");
	assert.equal(readyEntry.title, "真实标题");
	assert.equal(readyEntry.origin, "authoritative");
	// 弱兜底档位同样要落地成 ready（界面靠 origin 决定标不标暂定，而不是拒绝它）。
	const weak = controller.begin("host-a", "ws-a/weak.jsonl");
	assert.equal(controller.settle(weak, "host-a", "ws-a/weak.jsonl", { kind: "ok", title: "弱兜底", origin: "inferred" }), true);
	assert.equal(controller.statusOf("ws-a/weak.jsonl").origin, "inferred");
	assert.equal(readyEntry.code, null);
	assert.equal(controller.begin("host-a", "ws-a/1.jsonl"), null, "ready 之后不再请求");

	// 未接线（H1 还没接上）：明确记成 unavailable，界面继续显示 stem 占位而不是错误。
	const second = controller.begin("host-a", "ws-a/2.jsonl");
	assert.equal(controller.settle(second, "host-a", "ws-a/2.jsonl", { kind: "unwired" }), true);
	assert.equal(controller.statusOf("ws-a/2.jsonl").status, "unavailable");
	assert.equal(controller.statusOf("ws-a/2.jsonl").title, null);
	assert.equal(controller.statusOf("ws-a/2.jsonl").origin, null);

	// 切主机：作废在途 + 丢掉上一个主机的标题缓存。
	const third = controller.begin("host-a", "ws-a/3.jsonl");
	controller.reset();
	assert.equal(controller.settle(third, "host-a", "ws-a/3.jsonl", { kind: "ok", title: "迟到", origin: "authoritative" }), false);
	assert.equal(controller.statusOf("ws-a/1.jsonl").status, "idle");
	assert.equal(controller.statusOf("ws-a/3.jsonl").status, "idle");
});

test("rootStatus 响应：ok / needs-attention（带稳定码）/ 不可用 三态分明", () => {
	// 沙箱里返回的对象原型属于另一 realm，逐字段断言而不是 deepEqual。
	const okStatus = readRootStatusResponse({ ok: true, status: "ok" });
	assert.equal(okStatus.status, "ok");
	assert.equal(okStatus.code, null);
	const attention = readRootStatusResponse({ ok: true, status: "needs-attention", code: "REMOTE_PROJECT_ROOT_DRIFTED" });
	assert.equal(attention.status, "needs-attention");
	assert.equal(attention.code, "REMOTE_PROJECT_ROOT_DRIFTED");
	// 缺码也是 needs-attention：提示仍然要给，只是没有具体码。
	const attentionNoCode = readRootStatusResponse({ ok: true, status: "needs-attention" });
	assert.equal(attentionNoCode.status, "needs-attention");
	assert.equal(attentionNoCode.code, null);
	const disabled = readRootStatusResponse({ ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(disabled.status, "unavailable");
	assert.equal(disabled.code, "REMOTE_FEATURE_DISABLED");
	// 读不懂：不显示「需处理」，也不编一个码。
	assert.equal(readRootStatusResponse({ ok: true, status: "weird" }).status, "unavailable");
	assert.equal(readRootStatusResponse(null).status, "unavailable");
	const badCode = readRootStatusResponse({ ok: false, code: "not a code" });
	assert.equal(badCode.status, "unavailable");
	assert.equal(badCode.code, null);
});

/** 远端会话列表 hook 的确定性宿主：不依赖 DOM，IPC 结果可替换，jotai 用最小替身。 */
function remoteSessionsHarness(api) {
	const host = quickMessageHookHost();
	const atoms = {
		remoteSessionScanByHostAtom: { initial: {} },
		remoteSessionTitleByHostAtom: { initial: {} },
		remoteSessionImportByHostAtom: { initial: {} },
		// hook 会用它给「还没扫过的 host」兜一个 idle 状态：与生产同形即可（测试不断言它的内部实现）。
		idleScanStateFor: (hostId) => ({ phase: "idle", hostId, entries: [], errorCode: null, scannedAt: null }),
	};
	const store = new Map(Object.values(atoms).map((token) => [token, token.initial]));
	const write = (token, next) => store.set(token, typeof next === "function" ? next(store.get(token)) : next);
	const jotai = { atom: (initial) => ({ initial }), useAtom: (token) => [store.get(token), (next) => write(token, next)], useSetAtom: (token) => (next) => write(token, next) };
	const calls = { scan: [], register: [] };
	const imported = [];
	let scanResult = { ok: true, entries: [entry("ws-a/1.jsonl")] };
	let registerResult = { ok: true, sessionId: "s-1", created: true, remoteSessionId: "ws-a/1.jsonl", remotePath: "ws-a/1.jsonl" };
	const liveApi = api ?? {
		remoteSessions: {
			scan: async (hostId, projectId) => {
				calls.scan.push({ hostId, projectId });
				if (scanResult instanceof Error) throw scanResult;
				return scanResult;
			},
			register: async (hostId, remoteSessionId) => {
				calls.register.push({ hostId, remoteSessionId });
				if (registerResult instanceof Error) throw registerResult;
				return registerResult;
			},
		},
	};
	const options = { hostId: "host-a", projectId: "project-a", onImported: (result) => imported.push(result) };
	const { useRemoteSessions } = loadTsCommonJs("src/renderer/src/hooks/useRemoteSessions.ts", {
		stubs: { react: host.react, jotai, "../atoms/remote-sessions-atoms": atoms },
	});
	return {
		render: () => host.render(() => useRemoteSessions(liveApi, options)),
		options,
		calls,
		imported,
		store,
		atoms,
		setScanResult: (next) => {
			scanResult = next;
		},
		setRegisterResult: (next) => {
			registerResult = next;
		},
	};
}

test("扫描落地三态：有结果 / 成功但为空 / 失败与 reject 分开", async () => {
	const h = remoteSessionsHarness();
	h.render();
	await h.render().scan();
	assert.equal(h.render().state.phase, "entries");
	assert.equal(h.render().state.entries[0].remoteSessionId, "ws-a/1.jsonl");
	assert.equal(h.calls.scan[0].hostId, "host-a");
	assert.equal(h.calls.scan[0].projectId, "project-a", "扫描必须带项目作用域（同主机两个项目不共享列表）");

	h.setScanResult({ ok: true, entries: [] });
	await h.render().scan();
	assert.equal(h.render().state.phase, "empty");
	assert.equal(h.render().state.errorCode, null);

	h.setScanResult({ ok: false, code: "REMOTE_SESSION_HOME_UNAVAILABLE" });
	await h.render().scan();
	assert.equal(h.render().state.phase, "error");
	assert.equal(h.render().state.errorCode, "REMOTE_SESSION_HOME_UNAVAILABLE");

	// IPC reject 没有码可报：错误态但 errorCode 为 null，界面据此给「请求失败」而不是编个远端码。
	h.setScanResult(new Error("ipc down"));
	await h.render().scan();
	assert.equal(h.render().state.phase, "error");
	assert.equal(h.render().state.errorCode, null);
});

test("切主机后，上一个主机迟到的扫描结果不写入任何状态", async () => {
	const h = remoteSessionsHarness();
	h.render();
	const pending = h.render().scan();
	h.options.hostId = "host-b";
	h.render();
	await pending;
	const snapshots = h.store.get(h.atoms.remoteSessionScanByHostAtom);
	// 迟到结果不得推进状态：离开的主机停在 scanning 快照（并在切主机时归一到 idle），
	// 新主机完全没有被写入——旧结果绝不能算成新主机的列表。
	assert.equal(snapshots["host-a::project-a"].phase, "idle", "旧主机的迟到结果不得落地");
	assert.equal([...snapshots["host-a::project-a"].entries].length, 0);
	assert.equal(snapshots["host-b::project-a"], undefined, "也不得被算成新主机的结果");
});

test("导入：created=true / created=false 都有明确回执，且都通知宿主刷新选中", async () => {
	const h = remoteSessionsHarness();
	h.render();
	await h.render().scan();
	await h.render().importSession(h.render().state.entries[0]);
	assert.equal(h.calls.register.length, 1);
	assert.equal(h.calls.register[0].hostId, "host-a");
	assert.equal(h.calls.register[0].remoteSessionId, "ws-a/1.jsonl");
	const createdFeedback = h.render().feedback;
	assert.equal(createdFeedback.kind, "imported");
	assert.equal(createdFeedback.sessionId, "s-1");
	assert.equal(createdFeedback.created, true);
	assert.equal(h.imported.length, 1);
	assert.equal(h.imported[0].sessionId, "s-1");
	assert.equal(h.imported[0].created, true);
	assert.equal(h.imported[0].remoteSessionId, "ws-a/1.jsonl");
	assert.equal(h.render().importingRemoteSessionId, null);

	// created=false：已在本地存在。仍要显式反馈（不是静默），并照样刷新 + 选中。
	h.setRegisterResult({ ok: true, sessionId: "s-1", created: false, remoteSessionId: "ws-a/1.jsonl" });
	await h.render().importSession(h.render().state.entries[0]);
	const existingFeedback = h.render().feedback;
	assert.equal(existingFeedback.kind, "imported");
	assert.equal(existingFeedback.created, false);
	assert.equal(h.imported.length, 2);
});

test("导入回执必须等待清单刷新和选中完成，失败不能冒充成功", async () => {
	const h = remoteSessionsHarness();
	let releaseRefresh;
	let started;
	const refreshStarted = new Promise((resolve) => {
		started = resolve;
	});
	const refreshDone = new Promise((resolve) => {
		releaseRefresh = resolve;
	});
	h.options.onImported = async () => {
		started();
		await refreshDone;
	};
	h.render();
	const pending = h.render().importSession(entry("ws-a/1.jsonl"));
	await refreshStarted;
	assert.equal(h.render().feedback, null, "刷新尚未完成时不得提前声称已经选中");
	assert.equal(h.render().importingRemoteSessionId, "ws-a/1.jsonl");
	releaseRefresh();
	await pending;
	assert.equal(h.render().feedback.kind, "imported");
	h.options.onImported = async () => {
		throw new Error("private local path must not leak");
	};
	await h.render().importSession(entry("ws-a/1.jsonl"));
	const feedback = h.render().feedback;
	assert.equal(feedback.kind, "refresh-failed", "记录已保存，但刷新失败必须单独报告");
	assert.equal(feedback.sessionId, "s-1");
	assert.equal(h.render().importingRemoteSessionId, null);
	assert.ok(!JSON.stringify(feedback).includes("private local path"));
});

test("导入失败与回显不符都不是静默：失败带稳定码，reject 只报请求失败", async () => {
	const h = remoteSessionsHarness();
	h.render();
	await h.render().scan();
	h.setRegisterResult({ ok: false, code: "REMOTE_SESSION_PROJECT_UNRESOLVED" });
	await h.render().importSession(h.render().state.entries[0]);
	const unresolved = h.render().feedback;
	assert.equal(unresolved.kind, "failed");
	assert.equal(unresolved.code, "REMOTE_SESSION_PROJECT_UNRESOLVED");
	assert.equal(h.imported.length, 0, "失败不得通知选中");
	assert.equal(h.render().importingRemoteSessionId, null);

	h.setRegisterResult(new Error("ipc down"));
	await h.render().importSession(h.render().state.entries[0]);
	const rejected = h.render().feedback;
	assert.equal(rejected.kind, "failed");
	assert.equal(rejected.code, null);

	// 回显的远端身份不是这次请求：宁可报读不懂，也不能选中错误的会话。
	h.setRegisterResult({ ok: true, sessionId: "s-9", created: true, remoteSessionId: "ws-z/9.jsonl" });
	await h.render().importSession(h.render().state.entries[0]);
	const mismatched = h.render().feedback;
	assert.equal(mismatched.kind, "failed");
	assert.equal(mismatched.code, null);
	assert.equal(h.imported.length, 0);
});

test("preload 未接线 remoteSessions 时给「未接线」稳定码，不崩溃也不假装成功", async () => {
	const h = remoteSessionsHarness({});
	h.render();
	await h.render().scan();
	assert.equal(h.render().state.phase, "error");
	assert.equal(h.render().state.errorCode, "REMOTE_SESSION_UNWIRED");
	await h.render().importSession(entry("ws-a/1.jsonl"));
	const unwired = h.render().feedback;
	assert.equal(unwired.kind, "failed");
	assert.equal(unwired.code, "REMOTE_SESSION_UNWIRED");
});

function remoteProject(id, hostId) {
	return { id, name: id, lastOpenedAt: 1, locator: { kind: "ssh", hostId, remotePath: "/srv/" + id } };
}
function localProject(id) {
	return { id, name: id, lastOpenedAt: 1, path: "C:/work/" + id };
}

/** 项目 rootStatus 提示的宿主：每个项目的查询都挂起，由测试决定落地顺序。 */
function rootStatusHarness() {
	const host = quickMessageHookHost();
	const atoms = { remoteProjectRootStatusAtom: { initial: {} } };
	const store = new Map(Object.values(atoms).map((token) => [token, token.initial]));
	const write = (token, next) => store.set(token, typeof next === "function" ? next(store.get(token)) : next);
	const jotai = { atom: (initial) => ({ initial }), useAtom: (token) => [store.get(token), (next) => write(token, next)], useSetAtom: (token) => (next) => write(token, next) };
	const calls = [];
	const pending = new Map();
	const api = {
		remoteHosts: {
			rootStatus: (projectId) => {
				calls.push(projectId);
				return new Promise((resolve) => pending.set(projectId, resolve));
			},
		},
	};
	let projects = [remoteProject("p1", "host-a"), localProject("p2")];
	const { useRemoteProjectRootStatuses } = loadTsCommonJs("src/renderer/src/components/sidebar/useRemoteProjectRootStatuses.ts", {
		stubs: { react: host.react, jotai, "../../atoms/remote-sessions-atoms": atoms },
	});
	return {
		render: () => host.render(() => useRemoteProjectRootStatuses(api, projects)),
		unmount: () => host.unmount(),
		setProjects: (next) => {
			projects = next;
		},
		calls,
		resolve: (projectId, value) => {
			const resolve = pending.get(projectId);
			pending.delete(projectId);
			resolve?.(value);
		},
		statuses: () => store.get(atoms.remoteProjectRootStatusAtom),
	};
}

test("rootStatus：只查远端项目，needs-attention 带码呈现，ok 不打扰", async () => {
	const h = rootStatusHarness();
	h.render();
	assert.deepEqual([...h.calls], ["p1"], "本地项目不该发 rootStatus 查询");
	h.resolve("p1", { ok: true, status: "needs-attention", code: "REMOTE_PROJECT_ROOT_DRIFTED" });
	await new Promise((resolve) => setImmediate(resolve));
	const attention = h.statuses().p1;
	assert.equal(attention.status, "needs-attention");
	assert.equal(attention.code, "REMOTE_PROJECT_ROOT_DRIFTED");

	const ok = rootStatusHarness();
	ok.render();
	ok.resolve("p1", { ok: true, status: "ok" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ok.statuses().p1.status, "ok");
});

test("rootStatus：项目清单刷新后，旧批次的迟到结果不得覆盖", async () => {
	const h = rootStatusHarness();
	h.render();
	// 刷新 = 新的项目清单身份 → 旧批次作废（同一主机也不复用旧结果）。
	h.setProjects([remoteProject("p3", "host-a"), localProject("p2")]);
	h.render();
	h.resolve("p1", { ok: true, status: "needs-attention", code: "REMOTE_PROJECT_ROOT_DRIFTED" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.statuses().p1, undefined, "旧批次结果必须被丢弃");
	h.resolve("p3", { ok: true, status: "needs-attention", code: "REMOTE_PROJECT_ROOT_DRIFTED" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(Object.keys(h.statuses()), ["p3"]);

	// 卸载后到达的结果同样不落地：先发起新一批（p4），再在结果到达前卸载。
	h.setProjects([remoteProject("p4", "host-a")]);
	h.render();
	h.resolve("p4", { ok: true, status: "ok" });
	h.unmount();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.statuses().p4, undefined, "卸载后的迟到结果不得落地");
	assert.equal(h.statuses().p3.status, "needs-attention");
});

test("rootStatus：读不懂或不可用时按「不可用」记，不显示需处理", async () => {
	const h = rootStatusHarness();
	h.render();
	h.resolve("p1", { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	await new Promise((resolve) => setImmediate(resolve));
	const unavailable = h.statuses().p1;
	assert.equal(unavailable.status, "unavailable");
	assert.equal(unavailable.code, "REMOTE_FEATURE_DISABLED");
});

/** 取标题 hook 的宿主：标题请求挂起，由测试决定落地顺序。 */
function titlesHarness(initialTitles) {
	const host = quickMessageHookHost();
	const atoms = { remoteSessionTitleByHostAtom: { initial: initialTitles } };
	const store = new Map(Object.values(atoms).map((token) => [token, token.initial]));
	const write = (token, next) => store.set(token, typeof next === "function" ? next(store.get(token)) : next);
	const jotai = { atom: (initial) => ({ initial }), useAtom: (token) => [store.get(token), (next) => write(token, next)] };
	const calls = [];
	const pending = new Map();
	const api = {
		remoteSessions: {
			title: (hostId, remoteSessionId) => {
				calls.push(hostId + "|" + remoteSessionId);
				return new Promise((resolve) => pending.set(remoteSessionId, resolve));
			},
		},
	};
	let hostId = "host-a";
	const { useRemoteSessionTitles } = loadTsCommonJs("src/renderer/src/hooks/useRemoteSessionTitles.ts", {
		stubs: { react: host.react, jotai, "../atoms/remote-sessions-atoms": atoms },
	});
	return {
		render: () => host.render(() => useRemoteSessionTitles(api, hostId)),
		setHostId: (next) => {
			hostId = next;
		},
		calls,
		resolve: (remoteSessionId, value) => {
			const resolve = pending.get(remoteSessionId);
			pending.delete(remoteSessionId);
			resolve?.(value);
		},
		titles: () => store.get(atoms.remoteSessionTitleByHostAtom),
	};
}

test("标题 hook：首帧按需请求不丢、ready 命中缓存不重取、切主机丢弃迟到结果", async () => {
	const cached = { status: "ready", title: "缓存标题", origin: "authoritative", code: null };
	const h = titlesHarness({ "host-a": { "ws-a/old.jsonl": cached } });
	h.render();
	// 第一帧就发请求：hostId 在首次渲染前已就位，不依赖父级 effect（子行 effect 先于父级运行）。
	h.render().request("ws-a/1.jsonl");
	assert.deepEqual([...h.calls], ["host-a|ws-a/1.jsonl"]);
	// 已 ready 的缓存不再请求。
	h.render().request("ws-a/old.jsonl");
	assert.equal(h.calls.length, 1);
	assert.equal(h.render().statusOf("ws-a/old.jsonl").title, "缓存标题");

	h.resolve("ws-a/1.jsonl", { ok: true, title: "真实标题", titleOrigin: "authoritative" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.titles()["host-a"]["ws-a/1.jsonl"].title, "真实标题");

	// 切主机：旧主机在途的标题结果必须丢弃（不能落到新主机的同名会话上）。
	h.render().request("ws-a/2.jsonl");
	h.setHostId("host-b");
	h.render();
	h.resolve("ws-a/2.jsonl", { ok: true, title: "迟到", titleOrigin: "authoritative" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.render().statusOf("ws-a/2.jsonl").status, "idle");
});
test("K2-3 界面：降级标记与暂定标记是两个独立判据，i18n 两份都有 key", () => {
	const section = readFileSync("src/renderer/src/components/sidebar/RemoteSessionsSection.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	// i18n 两份都必须有这两个 key（标记 + tooltip），缺一份就是「另一语言静默」。
	const valueOf = (source, key) => source.match(new RegExp('\\"' + key.replace(/\./g, "\\.") + '\\":\\s*\\"([^\\"]*)\\"'))?.[1];
	for (const [name, source] of [
		["zh-CN", zh],
		["en-US", en],
	]) {
		for (const key of ["sidebar.remoteSessions.tailDegraded", "sidebar.remoteSessions.tailDegradedHint"]) {
			const value = valueOf(source, key);
			assert.ok(typeof value === "string" && value.length > 0, name + " must define " + key);
		}
		// 与「暂定」区分：两个判据的文案不得是同一句（合并成一个词就会红）。
		assert.notEqual(valueOf(source, "sidebar.remoteSessions.tailDegraded"), valueOf(source, "sidebar.remoteSessions.tentative"), name + " degraded marker must differ from tentative");
		assert.notEqual(valueOf(source, "sidebar.remoteSessions.tailDegradedHint"), valueOf(source, "sidebar.remoteSessions.tentativeHint"), name + " degraded hint must differ from the tentative hint");
	}
	// 判据来自状态模块的唯一出处，而不是组件里再写一遍 origin 词表。
	assert.match(section, /const tailDegraded = isTitleTailDegraded\(title\);/, "the degraded marker must use the shared predicate");
	// 只有 tailDegraded 为真才渲染（三元 + : null ⇒ false/缺省什么都不渲染）。
	// 行首锚定：`title={tailDegraded ? …}` 也含同一片段，不锚定会错抓到暂定分支。
	const degradedBranch = section.match(/\n[\t ]*\{tailDegraded \?[\s\S]{0,400}?\) : null\}/);
	assert.ok(degradedBranch, "the degraded marker must be guarded by its own ternary");
	assert.match(degradedBranch[0], /sidebar\.remoteSessions\.tailDegraded\"/, "the guarded branch must render the degraded marker");
	assert.doesNotMatch(degradedBranch[0], /sidebar\.remoteSessions\.tentative/, "the degraded branch must not reuse the tentative copy");
	assert.match(section, /title=\{tailDegraded \? t\("sidebar\.remoteSessions\.tailDegradedHint"\)/, "the tooltip must explain the degraded state");
	// 反例（合并就红）：暂定分支仍然是 origin 驱动的那个三元，且不得渲染降级文案。
	const tentativeBranch = section.match(/\n[\t ]*\{tentative \?[\s\S]{0,400}?\) : null\}/);
	assert.ok(tentativeBranch, "the tentative marker must keep its own branch");
	assert.doesNotMatch(tentativeBranch[0], /sidebar\.remoteSessions\.tailDegraded/, "the tentative branch must not render the degraded copy");
});
