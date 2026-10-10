import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiResourceConfigService, projectExtensionEnabled, projectExtensionFiltered, isPackageSource, isExactEntryFor, packageSourceOf, isPackageDelta, isEntryDisabled, packageFilterSnapshot, restorePackageDefaults } = loadTsCommonJs("src/main/config/PiResourceConfigService.ts");
const { PiResourceStateStore, packageSnapshotFingerprint } = loadTsCommonJs("src/main/config/PiResourceStateStore.ts");

function setupProject() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-pires-"));
	const agentDir = join(dir, ".pi", "agent");
	const projectRoot = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectRoot, ".pi"), { recursive: true });
	const state = new PiResourceStateStore(join(dir, "state.json"));
	const service = new PiResourceConfigService(
		{
			globalSettingsPath: () => join(agentDir, "settings.json"),
			resolveProject: async (projectId) => (projectId === "p1" ? { root: projectRoot, trusted: true } : null),
		},
		state,
		{ projectTrust: async (_id, root) => root === projectRoot },
	);
	return { dir, agentDir, projectRoot, state, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("readSummary defaults built-ins to enabled with inherit state", async () => {
	const { service, cleanup } = setupProject();
	try {
		const summary = await service.readSummary({ scope: "global" });
		assert.equal(summary.builtins.length, 4);
		assert.ok(summary.builtins.every((item) => item.enabled && item.state === "inherit"));
		assert.equal(summary.exists, false);
	} finally {
		cleanup();
	}
});

test("setBuiltinEnabled writes -builtin:/+builtin: into the requested scope", async () => {
	const { service, agentDir, projectRoot, cleanup } = setupProject();
	try {
		const off = await service.setBuiltinEnabled({ scope: "global" }, "mcp", false);
		assert.equal(off.ok, true);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["-builtin:mcp"]);
		const on = await service.setBuiltinEnabled({ scope: "global" }, "mcp", true);
		assert.equal(on.ok, true);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["+builtin:mcp"]);
		// 项目作用域写项目 .pi/settings.json，不碰全局
		const projectOff = await service.setBuiltinEnabled({ scope: "project", projectId: "p1" }, "codemode", false);
		assert.equal(projectOff.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).extensions, ["-builtin:codemode"]);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["+builtin:mcp"]);
	} finally {
		cleanup();
	}
});

test("project builtin state reflects global inheritance", async () => {
	const { service, agentDir, projectRoot, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }), "utf8");
		const inherited = await service.readSummary({ scope: "project", projectId: "p1" });
		assert.equal(inherited.builtins.find((item) => item.name === "mcp").enabled, false);
		assert.equal(inherited.builtins.find((item) => item.name === "mcp").state, "inherit");
		// 项目 +builtin:mcp 覆盖全局停用
		writeFileSync(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }), "utf8");
		const overridden = await service.readSummary({ scope: "project", projectId: "p1" });
		assert.equal(overridden.builtins.find((item) => item.name === "mcp").enabled, true);
		assert.equal(overridden.builtins.find((item) => item.name === "mcp").state, "explicit-enabled");
	} finally {
		cleanup();
	}
});

test("builtin summary distinguishes allowed extension loading from selected tools", async () => {
	const { service, agentDir, projectRoot, cleanup } = setupProject();
	try {
		const builtin = (snapshot, name) => snapshot.builtins.find((item) => item.name === name);
		const defaults = await service.readSummary({ scope: "global" });
		assert.equal(builtin(defaults, "codemode").enabled, true);
		assert.equal(builtin(defaults, "codemode").toolEnabled, false);
		assert.equal(builtin(defaults, "tool-search").toolEnabled, false);
		assert.equal(builtin(defaults, "mcp").toolEnabled, undefined);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["!builtin:*", "+builtin:codemode"], defaultTools: ["+codemode"] }));
		const global = await service.readSummary({ scope: "global" });
		assert.equal(builtin(global, "codemode").toolEnabled, true);
		writeFileSync(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-codemode", "+tool_search"], extensions: ["+builtin:tool-search"] }));
		const project = await service.readSummary({ scope: "project", projectId: "p1" });
		assert.equal(builtin(project, "codemode").enabled, true);
		assert.equal(builtin(project, "codemode").toolEnabled, false);
		assert.equal(builtin(project, "tool-search").toolEnabled, true);
		await service.setBuiltinEnabled({ scope: "global" }, "codemode", false);
		assert.equal(builtin(await service.readSummary({ scope: "global" }), "codemode").toolEnabled, false, "selected tools are unavailable when their extension is disabled");
	} finally {
		cleanup();
	}
});

