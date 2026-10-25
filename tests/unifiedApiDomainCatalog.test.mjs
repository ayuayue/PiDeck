/**
 * F1 · 统一接口域清单守卫（TEST-PLAN §F1，13 例）。
 *
 * 校验 src/shared/api/domainCatalog.ts（DOMAIN_CATALOG）与 importerCatalog.ts
 * （IMPORTER_CATALOG）跟仓库真实通道面（src/shared/ipc.ts）与 preload 命名空间面
 * （src/preload/index.ts 实际暴露的 70 命名空间）的对齐：
 * 前缀认领双向闭合、命名空间认领恰好一次（伴生行冻结例外）、红线行聚合标记、
 * 特殊裁决注释在位、坏 fixture 对校验函数有分辨力。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ipcChannelsMod = loadTsCommonJs("src/shared/ipc.ts");
const ipcChannels = ipcChannelsMod.ipcChannels;

// preload 经 electron stub 捕获 contextBridge.exposeInMainWorld("piDesktop", api) 的 70 命名空间键。
let exposedNamespaces = [];
{
	let captured = null;
	const electronStub = {
		contextBridge: { exposeInMainWorld: (name, api) => (captured = { name, api }) },
		ipcRenderer: { invoke: () => {}, on: () => () => {}, once: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => ({}) },
		webUtils: { getPathForFile: () => "" },
	};
	const preloadMod = loadTsCommonJs("src/preload/index.ts", { stubs: { electron: electronStub } });
	captured = preloadMod.__pideckPreloadCapture ?? captured;
	assert.ok(captured && captured.name === "piDesktop", "preload 必须暴露 piDesktop");
	exposedNamespaces = Object.keys(captured.api);
}

const domainCatalogMod = loadTsCommonJs("src/shared/api/domainCatalog.ts");
const importerCatalogMod = loadTsCommonJs("src/shared/api/importerCatalog.ts");
const DOMAIN_CATALOG = domainCatalogMod.DOMAIN_CATALOG;
const IMPORTER_CATALOG = importerCatalogMod.IMPORTER_CATALOG;

// 仓库真实通道面：678 通道 → 84 前缀；preload 真实命名空间面：70 键。
const allChannelValues = Object.values(ipcChannels);
const actualPrefixes = new Set(allChannelValues.map((value) => value.split(":")[0]));
const actualNamespaces = new Set(exposedNamespaces);

// 命名空间认领的唯一冻结例外（伴生行，见 domainCatalog.ts 头注与行内裁决注释）：
// settings 由 settings/web 两行认领、sessions 由 sessions/dsh 两行认领。
const NAMESPACE_CLAIM_EXCEPTIONS = {
	settings: ["settings", "web"],
	sessions: ["sessions", "dsh"],
};

/**
 * 域清单校验函数（F1-1/3/5 与 F1-12 坏 fixture 共用同一实现，保证分辨力）。
 * @param {readonly object[]} rows 清单行
 * @param {Set<string>} prefixUniverse 允许认领的前缀全集
 * @param {Set<string>} namespaceUniverse 允许认领的命名空间全集
 * @returns {string[]} 违规清单（空数组 = 通过）
 */
function validateCatalog(rows, prefixUniverse, namespaceUniverse) {
	const problems = [];
	const seenIds = new Set();
	for (const row of rows) {
		if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(row.id)) problems.push(`id 非 kebab-case: ${row.id}`);
		if (seenIds.has(row.id)) problems.push(`id 重复: ${row.id}`);
		seenIds.add(row.id);
		if (!Array.isArray(row.channelPrefix) || row.channelPrefix.length === 0) problems.push(`${row.id}: channelPrefix 为空`);
		for (const prefix of row.channelPrefix ?? []) if (!prefixUniverse.has(prefix)) problems.push(`${row.id}: 前缀不存在于真实通道面: ${prefix}`);
		if (!Array.isArray(row.preloadNamespaces) || row.preloadNamespaces.length === 0) problems.push(`${row.id}: preloadNamespaces 为空`);
		for (const ns of row.preloadNamespaces ?? []) if (!namespaceUniverse.has(ns)) problems.push(`${row.id}: 命名空间不存在于 preload 暴露面: ${ns}`);
	}
	return problems;
}

