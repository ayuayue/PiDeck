/**
 * F5 · sessions/config 收口映射核对（TEST-PLAN §F5，11 例）。
 *
 * 解析 src/preload/index.ts 源码（注释与字符串骨架化 + 花括号深度扫描，空白容忍）
 * 提取 sessions/config 命名空间方法全集，并与 electron stub 捕获的实际暴露面交叉印证；
 * 核对 T4 落盘的 SESSIONS_SUBDOMAINS/CONFIG_SUBSTORES（consolidations.ts）：
 * 四组并集≡112 全集（§0 锚）、两两互斥（A14）、DSH 归属按 PLAN.md S5 裁定、
 * config 十组≡50 全集与方法族口径（FIND-4：ConfigManager 单类按语义分组）、
 * facadeTypes.ts 视图成员与映射常量同源；坏 fixture 对校验函数有分辨力（防恒真）。
 * 映射数据与裁定不符时用例如实红（走返工流程），本测试不改动任何 src/ 数据。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const PRELOAD_SOURCE = readFileSync("src/preload/index.ts", "utf8");
const CONSOLIDATIONS_SOURCE = readFileSync("src/shared/api/consolidations.ts", "utf8");
const FACADE_SOURCE = readFileSync("src/shared/api/facadeTypes.ts", "utf8");
/**
 * TEST-PLAN §0 锚定数字：sessions 112、config 50（2026-11 新增外部 Agent 供应商导入两法：
 * discoverExternalAgents / resolveExternalAgentKey 归 models 组，48→50）。
 * 2026-10-21：下线 readDshSystemPrompt / readOutlineTitle（轨迹事实与索引 preview 取代），114→112。
 * 变更史：2026-10-19 下线 GUI 扩展桥的 sendBridgeEvent / requestBridgeResync（112→111）；
 * 2027-02 下线会话级文件清单 IPC listSessionFileChanges（→110），同批把一直漏分组、
 * 但确实存在于 preload 的 draftPromptTemplates / listRuntimePromptTemplates 补进 runtime 组
 * （基线因此长期存在「四组总和 111 vs preload 113」的偏差，本测试此前一直是红的）→112。
 */
const SESSIONS_METHOD_TOTAL = 112;
const CONFIG_METHOD_TOTAL = 50;
const SESSIONS_GROUP_KEYS = ["catalog", "import", "rewind", "runtime"];
const CONFIG_GROUP_KEYS = ["auth", "maintenance", "mcp", "models", "resources", "settings", "tokendance", "trust", "usageProbes", "vision"];

/** 骨架化：注释与字符串整体置空（等长替换，偏移与行号和原文一一对应）。 */
function skeletonize(source) {
	const out = source.split("");
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		if (c === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") out[i++] = " ";
		} else if (c === "/" && source[i + 1] === "*") {
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) out[i++] = " ";
			if (i < source.length) {
				out[i++] = " ";
				out[i++] = " ";
			}
		} else if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out[i++] = " ";
			while (i < source.length && source[i] !== quote) {
				if (source[i] === "\\") out[i++] = " ";
				out[i++] = " ";
			}
			if (i < source.length) out[i++] = " ";
		} else {
			i++;
		}
	}
	return out.join("");
}

/** 深度表：depth[i] = 字符 i 之前的花括号深度（api 对象字面量内为深度 1，其命名空间成员为深度 2）。 */
function buildDepth(skeleton) {
	const depth = new Array(skeleton.length);
	let d = 0;
	for (let i = 0; i < skeleton.length; i++) {
		depth[i] = d;
		if (skeleton[i] === "{") d++;
		else if (skeleton[i] === "}") d--;
	}
	return depth;
}

function buildLineStarts(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
	return starts;
}