test("the first builtin switch writes a missing configuration using the summary revision", async () => {
	const { service, cleanup } = setupProject();
	try {
		for (const scope of [{ scope: "global" }, { scope: "project", projectId: "p1" }]) {
			const before = await service.readSummary(scope);
			const result = await service.setBuiltinEnabled(scope, "codemode", false, { expectedRevision: before.revision });
			assert.equal(result.ok, true, result.error);
			const after = await service.readSummary(scope);
			assert.equal(after.builtins.find((item) => item.name === "codemode").enabled, false);
		}
	} finally {
		cleanup();
	}
});

test("file resource toggle keeps explicit path and user globs", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["!*", "/home/me/skills/keep/SKILL.md"] }), "utf8");
		const enable = await service.setFileResourceEnabled({ scope: { scope: "global" }, kind: "skills", resourceId: "/home/me/skills/keep/SKILL.md", enabled: true });
		assert.equal(enable.ok, true);
		const after = readJson(join(agentDir, "settings.json")).skills;
		assert.ok(after.includes("/home/me/skills/keep/SKILL.md"));
		assert.ok(after.includes("+/home/me/skills/keep/SKILL.md"));
		assert.ok(after.includes("!*"));
	} finally {
		cleanup();
	}
});

test("package whole-disable writes four empty filters and preserves source/unknown fields", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:demo", extensions: ["keep.ts"], unknown: 1 }] }), "utf8");
		const off = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:demo", enabled: false });
		assert.equal(off.ok, true);
		const entry = readJson(join(agentDir, "settings.json")).packages[0];
		assert.equal(entry.source, "npm:demo");
		assert.equal(entry.unknown, 1);
		assert.deepEqual(entry.extensions, []);
		assert.deepEqual(entry.skills, []);
		assert.deepEqual(entry.prompts, []);
		assert.deepEqual(entry.themes, []);
	} finally {
		cleanup();
	}
});

test("package enable restores the pre-disable filters when nothing changed externally", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:demo", extensions: ["keep.ts"], skills: ["a/SKILL.md"] }] }), "utf8");
		const off = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:demo", enabled: false });
		assert.equal(off.ok, true);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).packages[0].extensions, []);
		const on = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:demo", enabled: true });
		assert.equal(on.ok, true);
		const restored = readJson(join(agentDir, "settings.json")).packages[0];
		// 停用后没有外部修改：恢复停用前的过滤（部分启用保持部分启用）
		assert.deepEqual(restored.extensions, ["keep.ts"]);
		assert.deepEqual(restored.skills, ["a/SKILL.md"]);
	} finally {
		cleanup();
	}
});

test("string-form package entry (pi install 默认形态) disables and re-enables", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		// pi install 写入的默认形态是纯字符串，不是对象——此前被误判 invalid（用户实测踩中）
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:my-ext"] }), "utf8");
		const off = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:my-ext", enabled: false });
		assert.equal(off.ok, true, JSON.stringify(off));
		const disabled = readJson(join(agentDir, "settings.json")).packages[0];
		assert.equal(disabled.source, "npm:my-ext");
		assert.deepEqual(disabled.extensions, []);
		assert.deepEqual(disabled.skills, []);
		const on = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:my-ext", enabled: true });
		assert.equal(on.ok, true, JSON.stringify(on));
		const restored = readJson(join(agentDir, "settings.json")).packages[0];
		// 停用前就是纯字符串 → 恢复后回到纯字符串（不残留空对象形态）
		assert.equal(restored, "npm:my-ext");
	} finally {
		cleanup();
	}
});

