/**
 * DSH 会话技能目录加载器：文件系统预览 + host 权威结果并集。
 *
 * 关键保证（用户要求「能搜到、不会少」）：
 * 1. 草稿首次读取懒建 host 会话 → host 的 preset/插件技能全在，并回写 catalog；
 * 2. host 拿不到（未 attach/registry 缺失）时退回文件系统扫描，不把面板打成错误态；
 * 3. 历史会话永不换新 host id；已 attach 的可以直接列，未 attach 用扫描兜底。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const { createDshSessionSkillLoader, isUnattachedDshSessionError, DshSessionSkillsUnavailableError } = loadTsCommonJs("src/main/dsh/dshSessionSkillLoader.ts");

const DRAFT_ENTRY = { backend: "dsh", status: "draft", projectId: "project-1", agentPreset: "coding" };
const HOST_SKILLS = [
	{ name: "alpha", description: "host alpha" },
	{ name: "host-only", description: "from host/preset plugin" },
];
const SCANNED_SKILLS = [
	{ name: "alpha", description: "filesystem alpha" },
	{ name: "scanned-only", description: "from filesystem" },
];

/** loader 依赖与调用记录；overrides 用于替换单个依赖。 */
function makeHarness(overrides = {}) {
	const calls = { scan: [], ensure: [], attach: [], dismiss: [], list: [] };
	const deps = {
		getEntry: (sessionId) => (sessionId === "deck-1" ? { ...DRAFT_ENTRY } : undefined),
		getProjectPath: (projectId) => (projectId === "project-1" ? "D:/projects/demo" : undefined),
		scanFilesystem: async (entry) => {
			calls.scan.push(entry);
			return [...SCANNED_SKILLS];
		},
		ensureHostSession: async (cwd, agentPreset) => {
			calls.ensure.push([cwd, agentPreset]);
			return { sessionId: "host-new" };
		},
		attachHostSession: async (deckSessionId, dshSessionId, agentPreset) => {
			calls.attach.push(agentPreset === undefined ? [deckSessionId, dshSessionId] : [deckSessionId, dshSessionId, agentPreset]);
		},
		dismissHostSession: async (dshSessionId) => {
			calls.dismiss.push(dshSessionId);
		},
		listSkills: async (dshSessionId) => {
			calls.list.push(dshSessionId);
			return [...HOST_SKILLS];
		},
		...overrides,
	};
	return { load: createDshSessionSkillLoader(deps), calls };
}

function unavailable(code) {
	return (error) => error instanceof DshSessionSkillsUnavailableError && error.code === code;
}

function sessionNotFound() {
	const error = new Error("session not attached");
	error.code = "session-not-found";
	return error;
}

test("草稿无 host 会话：懒建并回写后，host 结果在前、扫描结果只补缺（不会少）", async () => {
	const { load, calls } = makeHarness();
	const skills = await load("deck-1");
	assert.deepEqual(calls.ensure, [["D:/projects/demo", "coding"]]);
	assert.deepEqual(calls.attach, [["deck-1", "host-new"]]);
	assert.deepEqual(calls.attach, [["deck-1", "host-new"]]);
	assert.deepEqual(calls.scan.length, 1);
	// host 顺序优先：同名 alpha 用 host 版本，扫描的 scanned-only 补在后面。
	assert.deepEqual(plain(skills.map((skill) => [skill.name, skill.description])), [
		["alpha", "host alpha"],
		["host-only", "from host/preset plugin"],
		["scanned-only", "from filesystem"],
	]);
});

test("草稿已有 attached 的 host 会话：直接复用，不新建不覆盖 catalog", async () => {
	const { load, calls } = makeHarness({ getEntry: () => ({ ...DRAFT_ENTRY, dshSessionId: "host-old" }) });
	const skills = await load("deck-1");
	assert.deepEqual(calls.ensure, []);
	assert.deepEqual(calls.attach, []);
	assert.deepEqual(calls.list, ["host-old"]);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "host-only", "scanned-only"]);
});