function lineOf(lineStarts, offset) {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

/**
 * 提取深度 1（api 对象）下指定命名空间的方法名全集。
 * 方法键形如 `name: (params) =>`（preload 方法全部为该形态），且要求前一个有效字符为 `{` 或 `,`，
 * 与三元值/回调参数中的伪键区分；方法值内的嵌套对象/箭头体处于深度 ≥3，被深度过滤排除。
 */
function extractNamespaceMethods(source, namespaceName) {
	const skeleton = skeletonize(source);
	const depth = buildDepth(skeleton);
	const lineStarts = buildLineStarts(source);
	let open = -1;
	for (const m of skeleton.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/g)) {
		if (depth[m.index] !== 1 || m[1] !== namespaceName) continue;
		open = m.index + m[0].length - 1;
		break;
	}
	assert.ok(open >= 0, `深度 1 未找到命名空间 ${namespaceName}: {`);
	let close = -1;
	for (let i = open + 1; i < skeleton.length; i++) {
		if (skeleton[i] === "}" && depth[i] === 2) {
			close = i;
			break;
		}
	}
	assert.ok(close > open, `命名空间 ${namespaceName} 未闭合`);
	const methods = [];
	// 参数表容许三层括号嵌套（如 on* 订阅的回调类型 `(callback: (url: string) => void)`）。
	for (const m of skeleton.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*=>/g)) {
		if (m.index <= open || m.index >= close || depth[m.index] !== 2) continue;
		let j = m.index - 1;
		while (j > open && (skeleton[j] === " " || skeleton[j] === "\t" || skeleton[j] === "\n" || skeleton[j] === "\r")) j--;
		if (skeleton[j] !== "{" && skeleton[j] !== ",") continue;
		methods.push({ name: m[1], line: lineOf(lineStarts, m.index) });
	}
	return { methods, startLine: lineOf(lineStarts, open), endLine: lineOf(lineStarts, close) };
}

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

const consolidationsMod = loadTsCommonJs("src/shared/api/consolidations.ts");
const SESSIONS = JSON.parse(JSON.stringify(consolidationsMod.SESSIONS_SUBDOMAINS));
const CONFIG = JSON.parse(JSON.stringify(consolidationsMod.CONFIG_SUBSTORES));
const sessionsUniverse = extractNamespaceMethods(PRELOAD_SOURCE, "sessions").methods;
const configUniverse = extractNamespaceMethods(PRELOAD_SOURCE, "config").methods;
const sessionsLine = new Map(sessionsUniverse.map((m) => [m.name, m.line]));
const sessionsNames = sessionsUniverse.map((m) => m.name);
const configNames = configUniverse.map((m) => m.name);

/** 并集差异：映射各组方法名并集相对全集的缺失/多出（F5-2/8/9/11 共用同一实现，保证分辨力）。 */
function diffGroups(mapping, universe) {
	const union = new Set(Object.values(mapping).flat());
	const missing = universe.filter((name) => !union.has(name)).sort();
	const extra = [...union].filter((name) => !universe.includes(name)).sort();
	return { missing, extra };
}

/** 结构校验：组键集恰为期望集、每组为非空字符串数组（F5-1/8/10 共用）。 */
function validateGroupingStructure(mapping, expectedKeys) {
	const problems = [];
	for (const key of Object.keys(mapping)) if (!expectedKeys.includes(key)) problems.push(`未知组: ${key}`);
	for (const key of expectedKeys) if (!(key in mapping)) problems.push(`缺组: ${key}`);
	for (const [group, names] of Object.entries(mapping)) {
		if (!Array.isArray(names)) {
			problems.push(`${group}: 值非数组`);
			continue;
		}
		for (const name of names) if (typeof name !== "string" || name.length === 0) problems.push(`${group}: 非字符串方法名 ${JSON.stringify(name)}`);
	}
	return problems;
}

function lineOfNeedle(source, needle) {
	const index = source.indexOf(needle);
	assert.ok(index >= 0, `源码未找到 ${needle}`);
	return lineOf(buildLineStarts(source), index);
}

test("F5-1 SESSIONS_SUBDOMAINS 组键集恰为 catalog/runtime/import/rewind 四组", () => {
	assert.deepEqual(Object.keys(SESSIONS).sort(), SESSIONS_GROUP_KEYS);
	assert.deepEqual(validateGroupingStructure(SESSIONS, SESSIONS_GROUP_KEYS), []);
});

