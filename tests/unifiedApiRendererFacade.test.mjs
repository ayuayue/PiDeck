/**
 * F7 · 渲染层门面组合测试（TEST-PLAN §F7，9 例=7 正+2 负）。
 *
 * 以数据表驱动 fixture（工厂按 SESSIONS_SUBDOMAINS/CONFIG_SUBSTORES/IMPORTER_FACADE_METHODS
 * 生成完整命名空间），验证 composeUnifiedApi：接线覆盖（A2）、聚合/红线域引用恒等透传、
 * 收口域按分组重组且方法引用恒等、纯函数性、S3 缺失静默缺席。
 * 注：loadTsCommonJs 产物来自 vm 沙箱（跨 realm），键集比较一律用排序 join 字符串，
 * deepStrictEqual 仅用于同 realm 的两次 compose 结果。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { composeUnifiedApi } = loadTsCommonJs("src/shared/api/composeFacade.ts");
const { DOMAIN_CATALOG } = loadTsCommonJs("src/shared/api/domainCatalog.ts");
const { SESSIONS_SUBDOMAINS, CONFIG_SUBSTORES } = loadTsCommonJs("src/shared/api/consolidations.ts");
const { IMPORTER_CATALOG, IMPORTER_FACADE_METHODS, IMPORTER_NAMESPACES } = loadTsCommonJs("src/shared/api/importerCatalog.ts");

/** 完整源 fixture 工厂：目录表驱动的命名空间 + 每方法唯一函数（供引用恒等断言）。 */
function buildFullSource() {
	const source = {};
	const ensureNs = (ns) => {
		if (!(ns in source)) source[ns] = {};
		return source[ns];
	};
	for (const row of DOMAIN_CATALOG) for (const ns of row.preloadNamespaces) ensureNs(ns);
	for (const row of IMPORTER_CATALOG) ensureNs(IMPORTER_NAMESPACES[row.id]);
	const attach = (target, methods, tag) => {
		for (const method of methods) target[method] = () => `${tag}:${method}`;
	};
	for (const group of Object.keys(SESSIONS_SUBDOMAINS)) attach(source.sessions, SESSIONS_SUBDOMAINS[group], `sessions/${group}`);
	for (const store of Object.keys(CONFIG_SUBSTORES)) attach(source.config, CONFIG_SUBSTORES[store], `config/${store}`);
	for (const row of IMPORTER_CATALOG) attach(ensureNs(IMPORTER_NAMESPACES[row.id]), IMPORTER_FACADE_METHODS[row.id], row.id);
	source.git = { listBranches: () => "git:listBranches", watchRefs: () => "git:watchRefs" };
	return source;
}

const sortedJoin = (obj) => Object.keys(obj).sort().join(",");

const source = buildFullSource();
const piDeckApi = composeUnifiedApi(source);

test("F7-1 接线验收：DOMAIN_CATALOG 全部 aggregate/consolidate 域在 piDeckApi 有对应键；11 导入器齐备", () => {
	for (const row of DOMAIN_CATALOG) {
		if (row.aggregation !== "aggregate" && row.aggregation !== "consolidate") continue;
		for (const ns of row.preloadNamespaces) assert.ok(ns in piDeckApi, `接线缺失：${row.id} 行的命名空间 ${ns} 未出现在 piDeckApi`);
	}
	for (const row of IMPORTER_CATALOG) {
		const importerView = piDeckApi.importers[row.id];
		assert.ok(importerView, `importers.${row.id} 缺失`);
		for (const method of IMPORTER_FACADE_METHODS[row.id]) assert.ok(method in importerView, `importers.${row.id}.${method} 缺失`);
	}
});

test("F7-2 聚合域恒等透传：Object.is(piDeckApi[ns], source[ns])，git 显式抽样", () => {
	for (const row of DOMAIN_CATALOG) {
		if (row.aggregation !== "aggregate") continue;
		for (const ns of row.preloadNamespaces) assert.ok(Object.is(piDeckApi[ns], source[ns]), `${ns} 未恒等透传`);
	}
	assert.equal(piDeckApi.git, source.git);
	// 伴生行：web 域键取 settings 命名空间引用（domainCatalog web 行裁决）。
	assert.ok(Object.is(piDeckApi.web, source.settings), "web 键必须伴生透传 settings 命名空间");
});