test("enable without a usable snapshot folds the emptied filter object back to a plain string", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		// 迁移/手改留下的停用对象，但没有对应快照（跨版本、快照文件丢失、外部改过）
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:legacy", extensions: [], skills: [], prompts: [], themes: [] }] }), "utf8");
		const on = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:legacy", enabled: true });
		assert.equal(on.ok, true, JSON.stringify(on));
		const restored = readJson(join(agentDir, "settings.json")).packages[0];
		assert.equal(restored, "npm:legacy", "空过滤对象应折回纯字符串，否则 pi list 永久显示 (filtered)，用户只是关过开关却像做了过滤式安装");
	} finally {
		cleanup();
	}
});

test("enable keeps unknown fields instead of dropping them while collapsing", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:legacy", extensions: [], skills: [], prompts: [], themes: [], custom: 1 }] }), "utf8");
		const on = await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:legacy", enabled: true });
		assert.equal(on.ok, true, JSON.stringify(on));
		const restored = readJson(join(agentDir, "settings.json")).packages[0];
		assert.equal(restored.source, "npm:legacy");
		assert.equal(restored.custom, 1, "折叠不能丢未知字段");
	} finally {
		cleanup();
	}
});

test("string-form entry with prior partial filters restores those filters", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:plain", { source: "npm:filtered", extensions: ["keep.ts"] }] }), "utf8");
		// 对象形态、停用前有过滤 → 恢复时保留过滤（原行为回归）
		await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:filtered", enabled: false });
		await service.setPackageEnabled({ scope: { scope: "global" }, resourceId: "npm:filtered", enabled: true });
		const pkgs = readJson(join(agentDir, "settings.json")).packages;
		assert.deepEqual(pkgs[1].extensions, ["keep.ts"]);
		assert.equal(pkgs[0], "npm:plain");
	} finally {
		cleanup();
	}
});

test("project package delta uses pattern sets on disable and enable", async () => {
	const { service, projectRoot, cleanup } = setupProject();
	try {
		writeFileSync(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: "npm:demo", autoload: false, skills: ["custom/SKILL.md"] }] }), "utf8");
		const off = await service.setPackageEnabled({ scope: { scope: "project", projectId: "p1" }, resourceId: "npm:demo", enabled: false });
		assert.equal(off.ok, true);
		const entry = readJson(join(projectRoot, ".pi", "settings.json")).packages[0];
		assert.equal(entry.autoload, false);
		assert.deepEqual(entry.skills, ["!*", "!.*"]);
		const on = await service.setPackageEnabled({ scope: { scope: "project", projectId: "p1" }, resourceId: "npm:demo", enabled: true });
		assert.equal(on.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).packages[0].skills, ["*", ".*"]);
	} finally {
		cleanup();
	}
});

test("untrusted or unknown project scope is rejected without writing", async () => {
	const { service, projectRoot, cleanup } = setupProject();
	try {
		const unknown = await service.setBuiltinEnabled({ scope: "project", projectId: "nope" }, "mcp", false);
		assert.equal(unknown.ok, false);
		const untrusted = await service.setBuiltinEnabled({ scope: "project", projectId: "p1" }, "mcp", false);
		// projectTrust 回调在 precheck 里再校验一次；这里 p1 通过，用不匹配的 root 验证拒绝路径
		assert.equal(untrusted.ok, true);
		const trustDenied = new PiResourceConfigService({ globalSettingsPath: () => join(projectRoot, "settings.json"), resolveProject: async () => ({ root: projectRoot, trusted: false }) }, new PiResourceStateStore(join(projectRoot, "state.json")), {});
		const denied = await trustDenied.setBuiltinEnabled({ scope: "project", projectId: "p1" }, "mcp", false);
		assert.equal(denied.ok, false);
	} finally {
		cleanup();
	}
});

test("stale expectedRevision is rejected as a conflict", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		const first = await service.setBuiltinEnabled({ scope: "global" }, "mcp", false);
		assert.equal(first.ok, true);
		const conflict = await service.setBuiltinEnabled({ scope: "global" }, "codemode", false, { expectedRevision: "stale-hash" });
		assert.equal(conflict.ok, false);
		assert.match(conflict.error ?? "", /changed on disk/);
		// 目标文件保持第一次写入的结果
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["-builtin:mcp"]);
	} finally {
		cleanup();
	}
});

