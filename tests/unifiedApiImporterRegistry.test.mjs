/**
 * F6 · 统一导入注册表核对（TEST-PLAN §F6，7 例）。
 *
 * IMPORTER_CATALOG 11 行只读核对：id/manager/ipcFile/preloadNamespaces/channelPrefix/capabilities
 * 与 preload 实际命名空间面（electron stub 捕获）、shared/ipc.ts 真实通道前缀对齐；
 * capabilities 与各导入器命名空间方法面双向一致（A15）；行纯描述无行为字段；
 * 坏行对校验函数有分辨力（防恒真）。id 唯一性已由 F1 守卫覆盖，本文件不重复实现。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** TEST-PLAN §0 锚定数字：11 导入器。 */
const IMPORTER_TOTAL = 11;
const EXPECTED_IDS = ["claude", "codex", "cursor", "directory-sessions", "kimi", "kimi-work", "minimax", "opencode", "qoder", "workbuddy", "zcode"];
const CAPABILITY_ENUM = ["describe", "import", "listSources", "scan"];
const ROW_KEYS = ["capabilities", "channelPrefix", "id", "ipcFile", "manager", "preloadNamespaces"];

// electron stub 捕获 preload 实际暴露面（与 F1 同法）。
const capturedApi = (() => {
	let captured = null;
	const electronStub = {
		contextBridge: { exposeInMainWorld: (name, api) => (captured = { name, api }) },
		ipcRenderer: { invoke: () => {}, on: () => () => {}, once: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => ({}) },
		webUtils: { getPathForFile: () => "" },
	};
	const preloadMod = loadTsCommonJs("src/preload/index.ts", { stubs: { electron: electronStub } });
	captured = preloadMod.__pideckPreloadCapture ?? captured;
	assert.ok(captured && captured.name === "piDesktop", "preload 必须暴露 piDesktop");
	return captured.api;
})();

const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
const actualPrefixes = new Set(Object.values(ipcChannels).map((value) => value.split(":")[0]));
const actualNamespaces = new Set(Object.keys(capturedApi));
const catalogMod = loadTsCommonJs("src/shared/api/importerCatalog.ts");
const CATALOG = JSON.parse(JSON.stringify(catalogMod.IMPORTER_CATALOG));

/**
 * 单行校验：结构、命名空间/前缀归属、能力枚举与能力↔方法面对应，任一方面违规都进问题清单
 * （F6-2/3/4/6/7 共用同一实现，保证分辨力）。
 */
function validateImporterRow(row) {
	const problems = [];
	if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(row.id)) problems.push(`id 非 kebab-case: ${String(row.id)}`);
	if (typeof row.manager !== "string" || row.manager.length === 0) problems.push(`${row.id}: manager 非非空字符串`);
	if (!Array.isArray(row.ipcFile) || row.ipcFile.some((f) => typeof f !== "string" || f.length === 0)) problems.push(`${row.id}: ipcFile 非字符串数组`);
	for (const key of Object.keys(row)) if (!ROW_KEYS.includes(key)) problems.push(`${row.id}: 非纯描述字段 ${key}`);
	if (!Array.isArray(row.preloadNamespaces) || row.preloadNamespaces.length === 0) problems.push(`${row.id}: preloadNamespaces 为空`);
	for (const ns of row.preloadNamespaces ?? []) if (!actualNamespaces.has(ns)) problems.push(`${row.id}: 命名空间不存在于 preload 暴露面: ${ns}`);
	if (!Array.isArray(row.channelPrefix) || row.channelPrefix.length === 0) problems.push(`${row.id}: channelPrefix 为空`);
	for (const prefix of row.channelPrefix ?? []) if (!actualPrefixes.has(prefix)) problems.push(`${row.id}: 前缀不存在于真实通道面: ${prefix}`);
	if (!Array.isArray(row.capabilities) || row.capabilities.length === 0) problems.push(`${row.id}: capabilities 为空`);
	for (const cap of row.capabilities ?? []) if (!CAPABILITY_ENUM.includes(cap)) problems.push(`${row.id}: 未知能力 ${cap}`);
	if (new Set(row.capabilities ?? []).size !== (row.capabilities ?? []).length) problems.push(`${row.id}: capabilities 有重复`);
	for (const ns of row.preloadNamespaces ?? []) {
		const namespace = capturedApi[ns];
		for (const cap of row.capabilities ?? []) {
			if (CAPABILITY_ENUM.includes(cap) && namespace && typeof namespace[cap] !== "function") problems.push(`${row.id}: 命名空间 ${ns} 上能力 ${cap} 不是函数`);
		}
	}
	return problems;
}