test("F7-3 红线域恒等透传：pi / piAuth / enhance 只取原命名空间引用", () => {
	assert.equal(piDeckApi.pi, source.pi);
	assert.equal(piDeckApi.piAuth, source.piAuth);
	assert.equal(piDeckApi.enhance, source.enhance);
});

test("F7-4 sessions 四子域运行时键集 ≡ SESSIONS_SUBDOMAINS 分组", () => {
	assert.equal(sortedJoin(piDeckApi.sessions), sortedJoin(SESSIONS_SUBDOMAINS));
	for (const group of Object.keys(SESSIONS_SUBDOMAINS)) {
		assert.equal(sortedJoin(piDeckApi.sessions[group]), [...SESSIONS_SUBDOMAINS[group]].sort().join(","), `sessions.${group} 键集漂移`);
	}
});

test("F7-5 sessions 子域方法引用恒等：每方法 === source.sessions 同名方法", () => {
	for (const group of Object.keys(SESSIONS_SUBDOMAINS)) {
		for (const method of SESSIONS_SUBDOMAINS[group]) {
			assert.ok(Object.is(piDeckApi.sessions[group][method], source.sessions[method]), `sessions.${group}.${method} 非源引用`);
		}
	}
});

test("F7-6 config 子库重组键集 ≡ CONFIG_SUBSTORES", () => {
	assert.equal(sortedJoin(piDeckApi.config), sortedJoin(CONFIG_SUBSTORES));
	for (const store of Object.keys(CONFIG_SUBSTORES)) {
		assert.equal(sortedJoin(piDeckApi.config[store]), [...CONFIG_SUBSTORES[store]].sort().join(","), `config.${store} 键集漂移`);
	}
});

test("F7-7 纯函数性：同一 source 两次 compose 输出同构且键值同引用", () => {
	const again = composeUnifiedApi(source);
	assert.deepStrictEqual(again, piDeckApi);
	assert.ok(Object.is(again.git, piDeckApi.git), "两次 compose 的 git 应同为源引用");
	assert.ok(Object.is(again.sessions.catalog.list, piDeckApi.sessions.catalog.list), "两次 compose 的子域方法应同为源引用");
});

test("F7-8[负] S3：缺失/未知命名空间 → undefined 不 throw；分组缺失方法静默缺席", () => {
	const partial = { git: { listBranches: () => {} } };
	let view = null;
	assert.doesNotThrow(() => {
		view = composeUnifiedApi(partial);
	});
	assert.ok(Object.is(view.git, partial.git), "存在的命名空间仍恒等透传");
	assert.equal(view.system, undefined, "缺失命名空间必须 undefined（S3）");
	assert.equal(view.somethingUnknown, undefined, "未知键必须 undefined（S3）");
	assert.equal(sortedJoin(view.sessions.catalog), "", "分组数据缺失的方法不得出现在输出（A14 静默缺席）");
	const sparse = { sessions: { list: () => {} } };
	const sparseView = composeUnifiedApi(sparse);
	assert.equal(sortedJoin(sparseView.sessions.catalog), "list", "sessions 仅 list 时 catalog 子域只含 list");
});

test("F7-9[负] 子域对象不出现分组之外的新键（无包装无聚合扩展）", () => {
	const withRogue = { ...source, sessions: { ...source.sessions, rogueMethod: () => {} } };
	const rogueView = composeUnifiedApi(withRogue);
	const groupMethods = new Set();
	for (const group of Object.keys(SESSIONS_SUBDOMAINS)) for (const method of SESSIONS_SUBDOMAINS[group]) groupMethods.add(method);
	assert.equal(groupMethods.has("rogueMethod"), false, "测试前提：rogueMethod 不在任何分组");
	for (const group of Object.keys(SESSIONS_SUBDOMAINS)) assert.equal("rogueMethod" in rogueView.sessions[group], false, `sessions.${group} 不得混入分组外方法`);
	assert.equal("rogueMethod" in piDeckApi.sessions.catalog, false, "完整源下子域也不得有分组外键");
});