test("F1-1 域清单规模 ≥50 行且 id 唯一、kebab-case", () => {
	assert.ok(DOMAIN_CATALOG.length >= 50, `DOMAIN_CATALOG 行数 ${DOMAIN_CATALOG.length} < 50`);
	assert.deepEqual(validateCatalog(DOMAIN_CATALOG, actualPrefixes, actualNamespaces), []);
});

test("F1-2 group 六枚举且每行必填", () => {
	const groups = new Set(["core", "workspace", "content", "config", "integration", "shell"]);
	for (const row of DOMAIN_CATALOG) assert.ok(groups.has(row.group), `${row.id}: 非法 group ${row.group}`);
});

test("F1-3 每行 channelPrefix 非空且都存在于真实 84 前缀", () => {
	for (const row of DOMAIN_CATALOG) {
		assert.ok(row.channelPrefix.length > 0, `${row.id}: channelPrefix 为空`);
		for (const prefix of row.channelPrefix) assert.ok(actualPrefixes.has(prefix), `${row.id}: 未知前缀 ${prefix}`);
	}
});

test("F1-4 反向闭合：84 前缀被两表 channelPrefix 并集全覆盖、无孤儿", () => {
	const claimed = new Set([...DOMAIN_CATALOG, ...IMPORTER_CATALOG].flatMap((row) => row.channelPrefix));
	const orphans = [...actualPrefixes].filter((prefix) => !claimed.has(prefix));
	assert.deepEqual(orphans, [], `未被认领的前缀: ${orphans.join(", ")}`);
	// 关键归属抽查（RESEARCH 勘误口径）：update 归 app 行、contentStore 覆盖 prompts-store/skills-store、
	// skill-store 由 skillStore 命名空间的行承载。
	const byPrefix = (prefix) => [...DOMAIN_CATALOG, ...IMPORTER_CATALOG].filter((row) => row.channelPrefix.includes(prefix));
	assert.deepEqual(
		byPrefix("update").map((row) => row.id),
		["app"],
	);
	assert.deepEqual(
		byPrefix("prompts-store").map((row) => row.id),
		["content-store"],
	);
	assert.deepEqual(
		byPrefix("skills-store").map((row) => row.id),
		["content-store"],
	);
	const skillStoreRows = byPrefix("skill-store");
	assert.equal(skillStoreRows.length, 1);
	assert.ok(skillStoreRows[0].preloadNamespaces.includes("skillStore"), "skill-store 前缀必须由 skillStore 命名空间的行认领");
});

test("F1-5 每行 preloadNamespaces 非空且都存在于 preload 70 命名空间", () => {
	for (const row of [...DOMAIN_CATALOG, ...IMPORTER_CATALOG]) {
		assert.ok(row.preloadNamespaces.length > 0, `${row.id}: preloadNamespaces 为空`);
		for (const ns of row.preloadNamespaces) assert.ok(actualNamespaces.has(ns), `${row.id}: 未知命名空间 ${ns}`);
	}
});

test("F1-6 反向闭合：70 命名空间每个被恰好一行认领（冻结例外表内允许多行）", () => {
	const claimedNs = new Set([...DOMAIN_CATALOG, ...IMPORTER_CATALOG].flatMap((row) => row.preloadNamespaces));
	const unclaimed = [...actualNamespaces].filter((ns) => !claimedNs.has(ns));
	assert.deepEqual(unclaimed, [], `未被认领的命名空间: ${unclaimed.join(", ")}`);
	for (const ns of actualNamespaces) {
		const rows = [...DOMAIN_CATALOG, ...IMPORTER_CATALOG].filter((row) => row.preloadNamespaces.includes(ns));
		const expectedIds = NAMESPACE_CLAIM_EXCEPTIONS[ns];
		if (expectedIds) {
			assert.deepEqual(rows.map((row) => row.id).sort(), [...expectedIds].sort(), `命名空间 ${ns} 的认领行集合不符冻结例外`);
		} else {
			assert.equal(rows.length, 1, `命名空间 ${ns} 被 ${rows.length} 行认领，必须恰好一行`);
		}
	}
});

