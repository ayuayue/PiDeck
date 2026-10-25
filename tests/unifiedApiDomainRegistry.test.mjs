/**
 * 统一接口聚合层 · F4：main 侧域注册表与全量装配（ApiDomainRegistry + domainAssembly）。
 *
 * 用例推导：run-dir TEST-PLAN.md F4（19 例：正 8 负 11）；对应 SPEC A5-A8/A22 与
 * 沉默清单 S1（fail-fast）/S3（未注册返回 undefined）/S4（域与导入器分库共用唯一 id
 * 空间）/S6（无回滚，断言面收敛为 类型/code/domain/message 四件套）。
 * 加载生产 TS 模块用 tests/helpers/loadTsCommonJs.mjs（每个用例独立加载得到干净单例）；
 * globals 注入主 realm 的 Error，使 vm 沙箱内 extends Error 的错误类跨沙箱 instanceof 成立。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderOptions = { globals: { Error } };

function loadRegistryModule() {
	return loadTsCommonJs(path.join(repoRoot, "src/main/api/ApiDomainRegistry.ts"), loaderOptions);
}

function loadAssemblyModule() {
	return loadTsCommonJs(path.join(repoRoot, "src/main/api/domainAssembly.ts"), loaderOptions);
}

function loadSharedApi(fileName) {
	return loadTsCommonJs(path.join(repoRoot, "src/shared/api", fileName), loaderOptions);
}

/** 合法域条目（工厂构造完整对象；overrides 中的 undefined 值按显式传入处理）。 */
function validDomainEntry(overrides = {}) {
	return { id: "fixtures", group: "core", aggregation: "aggregate", manager: "FixtureManager", factory: () => ({ ok: true }), ...overrides };
}

/** 合法导入器条目。 */
function validImporterEntry(overrides = {}) {
	return { id: "fixture-importer", preloadNamespace: "fixtureSessions", channelPrefix: "fixture-sessions", capabilities: ["scan", "import"], ...overrides };
}

/** fixture deps：为 DOMAIN_CATALOG 每行生成带调用计数的 spy 工厂（懒实例化断言用）。 */
function buildFixtureDeps(domainRows) {
	const spies = [];
	const domainHandles = {};
	for (const row of domainRows) {
		const spy = () => {
			spy.calls += 1;
			return {};
		};
		spy.calls = 0;
		spies.push(spy);
		domainHandles[row.id] = spy;
	}
	return { domainHandles, spies };
}

/** 跨 vm realm 的结构比较：JSON 投影到主 realm 后 deepEqual（规避 prototype 差异误报）。 */
function plainDeepEqual(actual, expected) {
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

/** 捕获预期中的同步抛出；未抛出即失败。 */
function captureError(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	assert.fail("预期同步抛出 PiDeckApiRegistryError，但调用未抛出");
}

test("F4-1 registerDomain 合法条目注册成功，resolveDomain 返回域元数据（含 methodGroups 通路）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry({ id: "git", group: "workspace", manager: "GitService" }));
	plainDeepEqual(registry.resolveDomain("git"), { id: "git", group: "workspace", aggregation: "aggregate", manager: "GitService" });
	registry.registerDomain(validDomainEntry({ id: "consolidated" }), { catalog: ["a:b"] });
	plainDeepEqual(registry.resolveDomain("consolidated").methodGroups, { catalog: ["a:b"] });
});

test("F4-2 freeze() 后 resolveDomain 仍可解析（冻结只封写路径，不破坏读路径）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry());
	registry.freeze();
	assert.ok(registry.resolveDomain("fixtures"));
	assert.equal(registry.isFrozen(), true);
});

test("F4-3 registerImporter 合法条目成功，resolveImporter 返回能力元数据", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerImporter(validImporterEntry());
	plainDeepEqual(registry.resolveImporter("fixture-importer"), {
		id: "fixture-importer",
		preloadNamespace: "fixtureSessions",
		channelPrefix: "fixture-sessions",
		capabilities: ["scan", "import"],
	});
});

test("F4-4 错误对象形态：PiDeckApiRegistryError 是 Error 子类，携带 {code, domain?, reason}", () => {
	const { ApiDomainRegistry, PiDeckApiRegistryError } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry());
	const error = captureError(() => registry.registerDomain(validDomainEntry()));
	assert.ok(error instanceof Error);
	assert.ok(error instanceof PiDeckApiRegistryError);
	assert.equal(error.code, "PIDECK_API_DUPLICATE_DOMAIN");
	assert.equal(error.domain, "fixtures");
	assert.equal(typeof error.reason, "string");
	assert.equal(error.message, error.reason);
});