test("F5-2 四组并集 ≡ preload sessions 命名空间 112 方法全集（无丢失无新增，§0 锚）", () => {
	assert.equal(sessionsNames.length, SESSIONS_METHOD_TOTAL, `源码解析得 ${sessionsNames.length} 个方法`);
	assert.deepEqual(diffGroups(SESSIONS, sessionsNames), { missing: [], extra: [] });
	assert.equal(Object.values(SESSIONS).flat().length, SESSIONS_METHOD_TOTAL, "四组方法数之和 = 114");
});

test("F5-3 四组两两互斥（A14）", () => {
	const groups = Object.entries(SESSIONS);
	for (let i = 0; i < groups.length; i++) {
		for (let j = i + 1; j < groups.length; j++) {
			const overlap = groups[i][1].filter((name) => groups[j][1].includes(name));
			assert.deepEqual(overlap, [], `${groups[i][0]} ∩ ${groups[j][0]} 非空`);
		}
	}
});

test("F5-4 源码解析与 preload 实际暴露面双向一致（运行捕获交叉印证）", () => {
	assert.deepEqual([...sessionsNames].sort(), Object.keys(capturedApi.sessions).sort());
	assert.deepEqual([...configNames].sort(), Object.keys(capturedApi.config).sort());
	assert.equal(Object.keys(capturedApi.config).length, CONFIG_METHOD_TOTAL);
});