test('F1-7 红线行（pi-auth / standby / model-trace / enhance / DSH 插件体系对应行）aggregation === "redline"', () => {
	const byId = new Map(DOMAIN_CATALOG.map((row) => [row.id, row]));
	// standby 池与模型快照端点宿主 pi 行、DSH 插件体系宿主 dsh 行（裁决见 domainCatalog.ts 行内注释）。
	for (const id of ["pi", "pi-auth", "enhance", "dsh"]) {
		const row = byId.get(id);
		assert.ok(row, `缺少行 ${id}`);
		assert.equal(row.aggregation, "redline", `${id}.aggregation 必须是 redline`);
	}
});

test("F1-8 SPEC A2 门面 20 域全部存在且聚合方式 ∈ {aggregate, consolidate}", () => {
	const specDomains = ["projects", "git", "terminal", "prompts", "skills", "extensions", "settings", "feishu", "pet", "sounds", "announcements", "automation", "usage-stats", "imagegen", "voice-transcription", "scratch-pad", "cua", "security", "web", "data-env"];
	const byId = new Map(DOMAIN_CATALOG.map((row) => [row.id, row]));
	for (const id of specDomains) {
		const row = byId.get(id);
		assert.ok(row, `SPEC 域缺失: ${id}`);
		assert.ok(row.aggregation === "aggregate" || row.aggregation === "consolidate", `${id}: 门面域不得是 redline`);
	}
});

test("F1-9 sessions 行 subdomains === [catalog, runtime, import, rewind]；config 行 consolidate", () => {
	const byId = new Map(DOMAIN_CATALOG.map((row) => [row.id, row]));
	// 展开到本 realm 数组再比较（加载模块来自 vm 沙箱，跨 realm 的数组原型不同）。
	assert.deepEqual([...byId.get("sessions").subdomains], ["catalog", "runtime", "import", "rewind"]);
	assert.equal(byId.get("config").aggregation, "consolidate");
	assert.equal(byId.get("sessions").aggregation, "consolidate");
});

test("F1-10 四处特殊裁决注释存在（空白容忍正则）", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../src/shared/api/domainCatalog.ts", import.meta.url), "utf8");
	const rulings = [/contentStore[\s\S]{0,400}prompts-store[^\n]{0,40}skills-store/, /skill-store[\s\S]{0,200}skillStore\s*独立命名空间[\s\S]{0,200}storeIpc\.ts/, /appGetChannel[\s\S]{0,120}update:get-channel/, /agents:rpc-log[\s\S]{0,120}rpc-logs/];
	for (const pattern of rulings) assert.ok(pattern.test(source), `缺少特殊裁决注释: ${pattern}`);
});

test("F1-11 域行数据为推导产物（注释含探针/推导注记）", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../src/shared/api/domainCatalog.ts", import.meta.url), "utf8");
	assert.ok(/探针|推导|快照/.test(source), "域清单必须注明数据推导来源（探针/快照）");
});

test("F1-12 坏 fixture 分辨力：重复 id 与孤儿前缀必须使校验函数变红", () => {
	const good = DOMAIN_CATALOG.slice(0, 3);
	assert.deepEqual(validateCatalog(good, actualPrefixes, actualNamespaces), []);
	const dup = [{ ...good[0] }, { ...good[0] }];
	assert.ok(
		validateCatalog(dup, actualPrefixes, actualNamespaces).some((p) => p.includes("重复")),
		"重复 id 必须被检出",
	);
	const orphan = [{ ...good[0], id: "ghost-domain", channelPrefix: ["no-such-prefix"] }];
	assert.ok(
		validateCatalog(orphan, actualPrefixes, actualNamespaces).some((p) => p.includes("no-such-prefix")),
		"孤儿前缀必须被检出",
	);
});

test("F1-13 DOMAIN_CATALOG 不含 IMPORTER_CATALOG 的 11 个导入器 id", () => {
	const importerIds = new Set(IMPORTER_CATALOG.map((row) => row.id));
	assert.equal(importerIds.size, 11, "导入器必须 11 个");
	for (const row of DOMAIN_CATALOG) assert.ok(!importerIds.has(row.id), `域清单不得含导入器 id: ${row.id}`);
});