test("F4-5 registerAllDomains(fixture deps) 后全量可解析、registry 已冻结、收口域 methodGroups ≡ consolidations 落盘分组", () => {
	const assembly = loadAssemblyModule();
	const { DOMAIN_CATALOG } = loadSharedApi("domainCatalog.ts");
	const { IMPORTER_CATALOG } = loadSharedApi("importerCatalog.ts");
	const { SESSIONS_SUBDOMAINS, CONFIG_SUBSTORES } = loadSharedApi("consolidations.ts");
	assembly.registerAllDomains({ domainHandles: buildFixtureDeps(DOMAIN_CATALOG).domainHandles });
	assert.equal(assembly.unifiedApiRegistry.isFrozen(), true);
	for (const row of DOMAIN_CATALOG) {
		const resolved = assembly.unifiedApiRegistry.resolveDomain(row.id);
		assert.ok(resolved, `域 ${row.id} 装配后应可解析`);
		assert.equal(resolved.group, row.group);
		assert.equal(resolved.aggregation, row.aggregation);
		assert.equal(resolved.manager, row.manager);
	}
	for (const row of IMPORTER_CATALOG) {
		const resolved = assembly.unifiedApiRegistry.resolveImporter(row.id);
		assert.ok(resolved, `导入器 ${row.id} 装配后应可解析`);
		plainDeepEqual(resolved.capabilities, row.capabilities);
	}
	plainDeepEqual(assembly.unifiedApiRegistry.resolveDomain("sessions").methodGroups, SESSIONS_SUBDOMAINS);
	plainDeepEqual(assembly.unifiedApiRegistry.resolveDomain("config").methodGroups, CONFIG_SUBSTORES);
	assert.equal(assembly.unifiedApiRegistry.resolveDomain("git").methodGroups, undefined, "非收口域无 methodGroups");
});

test("F4-6 懒实例化：registerAllDomains 装配完毕后所有域工厂调用次数为 0（不改启动时序）", () => {
	const assembly = loadAssemblyModule();
	const { DOMAIN_CATALOG } = loadSharedApi("domainCatalog.ts");
	const { domainHandles, spies } = buildFixtureDeps(DOMAIN_CATALOG);
	assembly.registerAllDomains({ domainHandles });
	for (const spy of spies) {
		assert.equal(spy.calls, 0);
	}
});

test("F4-7 装配点形状：registerAllDomains() 恰一次（排除 import 行）、位于 registerIpc() 之后、同层裸调用未被控制流包裹", () => {
	const source = readFileSync(path.join(repoRoot, "src/main/index.ts"), "utf8");
	const lines = source.split("\n");
	const callIndexes = [];
	lines.forEach((line, index) => {
		if (line.includes("registerAllDomains(")) {
			callIndexes.push(index);
		}
	});
	const nonImportCalls = callIndexes.filter((index) => !lines[index].trimStart().startsWith("import"));
	assert.equal(nonImportCalls.length, 1, `registerAllDomains( 调用应恰一次，实际 ${nonImportCalls.length} 次`);
	const callIndex = nonImportCalls[0];
	assert.match(lines[callIndex], /^[\t ]*registerAllDomains\s*\(\s*\)\s*;[\t ]*$/, "调用语句应是无参裸调用");
	const registerIpcIndex = lines.findIndex((line) => /^[\t ]*registerIpc\s*\(\s*\)\s*;[\t ]*$/.test(line));
	assert.ok(registerIpcIndex >= 0, "registerIpc() 调用行应存在");
	assert.ok(callIndex > registerIpcIndex, "装配调用应位于 registerIpc() 之后");
	assert.equal(lines[callIndex].match(/^[\t ]*/)[0], lines[registerIpcIndex].match(/^[\t ]*/)[0], "与 registerIpc() 同层缩进（未被 if/switch/try/for 包裹）");
});

test("F4-8 A22 行数红线：src/main/api/ 每文件 ≤400 行", () => {
	for (const fileName of ["ApiDomainRegistry.ts", "domainAssembly.ts"]) {
		const lineCount = readFileSync(path.join(repoRoot, "src/main/api", fileName), "utf8").split("\n").length;
		assert.ok(lineCount <= 400, `${fileName} ${lineCount} 行，超过 400 行红线`);
	}
});

test("F4-9 同 id 二连注册：第二条抛 DUPLICATE 且 error.domain === id（S6 断言面：类型/code/domain/message）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry());
	const error = captureError(() => registry.registerDomain(validDomainEntry()));
	assert.ok(error instanceof Error);
	assert.equal(error.name, "PiDeckApiRegistryError");
	assert.equal(error.code, "PIDECK_API_DUPLICATE_DOMAIN");
	assert.equal(error.domain, "fixtures");
	assert.equal(typeof error.message, "string");
});