test("F6-1 IMPORTER_CATALOG 恰 11 行且 id 集合精确（§0 锚）", () => {
	assert.equal(CATALOG.length, IMPORTER_TOTAL);
	assert.deepEqual(CATALOG.map((row) => row.id).sort(), EXPECTED_IDS);
	assert.equal(new Set(CATALOG.map((row) => row.id)).size, IMPORTER_TOTAL);
});

test("F6-2 每行 preloadNamespaces 均存在于 preload 64 命名空间暴露面", () => {
	for (const row of CATALOG) {
		for (const ns of row.preloadNamespaces) assert.ok(actualNamespaces.has(ns), `${row.id}: 未知命名空间 ${ns}`);
	}
});

test("F6-3 每行 channelPrefix 均存在于真实通道面前的 84 前缀", () => {
	for (const row of CATALOG) {
		for (const prefix of row.channelPrefix) assert.ok(actualPrefixes.has(prefix), `${row.id}: 未知前缀 ${prefix}`);
	}
});

test("F6-4 capabilities ⊆ 能力枚举且每个能力在对应命名空间上是真实函数（A15）", () => {
	for (const row of CATALOG) assert.deepEqual(validateImporterRow(row), [], `${row.id} 行校验问题`);
});

test("F6-5 能力面与命名空间方法面双向一致：9×{scan,import}、kimi-work +describe、directory-sessions +listSources", () => {
	for (const row of CATALOG) {
		const namespace = capturedApi[row.preloadNamespaces[0]];
		assert.ok(namespace, `${row.id}: 命名空间 ${row.preloadNamespaces[0]} 捕获失败`);
		assert.deepEqual(Object.keys(namespace).sort(), [...row.capabilities].sort(), `${row.id}: 命名空间方法面与声明能力不一致`);
	}
	const capabilitiesOf = (id) => [...CATALOG.find((row) => row.id === id).capabilities].sort();
	assert.deepEqual(capabilitiesOf("kimi-work"), ["describe", "import", "scan"]);
	assert.deepEqual(capabilitiesOf("directory-sessions"), ["import", "listSources", "scan"]);
	for (const row of CATALOG) {
		if (row.id === "kimi-work" || row.id === "directory-sessions") continue;
		assert.deepEqual([...row.capabilities].sort(), ["import", "scan"], `${row.id}: 外部导入器能力应恰为 scan+import`);
	}
});

test("F6-6 行为纯描述：行键集 ⊆ 描述字段白名单（无 handler/包装等行为字段）", () => {
	for (const row of CATALOG) {
		for (const key of Object.keys(row)) assert.ok(ROW_KEYS.includes(key), `${row.id}: 出现行为字段 ${key}`);
	}
});

test("F6-7 分辨力自检：坏行（未知能力/不存在命名空间/虚报能力）必被同一校验函数报出", () => {
	const withFakeCapability = { ...CATALOG[0], capabilities: [...CATALOG[0].capabilities, "teleport"] };
	assert.ok(validateImporterRow(withFakeCapability).some((p) => p.includes("未知能力 teleport")));
	const withGhostNamespace = { ...CATALOG[0], preloadNamespaces: ["ghostSessions"] };
	assert.ok(validateImporterRow(withGhostNamespace).some((p) => p.includes("命名空间不存在于 preload 暴露面: ghostSessions")));
	const lyingRow = { ...CATALOG.find((row) => row.id === "directory-sessions"), capabilities: ["scan", "import", "describe"] };
	assert.ok(validateImporterRow(lyingRow).some((p) => p.includes("能力 describe 不是函数")));
});