test("package helpers cover string entries, deltas and filter snapshots", () => {
	assert.equal(packageSourceOf("npm:a"), "npm:a");
	assert.equal(packageSourceOf({ source: "npm:b" }), "npm:b");
	assert.equal(packageSourceOf({}), undefined);
	assert.equal(isPackageDelta({ source: "npm:a", autoload: false }), true);
	assert.equal(isPackageDelta({ source: "npm:a" }), false);
	assert.equal(isEntryDisabled({ extensions: [], skills: [], prompts: [], themes: [] }), true);
	assert.equal(isEntryDisabled({ source: "npm:a" }), false);
	const snapshot = packageFilterSnapshot({ source: "npm:a", extensions: ["x"], skills: [], prompts: undefined, themes: ["t"] });
	assert.deepEqual([...snapshot.extensions], ["x"]);
	assert.deepEqual([...snapshot.skills], []);
	assert.equal("prompts" in snapshot, false);
	assert.deepEqual([...snapshot.themes], ["t"]);
	assert.deepEqual(JSON.parse(JSON.stringify(restorePackageDefaults({ source: "npm:a", extensions: [], unknown: 1 }))), { source: "npm:a", unknown: 1 });
	assert.equal(typeof packageSnapshotFingerprint({ extensions: [] }), "string");
});

test("state store snapshot is idempotent and detects external changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-state-"));
	try {
		const store = new PiResourceStateStore(join(dir, "state.json"));
		const key = store.packageKey("/a/settings.json", "npm:demo");
		store.savePackageSnapshot(key, { extensions: ["keep.ts"] });
		// 再次保存不覆盖原始快照
		store.savePackageSnapshot(key, { extensions: ["different.ts"] });
		assert.deepEqual([...store.takePackageSnapshot(key).extensions], ["keep.ts"]);
		store.markPackageSnapshotAfter(key, { source: "npm:demo", extensions: [], skills: [], prompts: [], themes: [] });
		assert.equal(store.isPackageSnapshotCurrent(key, { source: "npm:demo", extensions: [], skills: [], prompts: [], themes: [] }), true);
		assert.equal(store.isPackageSnapshotCurrent(key, { source: "npm:demo", extensions: ["external.ts"] }), false);
		store.clearPackageSnapshot(key);
		assert.equal(store.takePackageSnapshot(key), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setExtensionEnabled dispatches package installs to package filters and local files to exact rules", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pkg", extensions: ["keep.ts"] }], extensions: [] }), "utf8");
		// 包安装 → 整包停用（extensions 数组不受影响）
		const pkgOff = await service.setExtensionEnabled({ scope: { scope: "global" }, source: "npm:pkg", enabled: false });
		assert.equal(pkgOff.ok, true);
		const afterPkg = readJson(join(agentDir, "settings.json"));
		assert.deepEqual(afterPkg.packages[0].extensions, []);
		assert.deepEqual(afterPkg.extensions, []);
		// 本地文件扩展 → 顶层精确 -path
		const fileOff = await service.setExtensionEnabled({ scope: { scope: "global" }, source: "my-ext", path: "/home/me/.pi/agent/extensions/my-ext.ts", enabled: false });
		assert.equal(fileOff.ok, true);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["-/home/me/.pi/agent/extensions/my-ext.ts"]);
	} finally {
		cleanup();
	}
});

test("setProjectInheritedOverride writes plain path + exact rule and can restore inheritance", async () => {
	const { service, projectRoot, cleanup } = setupProject();
	try {
		const applied = await service.setProjectInheritedOverride({ projectId: "p1", kind: "skills", value: "/home/me/.pi/agent/skills/x/SKILL.md", state: "disabled" });
		assert.equal(applied.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).skills, ["/home/me/.pi/agent/skills/x/SKILL.md", "-/home/me/.pi/agent/skills/x/SKILL.md"]);
		// 在本层启用：替换成精确 +
		const enabled = await service.setProjectInheritedOverride({ projectId: "p1", kind: "skills", value: "/home/me/.pi/agent/skills/x/SKILL.md", state: "enabled" });
		assert.equal(enabled.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).skills, ["/home/me/.pi/agent/skills/x/SKILL.md", "+/home/me/.pi/agent/skills/x/SKILL.md"]);
		// 恢复继承：移除覆盖条目，保留用户其它条目
		await service.setFileResourceEnabled({ scope: { scope: "project", projectId: "p1" }, kind: "skills", resourceId: "/keep/SKILL.md", enabled: false });
		const restored = await service.setProjectInheritedOverride({ projectId: "p1", kind: "skills", value: "/home/me/.pi/agent/skills/x/SKILL.md", state: "inherit" });
		assert.equal(restored.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).skills, ["-/keep/SKILL.md"]);
	} finally {
		cleanup();
	}
});

