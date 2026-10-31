import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveProjectServiceCapabilities, LOCAL_PROJECT_SERVICE_METHODS, REMOTE_PROJECT_SERVICE_METHODS, PROJECT_SERVICE_CAPABILITY_REASONS } = loadTsCommonJs("src/renderer/src/services/projectServiceCapabilities.ts");
const { PROJECT_CAPABILITY_REASONS } = loadTsCommonJs("src/shared/projectCapabilities.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const FULL_HELPER = [
	"fs.watch",
	"fs.searchNames",
	"fs.searchContent",
	"git.status",
	"git.workspaceDiff",
	"git.log",
	"git.repos",
	"git.refs",
	"git.compare",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.createBranch",
	"git.switchBranch",
	"git.fetch",
	"git.push",
	"git.pull",
	"git.syncFacts",
	"git.init",
	"git.recoveryList",
	"git.recoveryRestore",
	"git.recoveryDrop",
];

function localFacts(overrides = {}) {
	return { projectId: "p1", locationKind: "local", hostState: "local", environment: "windows", rootStatus: "ok", trust: "none", generation: "local", ...overrides };
}

function remoteFacts(overrides = {}) {
	return { projectId: "p2", locationKind: "ssh", hostId: "h1", hostState: "ready", rootStatus: "ok", helperCapabilities: FULL_HELPER, trust: "approved", generation: "g1", ...overrides };
}

function resolve(facts, methods) {
	return resolveProjectServiceCapabilities(facts, methods);
}

