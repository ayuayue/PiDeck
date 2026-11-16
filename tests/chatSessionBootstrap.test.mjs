import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

const { resolveChatSessionBootstrap, resolveNewSessionTarget } = loadTsCommonJs("src/renderer/src/utils/chatSessionBootstrap.ts");
const appSource = rendererAppSource;

function resolve(input) {
	// The TypeScript loader executes modules in a VM realm, so normalize the
	// returned record before comparing it with Node's assertion realm.
	return JSON.parse(JSON.stringify(resolveChatSessionBootstrap(input)));
}

test("Chat bootstrap loads a collapsed catalog, then shows the unified guide page", () => {
	assert.deepEqual(
		resolve({
			isChatProject: true,
			catalogStatus: "idle",
		}),
		{ kind: "load" },
	);
	assert.deepEqual(
		resolve({
			isChatProject: true,
			catalogStatus: "error",
		}),
		{ kind: "load" },
	);
	assert.deepEqual(
		resolve({
			isChatProject: true,
			catalogStatus: "loading",
		}),
		{ kind: "wait" },
	);
	assert.deepEqual(
		resolve({
			isChatProject: true,
			catalogStatus: "ready",
		}),
		{ kind: "none" },
	);
});

function resolveTarget(input) {
	return JSON.parse(JSON.stringify(resolveNewSessionTarget(input)));
}

test("新建会话后端：没选/与默认相同 → 默认；本次选了别的且可用 → 所选", () => {
	const base = { defaultBackend: "pi", dshAvailable: true, acpEnabled: true, acpTools: [] };
	assert.deepEqual(resolveTarget(base), { backend: "pi" });
	assert.deepEqual(resolveTarget({ ...base, requested: "pi" }), { backend: "pi" });
	assert.deepEqual(resolveTarget({ ...base, requested: "dsh" }), { backend: "dsh" });
	assert.deepEqual(resolveTarget({ ...base, defaultBackend: "dsh", requested: "dsh" }), { backend: "dsh" });
	assert.deepEqual(resolveTarget({ ...base, requested: "pi", defaultBackend: "dsh" }), { backend: "pi" });
});

test("新建会话后端：所选 DSH 不可用则回落默认", () => {
	assert.deepEqual(resolveTarget({ defaultBackend: "pi", requested: "dsh", dshAvailable: false, acpEnabled: false, acpTools: [] }), { backend: "pi" });
});

test("新建会话后端：所选 ACP 沿用工具，工具失效退第一个可用；关闭/空表回落默认", () => {
	const base = { defaultBackend: "pi", requested: "acp", requestedAcpToolId: "cb", dshAvailable: false, acpEnabled: true };
	assert.deepEqual(resolveTarget({ ...base, acpTools: [{ id: "cb" }, { id: "gem" }] }), { backend: "acp", acpToolId: "cb" });
	// 所选工具被删/禁用：退到第一个可用工具
	assert.deepEqual(resolveTarget({ ...base, requestedAcpToolId: "gone", acpTools: [{ id: "cb" }, { id: "gem", enabled: false }] }), { backend: "acp", acpToolId: "cb" });
	// ACP 关闭 / 没有可用工具：不能建出无法激活的草稿
	assert.deepEqual(resolveTarget({ ...base, acpEnabled: false, acpTools: [{ id: "cb" }] }), { backend: "pi" });
	assert.deepEqual(resolveTarget({ ...base, acpTools: [] }), { backend: "pi" });
	assert.deepEqual(resolveTarget({ ...base, acpTools: [{ id: "cb", enabled: false }] }), { backend: "pi" });
});

test("新建会话后端：生图/生视频等模式不参与后端解析", () => {
	const base = { defaultBackend: "pi", dshAvailable: true, acpEnabled: true, acpTools: [{ id: "cb" }] };
	assert.deepEqual(resolveTarget({ ...base, requested: "imagegen" }), { backend: "pi" });
	assert.deepEqual(resolveTarget({ ...base, requested: "videogen" }), { backend: "pi" });
});

test("Chat bootstrap never replaces an existing selection or non-Chat project", () => {
	assert.deepEqual(
		resolve({
			isChatProject: true,
			currentSessionId: "selected",
			catalogStatus: "ready",
		}),
		{ kind: "none" },
	);
	assert.deepEqual(
		resolve({
			isChatProject: false,
			catalogStatus: "ready",
		}),
		{ kind: "none" },
	);
});

test("Chat bootstrap loads its catalog before showing the unified guide page", () => {
	// refreshProjectSessions 由 useProjectSync 以普通函数返回、每次渲染换引用，现经 refreshProjectSessionsRef
	// 稳定化后再调（同语义，不改变副作用）。
	assert.match(appSource, /action\.kind === "load"[\s\S]*refreshProjectSessions(?:Ref\.current)?\(activeProject\.id\)/);
	assert.doesNotMatch(appSource, /selectSessionCommand\(activeProject\.id, action\.sessionId, false\)/);
});

test("引导页虚拟会话 id 永不写进 currentSessionId（没有 catalog 记录，会被挂成空态面板）", () => {
	// GUIDE_BOOTSTRAP_SESSION_ID 只是引导页输入框的虚拟会话 key，不是真实会话：App 用
	// `currentSessionId ? <ChatSessionPane/> : <ProjectEmptyState/>` 二选一，写进去会让真实
	// 面板挂到一个 catalog 查不到的会话上（面板内 session=undefined → 渲染「开始新的 Session」
	// 空态，输入框消失、回填的草稿也看不见）。用户 2026‑10 反馈「acp 首启失败后跳到了这个
	// 页面」就是 prunedFailedAcpDraft 里那一行写的；「没有当前会话」只能写 undefined。
	const offenders = readdirSync("src/renderer/src", { recursive: true })
		.filter((entry) => typeof entry === "string" && /\.tsx?$/.test(entry))
		.filter((entry) => /set\(\s*currentSessionIdAtom\s*,\s*GUIDE_BOOTSTRAP_SESSION_ID\s*\)/.test(readFileSync(path.join("src/renderer/src", entry), "utf8")));
	assert.deepEqual(offenders, []);
});