test("setProjectInheritedOverride 写入时清掉历史缺陷的身份键条目（自愈）", async () => {
	const { service, projectRoot, cleanup } = setupProject();
	try {
		// 历史缺陷（2026-10-04 实测）曾把 PiDeck 身份键当路径写入；pi 不认这种值。
		writeFileSync(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ skills: ["pi-global:image-gen", "-pi-global:image-gen"] }));
		const applied = await service.setProjectInheritedOverride({ projectId: "p1", kind: "skills", value: "/home/me/.pi/agent/skills/image-gen/SKILL.md", state: "disabled" });
		assert.equal(applied.ok, true);
		assert.deepEqual(readJson(join(projectRoot, ".pi", "settings.json")).skills, ["/home/me/.pi/agent/skills/image-gen/SKILL.md", "-/home/me/.pi/agent/skills/image-gen/SKILL.md"]);
	} finally {
		cleanup();
	}
});

test("isPackageSource / isExactEntryFor pure helpers", () => {
	assert.equal(isPackageSource("npm:foo"), true);
	assert.equal(isPackageSource("git:github.com/a/b"), true);
	assert.equal(isPackageSource("github:x/y"), true);
	assert.equal(isPackageSource("my-local-ext"), false);
	assert.equal(isPackageSource("/abs/path.ts"), false);
	assert.equal(isExactEntryFor("-/a/b.ts", "/a/b.ts"), true);
	assert.equal(isExactEntryFor("+/a/b.ts", "/a/b.ts"), true);
	assert.equal(isExactEntryFor("/a/b.ts", "/a/b.ts"), true);
	assert.equal(isExactEntryFor("-/a/c.ts", "/a/b.ts"), false);
});

test("projectExtensionEnabled：包安装看 packages 条目，顶层包目录规则不再否决（回归：开关弹回）", () => {
	const pkgDir = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\billion-context-pi";
	// 触发用例的真实磁盘状态：packages 里是启用的包条目 + 迁移写下的顶层 -<包目录> 残留
	const entries = [`-${pkgDir}`, "-builtin:llama.cpp"];
	assert.equal(projectExtensionEnabled({ source: "npm:billion-context-pi", path: pkgDir, entries, packages: [{ source: "npm:billion-context-pi" }] }), true, "包条目未停用 → 开关必须显示开启，不能被顶层残留按回去");
	assert.equal(projectExtensionEnabled({ source: "npm:billion-context-pi", path: pkgDir, entries, packages: ["npm:billion-context-pi"] }), true, "纯字符串包条目（默认安装形态）同样是启用");
	assert.equal(projectExtensionEnabled({ source: "npm:billion-context-pi", path: pkgDir, entries, packages: [{ source: "npm:billion-context-pi", extensions: [], skills: [], prompts: [], themes: [] }] }), false, "整包停用（四类过滤全空）显示停用");
	assert.equal(projectExtensionEnabled({ source: "npm:billion-context-pi", path: pkgDir, entries, packages: null }), undefined, "packages 快照不可用 → 交回调用方兜底");
	assert.equal(projectExtensionEnabled({ source: "npm:other", path: "/pkg/other", entries: ["-/pkg/other"], packages: [{ source: "npm:billion-context-pi" }] }), undefined, "包不在本层（项目层声明的包）不拿顶层规则反推");
	// 本地文件扩展仍然走顶层精确规则
	assert.equal(projectExtensionEnabled({ source: "my-local-ext", path: "/agent/extensions/a.ts", entries: ["-/agent/extensions/a.ts"], packages: [] }), false);
	assert.equal(projectExtensionEnabled({ source: "my-local-ext", path: "/agent/extensions/a.ts", entries: [], packages: [] }), true);
});