test("host 重启后旧会话 session-not-found：草稿换新会话并给旧 id 记墓碑", async () => {
	const { load, calls } = makeHarness({
		getEntry: () => ({ ...DRAFT_ENTRY, dshSessionId: "host-stale" }),
		listSkills: async (dshSessionId) => {
			if (dshSessionId === "host-stale") throw sessionNotFound();
			calls.list.push(dshSessionId);
			return [...HOST_SKILLS];
		},
	});
	const skills = await load("deck-1");
	assert.deepEqual(calls.ensure, [["D:/projects/demo", "coding"]]);
	assert.deepEqual(calls.attach, [["deck-1", "host-new"]]);
	assert.deepEqual(calls.dismiss, ["host-stale"]);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "host-only", "scanned-only"]);
});

test("host 其它错误但扫描有结果：退回扫描结果，不抛错", async () => {
	const { load, calls } = makeHarness({
		listSkills: async () => {
			const error = new Error("skill registry is absent");
			error.code = "internal";
			throw error;
		},
	});
	const skills = await load("deck-1");
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "scanned-only"]);
	// 草稿没有 dshSessionId 时会先 ensure，再 list 抛错 → 兜底扫描，不 attach 未验证的会话
	assert.deepEqual(calls.attach, [["deck-1", "host-new"]]);
});

test("host 错误且扫描为空：上抛真实错误（不误报「需要启动」）", async () => {
	const { load } = makeHarness({
		scanFilesystem: async () => [],
		listSkills: async () => {
			const error = new Error("skill registry is absent");
			error.code = "internal";
			throw error;
		},
	});
	await assert.rejects(load("deck-1"), /skill registry is absent/);
});

test("已激活且 host 已 attach：可直接列，和扫描结果并集", async () => {
	const { load, calls } = makeHarness({ getEntry: () => ({ ...DRAFT_ENTRY, status: "active", dshSessionId: "host-history" }) });
	const skills = await load("deck-1");
	assert.deepEqual(calls.ensure, []);
	assert.deepEqual(calls.list, ["host-history"]);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "host-only", "scanned-only"]);
});

test("已激活但 host 未 attach（session-not-found）：返回扫描结果，绝不换新 host id", async () => {
	const { load, calls } = makeHarness({
		getEntry: () => ({ ...DRAFT_ENTRY, status: "active", dshSessionId: "host-history" }),
		listSkills: async () => {
			throw sessionNotFound();
		},
	});
	const skills = await load("deck-1");
	assert.deepEqual(calls.ensure, []);
	assert.deepEqual(calls.dismiss, []);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "scanned-only"]);
});

test("已激活但没有 host 会话 id（异常残留条目）：直接返回扫描结果", async () => {
	const { load, calls } = makeHarness({ getEntry: () => ({ ...DRAFT_ENTRY, status: "active" }) });
	const skills = await load("deck-1");
	assert.deepEqual(calls.list, []);
	assert.deepEqual(calls.ensure, []);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["alpha", "scanned-only"]);
});

test("host 修正草稿预选的 preset：catalog 回写 host 实际组合", async () => {
	const { load, calls } = makeHarness({ ensureHostSession: async () => ({ sessionId: "host-new", agentPreset: "default" }) });
	await load("deck-1");
	assert.deepEqual(calls.attach, [["deck-1", "host-new", "default"]]);
});

test("非 DSH / 匿名 / 缺项目路径：返回对应不可用错误且不扫描", async () => {
	const pi = makeHarness({ getEntry: () => ({ backend: "pi", status: "draft", projectId: "project-1" }) });
	await assert.rejects(pi.load("deck-1"), unavailable("not-dsh-session"));
	const missing = makeHarness({ getEntry: () => undefined });
	await assert.rejects(missing.load("unknown"), unavailable("not-dsh-session"));
	const anonymous = makeHarness({ getEntry: () => ({ ...DRAFT_ENTRY, noSession: true }) });
	await assert.rejects(anonymous.load("deck-1"), unavailable("anonymous-session"));
	const noProject = makeHarness({ getProjectPath: () => undefined });
	await assert.rejects(noProject.load("deck-1"), unavailable("project-missing"));
	assert.deepEqual(pi.calls.scan, []);
	assert.deepEqual(anonymous.calls.scan, []);
	assert.deepEqual(noProject.calls.scan, []);
});