test("F4-10 域/导入器跨库同 id：registerDomain 后 registerImporter 同 id 抛 DUPLICATE（S4 分库共用唯一 id 空间）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry({ id: "git" }));
	const error = captureError(() => registry.registerImporter(validImporterEntry({ id: "git" })));
	assert.equal(error.code, "PIDECK_API_DUPLICATE_DOMAIN");
	assert.equal(error.domain, "git");
});

test("F4-11 冻结后 registerDomain 抛 FROZEN（A7）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.registerDomain(validDomainEntry());
	registry.freeze();
	const error = captureError(() => registry.registerDomain(validDomainEntry({ id: "another" })));
	assert.equal(error.code, "PIDECK_API_REGISTRY_FROZEN");
	assert.equal(error.domain, undefined);
});

test("F4-12 冻结后 registerImporter 抛 FROZEN（A7）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	registry.freeze();
	const error = captureError(() => registry.registerImporter(validImporterEntry()));
	assert.equal(error.code, "PIDECK_API_REGISTRY_FROZEN");
});

test("F4-13 id 空串与非 string 抛 INVALID，reason 指明 id（A8 形态一）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	for (const badId of ["", null, undefined, 42]) {
		const registry = new ApiDomainRegistry();
		const error = captureError(() => registry.registerDomain(validDomainEntry({ id: badId })));
		assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY");
		assert.match(error.reason, /id/);
	}
});

test("F4-14 id 非 kebab-case 抛 INVALID（A8 形态二；64 字符为合法上界、65 字符非法）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	for (const badId of ["Bad_ID", "UPPER", "has space", "a".repeat(65), "-leading"]) {
		const registry = new ApiDomainRegistry();
		const error = captureError(() => registry.registerDomain(validDomainEntry({ id: badId })));
		assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY", `id "${String(badId).slice(0, 12)}…" 应判非法`);
	}
	const boundary = new ApiDomainRegistry();
	boundary.registerDomain(validDomainEntry({ id: "a".repeat(64) }));
	assert.ok(boundary.resolveDomain("a".repeat(64)), "64 字符 id 应合法");
});

test("F4-15 factory 非函数抛 INVALID，reason 指明 factory（A8 形态三）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	for (const badFactory of [null, undefined, 42, "nope"]) {
		const registry = new ApiDomainRegistry();
		const error = captureError(() => registry.registerDomain(validDomainEntry({ factory: badFactory })));
		assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY");
		assert.match(error.reason, /factory/);
	}
});

test("F4-16 group 越枚举抛 INVALID，reason 指明 group（A8 形态四）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	for (const badGroup of ["unknown", undefined, "Core"]) {
		const registry = new ApiDomainRegistry();
		const error = captureError(() => registry.registerDomain(validDomainEntry({ group: badGroup })));
		assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY");
		assert.match(error.reason, /group/);
	}
});

test("F4-17 resolveDomain 未注册 id 返回 undefined、不抛出（S3）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const registry = new ApiDomainRegistry();
	assert.equal(registry.resolveDomain("not-registered"), undefined);
	assert.equal(registry.resolveImporter("not-registered"), undefined);
});

test("F4-18 registerImporter 坏条目：未知能力/空 preloadNamespace/空 channelPrefix 抛 INVALID（A8）", () => {
	const { ApiDomainRegistry } = loadRegistryModule();
	const cases = [
		{ entry: validImporterEntry({ capabilities: ["scan", "teleport"] }), field: /capabilities/ },
		{ entry: validImporterEntry({ preloadNamespace: "" }), field: /preloadNamespace/ },
		{ entry: validImporterEntry({ channelPrefix: "" }), field: /channelPrefix/ },
	];
	for (const { entry, field } of cases) {
		const registry = new ApiDomainRegistry();
		const error = captureError(() => registry.registerImporter(entry));
		assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY");
		assert.match(error.reason, field);
	}
});

test("F4-19 S1 fail-fast：registerAllDomains 遇坏 deps（域工厂非函数）同步抛出、不捕获、无回滚", () => {
	const assembly = loadAssemblyModule();
	const { DOMAIN_CATALOG } = loadSharedApi("domainCatalog.ts");
	const midRow = DOMAIN_CATALOG[Math.floor(DOMAIN_CATALOG.length / 2)];
	const error = captureError(() => assembly.registerAllDomains({ domainHandles: { [midRow.id]: 42 } }));
	assert.ok(error instanceof Error);
	assert.equal(error.code, "PIDECK_API_INVALID_DOMAIN_ENTRY");
	assert.match(error.reason, /factory/);
	assert.equal(assembly.unifiedApiRegistry.isFrozen(), false, "装配中断未冻结");
	assert.ok(assembly.unifiedApiRegistry.resolveDomain(DOMAIN_CATALOG[0].id), "无回滚（S6）：已注册的前序条目保留");
});