test("projectExtensionFiltered：整包停用/空对象不算过滤式安装，真过滤键才算", () => {
	const packages = [
		"npm:plain",
		{ source: "npm:disabled", extensions: [], skills: [], prompts: [], themes: [] },
		{ source: "npm:empty" },
		{ source: "npm:partial", extensions: ["-dist/index.js"] },
		{ source: "npm:delta-off", autoload: false, extensions: ["!*", "!.*"], skills: ["!*", "!.*"], prompts: ["!*", "!.*"], themes: ["!*", "!.*"] },
		{ source: "npm:delta-select", autoload: false, skills: ["custom/SKILL.md"] },
	];
	assert.equal(projectExtensionFiltered({ source: "npm:plain", packages }), false, "纯字符串 = 默认安装");
	assert.equal(projectExtensionFiltered({ source: "npm:disabled", packages }), false, "整包停用只是关了开关，不是过滤式安装（pi list 会误标 filtered）");
	assert.equal(projectExtensionFiltered({ source: "npm:empty", packages }), false, "历史残留的空对象没有过滤");
	assert.equal(projectExtensionFiltered({ source: "npm:partial", packages }), true, "有实际过滤键才是过滤式安装");
	assert.equal(projectExtensionFiltered({ source: "npm:delta-off", packages }), false, "delta 的全关覆盖同样不算过滤式安装");
	assert.equal(projectExtensionFiltered({ source: "npm:delta-select", packages }), true);
	// 无法判定：包不在本层 / 快照不可用 / 非包来源（保留 pi list 的结论）
	assert.equal(projectExtensionFiltered({ source: "npm:missing", packages }), undefined);
	assert.equal(projectExtensionFiltered({ source: "npm:plain", packages: null }), undefined);
	assert.equal(projectExtensionFiltered({ source: "local-ext.ts", packages }), undefined);
});

test("回归：启用包扩展后读回不再是停用（服务写入 + 投影联合）", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		const pkgDir = join(agentDir, "npm", "node_modules", "billion-context-pi");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:billion-context-pi" }], extensions: [`-${pkgDir}`, "-builtin:llama.cpp"] }), "utf8");
		const enabled = await service.setExtensionEnabled({ scope: { scope: "global" }, source: "npm:billion-context-pi", path: pkgDir, enabled: true });
		assert.equal(enabled.ok, true);
		const file = readJson(join(agentDir, "settings.json"));
		assert.equal(projectExtensionEnabled({ source: "npm:billion-context-pi", path: pkgDir, entries: file.extensions, packages: file.packages }), true, "写入成功后的投影必须是开启，否则开关会弹回");
	} finally {
		cleanup();
	}
});

test("stripPackageRootResourceRules：删掉指向包安装目录的精确规则，保留其它规则", async () => {
	const { service, agentDir, cleanup } = setupProject();
	try {
		const pkgDir = join(agentDir, "npm", "node_modules", "billion-context-pi");
		const innerFile = join(pkgDir, "dist", "index.js");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [`-${pkgDir}`, "-builtin:llama.cpp", innerFile] }), "utf8");
		const result = await service.stripPackageRootResourceRules({ scope: "global" }, [pkgDir]);
		assert.equal(result.ok, true);
		assert.deepEqual([...result.removed], [`-${pkgDir}`]);
		assert.deepEqual(readJson(join(agentDir, "settings.json")).extensions, ["-builtin:llama.cpp", innerFile], "包内文件路径对 pi 有效，必须保留");
		// 幂等：再跑一次没有可删项，也不报错
		const again = await service.stripPackageRootResourceRules({ scope: "global" }, [pkgDir]);
		assert.equal(again.ok, true);
		assert.deepEqual([...again.removed], []);
		// 没有包目录可参考时不碰文件
		assert.deepEqual([...(await service.stripPackageRootResourceRules({ scope: "global" }, [])).removed], []);
	} finally {
		cleanup();
	}
});