test("本机项目：读写/Git 全开，但回收站、恢复与同步事实不假装存在", () => {
	const capabilities = resolve(localFacts(), LOCAL_PROJECT_SERVICE_METHODS);
	assert.deepEqual(plain(capabilities.files), { read: true, search: true, write: true, trash: false, textVersion: "none", contentSearch: true, systemOpen: true, watch: "full" });
	assert.deepEqual(plain(capabilities.git), {
		read: true,
		diff: true,
		branchRead: true,
		history: true,
		repos: true,
		refs: true,
		write: true,
		branchWrite: true,
		branchCreateMode: "create-and-checkout",
		sync: true,
		syncFacts: false,
		aheadBehind: true,
		compare: true,
		recovery: false,
		worktree: true,
		init: true,
		forceRefresh: true,
		autoFetch: true,
		statusPoll: true,
		refsWatch: true,
		deleteFiles: true,
	});
	assert.equal(capabilities.blocked["files.trash"], PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
	assert.equal(capabilities.blocked["git.recovery"], PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
	assert.equal(capabilities.blocked["git.syncFacts"], PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
});

test("远端 ready + trust approved + 完整 helper：文件写可用，Git 读可用，Git 写/强刷在 G 接手前不可用", () => {
	const capabilities = resolve(remoteFacts(), REMOTE_PROJECT_SERVICE_METHODS);
	assert.deepEqual(plain(capabilities.files), { read: true, search: true, write: true, trash: true, textVersion: "required", contentSearch: true, systemOpen: false, watch: "full" });
	assert.equal(capabilities.git.read, true);
	assert.equal(capabilities.git.compare, true);
	assert.equal(capabilities.git.diff, true);
	assert.equal(capabilities.git.history, true);
	assert.equal(capabilities.git.repos, true);
	assert.equal(capabilities.git.refs, true);
	for (const key of ["branchRead", "write", "branchWrite", "sync", "syncFacts", "aheadBehind", "recovery", "worktree", "init", "forceRefresh", "autoFetch", "statusPoll", "refsWatch", "deleteFiles"]) {
		assert.equal(capabilities.git[key], false, key);
	}
	assert.equal(capabilities.git.branchCreateMode, "none");
	assert.equal(capabilities.blocked["git.write"], PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
	assert.equal(capabilities.blocked["git.forceRefresh"], PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
});

test("方法支持是能力的一层：G 实现远端写/强刷后，同一份 ready 事实立即改判", () => {
	const implemented = { ...REMOTE_PROJECT_SERVICE_METHODS, gitWrite: true, gitBranchWrite: true, gitBranchCreateMode: "create", gitSync: true, gitSyncFacts: true, gitRecovery: true, gitForceRefresh: true, gitDiff: true, gitBranches: true, gitAheadBehind: true, gitInit: true, gitDeleteFiles: true };
	const capabilities = resolve(remoteFacts(), implemented);
	assert.equal(capabilities.git.write, true);
	assert.equal(capabilities.git.branchWrite, true);
	assert.equal(capabilities.git.branchCreateMode, "create");
	assert.equal(capabilities.git.sync, true);
	assert.equal(capabilities.git.forceRefresh, true);
	assert.equal(capabilities.blocked["git.write"], undefined);
});

test("远端 trust 只门禁 Git（main 的 Git 服务现读 trust），不替文件 API 发明策略", () => {
	for (const [trust, reason] of [
		["denied", PROJECT_SERVICE_CAPABILITY_REASONS.trustRequired],
		["none", PROJECT_SERVICE_CAPABILITY_REASONS.trustRequired],
		["stale", PROJECT_SERVICE_CAPABILITY_REASONS.trustStale],
		["unknown", PROJECT_SERVICE_CAPABILITY_REASONS.trustUnknown],
	]) {
		const capabilities = resolve(remoteFacts({ trust }), REMOTE_PROJECT_SERVICE_METHODS);
		assert.equal(capabilities.trust, trust);
		assert.equal(capabilities.files.read, true, trust);
		assert.equal(capabilities.files.write, true, trust);
		assert.equal(capabilities.git.read, false, trust);
		assert.equal(capabilities.blocked["git.read"], reason, trust);
		assert.equal(capabilities.blocked["files.write"], undefined, trust);
	}
});

test("降级主机：读留下、写关掉；文件与 Git 写同样关闭并给出既有原因", () => {
	const capabilities = resolve(remoteFacts({ hostState: "degraded" }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(capabilities.files.read, true);
	assert.equal(capabilities.files.write, false);
	assert.equal(capabilities.blocked["files.write"], PROJECT_CAPABILITY_REASONS.hostDegraded);
	assert.equal(capabilities.git.read, true);
	assert.equal(capabilities.git.write, false);
});

test("断线/未就绪：能力全关，且不把主机 ready 当成所有动作可用", () => {
	for (const hostState of ["disconnected", "connecting", "probing", "bootstrapping", "reconnecting", "offline", "needs-attention"]) {
		const capabilities = resolve(remoteFacts({ hostState, helperCapabilities: [] }), REMOTE_PROJECT_SERVICE_METHODS);
		assert.equal(capabilities.files.read, false, hostState);
		assert.equal(capabilities.files.write, false, hostState);
		assert.equal(capabilities.files.watch, "none", hostState);
		assert.equal(capabilities.git.read, false, hostState);
		assert.equal(capabilities.blocked["files.read"], PROJECT_CAPABILITY_REASONS.hostNotReady, hostState);
	}
});

test("root needs-attention：项目读面关闭并给出项目级原因；unknown 不阻断（main 仍逐次校验）", () => {
	const blocked = resolve(remoteFacts({ rootStatus: "needs-attention" }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(blocked.files.read, false);
	assert.equal(blocked.files.write, false);
	assert.equal(blocked.blocked["files.read"], PROJECT_SERVICE_CAPABILITY_REASONS.rootNeedsAttention);
	assert.equal(blocked.blocked["files.watch"], PROJECT_SERVICE_CAPABILITY_REASONS.rootNeedsAttention);
	assert.equal(blocked.git.read, false);
	const unknown = resolve(remoteFacts({ rootStatus: "unknown" }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(unknown.files.read, true);
	assert.equal(unknown.files.write, true);
});

test("helper 实际方法缺席：watch 降级、内容搜索关闭、Git 读关闭，而不是靠试一次失败", () => {
	const noWatch = resolve(remoteFacts({ helperCapabilities: FULL_HELPER.filter((method) => method !== "fs.watch") }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(noWatch.files.watch, "degraded");
	assert.equal(noWatch.files.read, true);
	assert.equal(noWatch.blocked["files.watch"], PROJECT_CAPABILITY_REASONS.helperNoWatch);
	const noSearch = resolve(remoteFacts({ helperCapabilities: FULL_HELPER.filter((method) => method !== "fs.searchContent") }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(noSearch.files.contentSearch, false);
	assert.equal(noSearch.blocked["files.contentSearch"], PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing);
	const noGit = resolve(remoteFacts({ helperCapabilities: FULL_HELPER.filter((method) => method !== "git.status") }), REMOTE_PROJECT_SERVICE_METHODS);
	assert.equal(noGit.files.read, true);
	assert.equal(noGit.git.read, false);
	assert.equal(noGit.blocked["git.read"], PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing);
});

test("helper 逐方法门禁：diff/history/repos/refs 各自缺席时只关闭对应能力", () => {
	const cases = [
		["git.workspaceDiff", "diff"],
		["git.log", "history"],
		["git.repos", "repos"],
		["git.refs", "refs"],
		["fs.searchNames", "search", "files"],
	];
	for (const [method, key, group = "git"] of cases) {
		const capabilities = resolve(remoteFacts({ helperCapabilities: FULL_HELPER.filter((entry) => entry !== method) }), REMOTE_PROJECT_SERVICE_METHODS);
		const target = group === "files" ? capabilities.files : capabilities.git;
		assert.equal(target[key], false, method);
		assert.equal(capabilities.git.read, true, method);
		assert.equal(capabilities.blocked[group + "." + key], PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing, method);
	}
});

test("本机 WSL 项目没有 file-index 根：内容搜索能力关闭", () => {
	const capabilities = resolve(localFacts({ environment: "wsl" }), LOCAL_PROJECT_SERVICE_METHODS);
	assert.equal(capabilities.files.contentSearch, false);
	assert.equal(capabilities.files.read, true);
});

test("同一组输入永远同一答案", () => {
	const facts = remoteFacts();
	assert.deepEqual(plain(resolve(facts, REMOTE_PROJECT_SERVICE_METHODS)), plain(resolve(facts, REMOTE_PROJECT_SERVICE_METHODS)));
});