test("F5-5 facadeTypes 视图成员与映射常量同源（源码契约，空白容忍）", () => {
	const sessionsView = FACADE_SOURCE.match(/export\s+type\s+SessionsDomainView[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? "";
	assert.ok(sessionsView.length > 0, "未找到 SessionsDomainView 定义");
	const configView = FACADE_SOURCE.match(/export\s+type\s+ConfigDomainView[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? "";
	assert.ok(configView.length > 0, "未找到 ConfigDomainView 定义");
	const memberRe = /^[\t ]*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*SubPick\s*<[^>]*?typeof\s+(SESSIONS_SUBDOMAINS|CONFIG_SUBSTORES)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/gm;
	const pairsOf = (body) => [...body.matchAll(memberRe)].map((m) => [m[1], m[3]]);
	assert.deepEqual(
		pairsOf(sessionsView).sort((a, b) => a[0].localeCompare(b[0])),
		SESSIONS_GROUP_KEYS.map((key) => [key, key]),
		"SessionsDomainView 每个成员必须引用同名 SESSIONS_SUBDOMAINS 组常量",
	);
	assert.deepEqual(
		pairsOf(configView).sort((a, b) => a[0].localeCompare(b[0])),
		CONFIG_GROUP_KEYS.map((key) => [key, key]),
		"ConfigDomainView 每个成员必须引用同名 CONFIG_SUBSTORES 组常量",
	);
});

test("F5-6 fixture 工厂按组 pick：输出键并集 ≡ 114 方法全集（SubPick 缺席静默语义）", () => {
	let counter = 0;
	const fixture = {};
	for (const name of sessionsNames) fixture[name] = () => counter++;
	const pickByGroup = (names) => {
		const out = {};
		for (const name of names) if (name in fixture) out[name] = fixture[name];
		return out;
	};
	const pickedKeys = SESSIONS_GROUP_KEYS.flatMap((group) => Object.keys(pickByGroup(SESSIONS[group])));
	assert.equal(pickedKeys.length, SESSIONS_METHOD_TOTAL);
	assert.deepEqual(pickedKeys.sort(), [...sessionsNames].sort());
	assert.equal(counter, 0, "工厂方法未被调用，计数器应为零（证明值为真实函数）");
	const removed = sessionsNames[0];
	delete fixture[removed];
	const pickedAfterRemoval = SESSIONS_GROUP_KEYS.flatMap((group) => Object.keys(pickByGroup(SESSIONS[group])));
	assert.equal(pickedAfterRemoval.length, SESSIONS_METHOD_TOTAL - 1);
	assert.ok(!pickedAfterRemoval.includes(removed), "源上缺席的方法在 pick 输出中静默缺席");
});

test("F5-7 DSH 方法归属按 PLAN.md S5 裁定（查询→runtime、importDsh*/describeDsh*→import）", () => {
	const problems = [];
	for (const name of ["discoverDshModels", "getDshDefaultModel", "getDshStatus", "listDshAgentPresets", "listDshModels", "listDshProviders"]) {
		if (!SESSIONS.runtime.includes(name)) problems.push(`查询方法 ${name} 应属 runtime 组`);
	}
	for (const name of ["importDshForeignSession", "importDshRuntimeDir", "importDshRuntimeFile", "listDshForeignSessions", "searchDshSessions", "syncDshForeignSessions"]) {
		if (!SESSIONS.import.includes(name)) problems.push(`互导方法 ${name} 应属 import 组`);
	}
	// PLAN.md:202（S5 沉默清单裁定，方案确认门生效）：DSH 互导（importDsh*/describeDsh*）归 import 组。
	// 若此处红：映射数据与裁定字面不符，按 T6 执行约束不改数据、上报返工（证据附双侧行号）。
	for (const name of sessionsNames.filter((n) => n.startsWith("describeDsh")).sort()) {
		if (!SESSIONS.import.includes(name)) {
			const actualGroup = SESSIONS.runtime.includes(name) ? "runtime" : "（未分组）";
			problems.push(`${name}：S5 裁定（PLAN.md:202）要求 describeDsh* 归 import 组，实际在 ${actualGroup} 组（consolidations.ts:${lineOfNeedle(CONSOLIDATIONS_SOURCE, `"${name}"`)}；src/preload/index.ts:${sessionsLine.get(name)}）`);
		}
	}
	assert.deepEqual(problems, [], "DSH 归属与 S5 裁定不符——映射数据待返工，证据见消息");
});

test("F5-8 CONFIG_SUBSTORES 十组并集 ≡ config 命名空间 50 方法全集 + 方法族口径（FIND-4）", () => {
	assert.equal(configNames.length, CONFIG_METHOD_TOTAL, `源码解析得 ${configNames.length} 个方法`);
	assert.deepEqual(Object.keys(CONFIG).sort(), CONFIG_GROUP_KEYS);
	assert.deepEqual(validateGroupingStructure(CONFIG, CONFIG_GROUP_KEYS), []);
	assert.deepEqual(diffGroups(CONFIG, configNames), { missing: [], extra: [] });
	const familyExpectations = [
		["mcp", (n) => /mcp/i.test(n)],
		["tokendance", (n) => /tokendance/i.test(n)],
		["vision", (n) => n.startsWith("vision")],
	];
	for (const [group, inFamily] of familyExpectations) {
		assert.deepEqual(configNames.filter(inFamily).sort(), [...CONFIG[group]].sort(), `方法族口径：${group} 组必须整族收录且无外溢`);
	}
});

test("F5-9 分辨力自检（sessions）：删一法/加一法必被并集比对报出（防恒真）", () => {
	const minusOne = { ...SESSIONS, catalog: SESSIONS.catalog.slice(0, -1) };
	assert.deepEqual(diffGroups(minusOne, sessionsNames).missing, [SESSIONS.catalog.at(-1)]);
	const plusOne = { ...SESSIONS, catalog: [...SESSIONS.catalog, "phantomMethod"] };
	assert.deepEqual(diffGroups(plusOne, sessionsNames).extra, ["phantomMethod"]);
});

test("F5-10 结构负向：未知第五组与非字符串方法名必被结构校验报出", () => {
	const withFifth = { ...SESSIONS, extraGroup: ["list"] };
	assert.ok(validateGroupingStructure(withFifth, SESSIONS_GROUP_KEYS).includes("未知组: extraGroup"));
	const withNonString = { ...SESSIONS, rewind: [...SESSIONS.rewind, 42] };
	assert.ok(validateGroupingStructure(withNonString, SESSIONS_GROUP_KEYS).some((p) => p.startsWith("rewind: 非字符串方法名")));
});

test("F5-11 分辨力自检（config）：删一法/加一法必被并集比对报出（防恒真）", () => {
	const minusOne = { ...CONFIG, maintenance: CONFIG.maintenance.filter((n) => n !== "import") };
	assert.deepEqual(diffGroups(minusOne, configNames).missing, ["import"]);
	const plusOne = { ...CONFIG, trust: [...CONFIG.trust, "bogusKnob"] };
	assert.deepEqual(diffGroups(plusOne, configNames).extra, ["bogusKnob"]);
});
