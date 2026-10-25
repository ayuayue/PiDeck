import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveChatSessionBootstrap } = loadTsCommonJs("src/renderer/src/utils/chatSessionBootstrap.ts");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

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
	assert.match(appSource, /action\.kind === "load"[\s\S]*refreshProjectSessions\(activeProject\.id\)/);
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