test("isUnattachedDshSessionError 只认 host 的 session-not-found", () => {
	assert.equal(isUnattachedDshSessionError(sessionNotFound()), true);
	assert.equal(isUnattachedDshSessionError({ code: "internal" }), false);
	assert.equal(isUnattachedDshSessionError(new Error("session not attached")), false);
	assert.equal(isUnattachedDshSessionError(null), false);
});

const PROJECT_SOURCE = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const SESSION_IPC_SOURCE = readFileSync(new URL("../src/main/ipc/sessionIpc.ts", import.meta.url), "utf8");
const PRELOAD_SOURCE = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");
const PICKER_SOURCE = readFileSync(new URL("../src/renderer/src/components/session/ComposerSkillPicker.tsx", import.meta.url), "utf8");
const PICKER_HOST_SOURCE = readFileSync(new URL("../src/renderer/src/components/session/ComposerPickerHost.tsx", import.meta.url), "utf8");
const MANAGER_SOURCE = readFileSync(new URL("../src/main/dsh/DshAgentManager.ts", import.meta.url), "utf8");

test("接线契约：IPC 目标支持 agentId 字符串与 { sessionId }，主进程装配扫描 + loader", () => {
	assert.match(SESSION_IPC_SOURCE, /ipcMain\.handle\(\s*ipcChannels\.dshListSkills[\s\S]*?isRecord\(\s*target\s*\)[\s\S]*?target\.sessionId/);
	assert.match(SESSION_IPC_SOURCE, /listDshSessionSkills\?:\s*\(\s*deckSessionId:\s*string\s*\)/);
	assert.match(PRELOAD_SOURCE, /listDshSkills:\s*\(\s*target:\s*string\s*\|\s*\{\s*sessionId:\s*string\s*\}\s*\)/);
	assert.match(PROJECT_SOURCE, /createDshSessionSkillLoader\s*\(/);
	assert.match(PROJECT_SOURCE, /scanFilesystem:\s*async\s*\(\s*entry\s*\)/);
	assert.match(PROJECT_SOURCE, /listDshFilesystemSkills\(/);
	assert.match(PROJECT_SOURCE, /listDshSessionSkills:\s*\(\s*sessionId\s*\)\s*=>\s*getDshSessionSkillLoader\(\)\(\s*sessionId\s*\)/);
	assert.match(MANAGER_SOURCE, /async ensureAttachableHostSession\(/);
	assert.match(MANAGER_SOURCE, /async listSkillsByHostSession\(/);
});

test("接线契约：技能选择器无 runtime 时走会话级目录，引导页虚拟会话仍显示原提示", () => {
	assert.match(PICKER_SOURCE, /const dshCatalogSessionId = props\.backend === "dsh"\s*&&\s*!props\.agentId\s*&&\s*props\.sessionId\s*&&\s*!props\.sessionId\.startsWith\("renderer:"\)/);
	assert.match(PICKER_SOURCE, /const blockedByAgent = props\.backend === "dsh"\s*&&\s*!props\.agentId\s*&&\s*!dshCatalogSessionId/);
	assert.match(PICKER_SOURCE, /listDshSkills\(target\)/);
	assert.doesNotMatch(PICKER_SOURCE, /sessionStatus/);
	assert.match(PICKER_HOST_SOURCE, /sessionId=\{props\.sessionId\}/);
	assert.doesNotMatch(PICKER_HOST_SOURCE, /sessionStatus=/);
});
