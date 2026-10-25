import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as tar from "tar";
import { load } from "js-yaml";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { validateNpmSpec, createDshPluginNpmRunner } = loadTsCommonJs("src/main/dsh/dshPluginNpmRunner.ts");
const { npmPackToDir, extractTgz, collectStaticJsImports, nestDependencyClosure } = loadTsCommonJs("src/main/dsh/dshPluginTarball.ts");
const { marketEntryLooksUiOnly, searchDshPluginMarket, validateSearchKeyword, clearMarketCatalogCache } = loadTsCommonJs("src/main/dsh/dshPluginMarket.ts");
const { DshPluginInstallService, detectUiOnlyPluginManifest, MANAGED_PLUGINS_DIRNAME } = loadTsCommonJs("src/main/dsh/DshPluginInstallService.ts");

/* ------------------------------------------------------------------ */
/* fixture：伪造插件 tgz（目录名必须 package/，与 npm pack 产物一致）      */
/* ------------------------------------------------------------------ */

function writePackageFixture(dir, manifest, files) {
	const pkgDir = join(dir, "package");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest), "utf8");
	for (const [relPath, content] of Object.entries(files ?? {})) {
		const target = join(pkgDir, relPath);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	return pkgDir;
}

function tgzFixtureName(name, version) {
	// npm pack 文件名约定：scope @a/b → a-b-1.0.0.tgz
	return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

/**
 * fake npm（runNpm 替身，禁真实网络）：
 * - pack <spec> --json --pack-destination <dir>：按 spec 映射重打包预置 fixture
 * - search --json：返回罐头结果
 */
function createFakeNpm(options = {}) {
	const packs = new Map(); // spec → { stagingDir, tgzName }
	const searchPayload = options.searchPayload ?? [];
	const calls = [];
	for (const fixture of options.fixtures ?? []) {
		packs.set(fixture.spec, fixture);
		if (fixture.name !== undefined && !packs.has(fixture.name)) packs.set(fixture.name, fixture);
	}
	const runNpm = async (args) => {
		calls.push(args);
		if (args[0] === "pack") {
			const spec = args[1];
			const packDestination = args[args.indexOf("--pack-destination") + 1];
			const fixture = packs.get(spec);
			if (fixture === undefined) {
				return { code: 1, stdout: "", stderr: `npm ERR! 404 Not Found - GET ${spec}` };
			}
			mkdirSync(packDestination, { recursive: true });
			tar.c({ sync: true, cwd: fixture.stagingDir, file: join(packDestination, fixture.tgzName) }, ["package"]);
			return { code: 0, stdout: JSON.stringify([{ filename: fixture.tgzName }]), stderr: "" };
		}
		if (args[0] === "search") {
			return { code: 0, stdout: JSON.stringify(searchPayload), stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected npm invocation: ${args.join(" ")}` };
	};
	return { runNpm, calls };
}

/** 预置 fixture 集到 registry 目录并返回 fake npm 可用的映射。 */
function stageRegistryFixtures(root) {
	const registryDir = join(root, "registry");
	const fixtures = [];
	const stage = (spec, name, version, manifest, files) => {
		const staging = join(registryDir, name.replace(/\//g, "-"), version);
		writePackageFixture(staging, { name, version, ...manifest }, files);
		const fixture = { spec, name, version, stagingDir: staging, tgzName: tgzFixtureName(name, version) };
		fixtures.push(fixture);
		return fixture;
	};
	stage(
		"dsh-plugin-fixture-hello@1.0.0",
		"dsh-plugin-fixture-hello",
		"1.0.0",
		{ main: "lib/index.js", dependencies: { "fixture-dep": "^1.0.0", "missing-dep": "^2.0.0" } },
		{
			"lib/index.js": 'import "fixture-dep";\nimport "missing-dep";\nimport "node:path";\nexport default {};\n',
		},
	);
	stage("missing-dep@^2.0.0", "missing-dep", "2.1.0", {}, { "index.js": "export const ok = 1;\n" });
	return fixtures;
}

/** 组装服务 harness（全假依赖；userData / dshHome 各自独立临时目录）。 */
function createHarness(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-install-"));
	const userDataDir = join(root, "userData");
	const dshHome = join(root, "dsh-home");
	mkdirSync(userDataDir, { recursive: true });
	mkdirSync(dshHome, { recursive: true });
	const fake = createFakeNpm(options);
	const service = new DshPluginInstallService({
		getDshHomeDir: () => dshHome,
		getUserDataDir: () => userDataDir,
		resolveRuntimeNodeModules: () => options.runtimeNodeModules,
		launcher: { createInvocation: (command, args) => ({ command, args }), createProcessEnv: () => ({}) },
		runNpm: fake.runNpm,
		fetchImpl: options.fetchImpl,
	});
	return { root, userDataDir, dshHome, service, fake };
}

/** 在 runtime node_modules 放一个可解析的依赖目录。 */
function stageRuntimeDep(root, name, version) {
	const dir = join(root, "runtime", "node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8");
	return dir;
}

/* ------------------------------------------------------------------ */
/* validateNpmSpec：IPC 边界第一道闸                                    */
/* ------------------------------------------------------------------ */

test("validateNpmSpec：接受裸包名 / scoped / name@精确版本", () => {
	// vm 沙箱产物跨 realm：逐字段断言（deepStrictEqual 会因原型不同误报）
	const bare = validateNpmSpec("dsh-plugin-foo");
	assert.equal(bare.ok, true);
	assert.equal(bare.ok === true ? bare.name : "", "dsh-plugin-foo");
	const scoped = validateNpmSpec("@scope/pkg");
	assert.equal(scoped.ok, true);
	assert.equal(scoped.ok === true ? scoped.name : "", "@scope/pkg");
	const pinned = validateNpmSpec("dsh-plugin-foo@1.2.3");
	assert.equal(pinned.ok, true);
	assert.equal(pinned.ok === true ? pinned.name : "", "dsh-plugin-foo");
	assert.equal(pinned.ok === true ? pinned.version : "", "1.2.3");
	const beta = validateNpmSpec("@scope/pkg@0.1.0-beta.1");
	assert.equal(beta.ok, true);
	assert.equal(beta.ok === true ? beta.version : "", "0.1.0-beta.1");
});

test("validateNpmSpec：拒绝路径分隔符 / range 版本 / 相对路径 / 空", () => {
	for (const bad of ["../evil", "foo\\bar", "a/b/c", "@scope/pkg@^1.0.0", "pkg@latest", "./local-dir", "pkg@1.x", "", "   "]) {
		const result = validateNpmSpec(bad);
		assert.equal(result.ok, false, `expected rejection: ${bad}`);
	}
});

/* ------------------------------------------------------------------ */
/* uiOnly 判别                                                          */
/* ------------------------------------------------------------------ */

test("detectUiOnlyPluginManifest：dsh.client 注入声明 = UI-only；host 插件与无声明 = false", () => {
	assert.equal(detectUiOnlyPluginManifest({ dsh: { client: { platform: "web" } } }), true);
	assert.equal(detectUiOnlyPluginManifest({ dsh: { client: { inject: ["browser.js"] } } }), true);
	assert.equal(detectUiOnlyPluginManifest({ name: "@scope/dsh-client-ui-voice-input" }), true);
	// 官方 host 功能插件（@deepseek-ai/dsh-experimental-agent-team 同构）：无 dsh 字段
	assert.equal(detectUiOnlyPluginManifest({ name: "dsh-plugin-some-host-tool" }), false);
	assert.equal(detectUiOnlyPluginManifest({ dsh: { host: { define: {} } } }), false);
});

test("marketEntryLooksUiOnly：命名惯例与分类双判据", () => {
	assert.equal(marketEntryLooksUiOnly("dsh-client-ui-agent-team", undefined, []), true);
	assert.equal(marketEntryLooksUiOnly("dsh-plugin-foo", "界面", []), true);
	assert.equal(marketEntryLooksUiOnly("dsh-plugin-foo", undefined, ["ui"]), true);
	assert.equal(marketEntryLooksUiOnly("dsh-plugin-foo", "tools", ["cli"]), false);
});

/* ------------------------------------------------------------------ */
/* tarball 层：pack 解析 / 解包 / import 收集 / 闭包嵌套                  */
/* ------------------------------------------------------------------ */

test("npmPackToDir：解析 --json 文件名；非零退出与恶意文件名拒绝", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-tar-"));
	try {
		const dest = join(root, "dest");
		const ok = await npmPackToDir(async () => ({ code: 0, stdout: JSON.stringify([{ filename: "pkg-1.0.0.tgz" }]), stderr: "" }), "pkg", dest);
		assert.equal(ok.filename, "pkg-1.0.0.tgz");
		assert.equal(ok.tarPath, join(dest, "pkg-1.0.0.tgz"));

		await assert.rejects(
			npmPackToDir(async () => ({ code: 1, stdout: "", stderr: "404" }), "nope", dest),
			/404/,
		);
		await assert.rejects(
			npmPackToDir(async () => ({ code: 0, stdout: JSON.stringify([{ filename: "../evil.tgz" }]), stderr: "" }), "evil", dest),
			/unexpected tarball filename/,
		);
		await assert.rejects(
			npmPackToDir(async () => ({ code: 0, stdout: "not json", stderr: "" }), "pkg", dest),
			/no tarball filename/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("extractTgz + collectStaticJsImports：strip package/ 前缀、收集裸 import", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-extract-"));
	try {
		const staging = join(root, "staging");
		writePackageFixture(
			staging,
			{ name: "p", version: "1.0.0" },
			{
				"lib/index.js": 'import "a-dep";\nimport x from "@scope/b-dep";\nimport "./sibling.js";\nconst m = await import("c-dep");\nimport "node:path";\n',
			},
		);
		const tgzPath = join(root, "p-1.0.0.tgz");
		tar.c({ sync: true, cwd: staging, file: tgzPath }, ["package"]);
		const unpacked = join(root, "unpacked");
		await extractTgz(tgzPath, unpacked);
		assert.ok(existsSync(join(unpacked, "package.json")), "package/ 前缀被 strip");
		assert.deepEqual([...collectStaticJsImports(unpacked)].sort(), ["@scope/b-dep", "a-dep", "c-dep"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nestDependencyClosure：runtime 优先嵌套、缺失走 registry pack（range 锁父清单）、闭包递归", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-nest-"));
	try {
		stageRuntimeDep(root, "fixture-dep", "1.4.0");
		// fixture-dep 的传递依赖：runtime 里也提供（闭包递归应带上）
		stageRuntimeDep(root, "nested-sub", "0.0.1");
		writeFileSync(join(root, "runtime", "node_modules", "fixture-dep", "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.4.0", dependencies: { "nested-sub": "*" } }), "utf8");

		// writePackageFixture 落在 <dir>/package：nestDependencyClosure 要的是包根（manifest 所在层）
		const pluginDir = writePackageFixture(join(root, "plugin"), { name: "plugin", version: "1.0.0", dependencies: { "fixture-dep": "^1.0.0", "missing-dep": "^2.0.0" } }, { "index.js": 'import "fixture-dep";\nimport "missing-dep";\nimport "node:fs";\n' });

		const missingStaging = join(root, "registry", "missing-dep");
		writePackageFixture(missingStaging, { name: "missing-dep", version: "2.1.0" }, { "index.js": "export {};\n" });
		const fake = createFakeNpm({ fixtures: [{ spec: "missing-dep@^2.0.0", stagingDir: missingStaging, tgzName: tgzFixtureName("missing-dep", "2.1.0") }] });

		const result = await nestDependencyClosure({ pluginDir, runtimeNodeModules: join(root, "runtime", "node_modules"), runNpm: fake.runNpm });

		assert.deepEqual([...result.missing], []);
		assert.equal(result.packedFromRegistry, 1);
		assert.ok(existsSync(join(pluginDir, "node_modules", "fixture-dep", "package.json")), "runtime 依赖嵌套");
		assert.ok(existsSync(join(pluginDir, "node_modules", "nested-sub", "package.json")), "闭包递归（传递依赖）");
		assert.ok(existsSync(join(pluginDir, "node_modules", "missing-dep", "package.json")), "registry 补齐");
		assert.ok(
			fake.calls.some((args) => args[0] === "pack" && args[1] === "missing-dep@^2.0.0"),
			"range 锁定父清单声明",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nestDependencyClosure：registry 也拿不到 → missing（不装作成功）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-nest-miss-"));
	try {
		const pluginDir = join(root, "plugin");
		writePackageFixture(pluginDir, { name: "plugin", version: "1.0.0" }, { "index.js": 'import "ghost-dep";\n' });
		const fake = createFakeNpm();
		const result = await nestDependencyClosure({ pluginDir, runNpm: fake.runNpm });
		assert.deepEqual([...result.missing], ["ghost-dep"]);
		assert.ok(!existsSync(join(pluginDir, "node_modules", "ghost-dep")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* install：行注册 / 幂等 / 恶意包名 / uiOnly                            */
/* ------------------------------------------------------------------ */

test("installUserPlugin：注册 Loader 行 + 依赖闭包自包含 + 受管目录落位", async () => {
	const fixtures = [];
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-inst-"));
	try {
		// harness 内 stage（stageRegistryFixtures 需要 root 已存在）
		fixtures.push(...stageRegistryFixtures(root));
		stageRuntimeDep(root, "fixture-dep", "1.4.0");
		const harness = createHarness({ fixtures, runtimeNodeModules: join(root, "runtime", "node_modules") });

		const result = await harness.service.installUserPlugin("dsh-plugin-fixture-hello@1.0.0");
		assert.equal(result.name, "dsh-plugin-fixture-hello");
		assert.equal(result.version, "1.0.0");
		assert.equal(result.rowId, "dsh-plugin-fixture-hello/host");
		assert.equal(result.alreadyRegistered, false);
		assert.equal(result.uiOnly, false);
		assert.ok(result.entryUrl.startsWith("file:///"), `entryUrl 是 file:// URL：${result.entryUrl}`);
		assert.ok(result.destDir.startsWith(join(harness.userDataDir, MANAGED_PLUGINS_DIRNAME)), "落位在受管根内");
		assert.ok(existsSync(join(result.destDir, "lib", "index.js")));
		assert.ok(existsSync(join(result.destDir, "node_modules", "fixture-dep", "package.json")), "runtime 依赖嵌套");
		assert.ok(existsSync(join(result.destDir, "node_modules", "missing-dep", "package.json")), "缺失依赖 registry 补齐");
		assert.deepEqual([...result.missingDeps], []);

		const doc = load(readFileSync(join(harness.dshHome, "cordis.patch.yml"), "utf8"));
		// 行结构是 {insert: [{id, name, config}]}（与官方 home 补丁层一致）：先摊平再找 id
		const row = doc.flatMap((item) => item?.insert ?? []).find((entry) => entry?.id === "dsh-plugin-fixture-hello/host");
		assert.ok(row, "补丁层含插件行");
		assert.equal(row.name, result.entryUrl);
		assert.deepEqual(row.config, {});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installUserPlugin：幂等——重复安装不再追加行；已有文件先备份", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-idem-"));
	try {
		const fixtures = stageRegistryFixtures(root);
		const harness = createHarness({ fixtures });
		const patchPath = join(harness.dshHome, "cordis.patch.yml");
		writeFileSync(patchPath, "# 用户手写补丁层\n[]\n", "utf8");
		const countRows = () =>
			load(readFileSync(patchPath, "utf8"))
				.flatMap((item) => item?.insert ?? [])
				.filter((entry) => entry?.id === "dsh-plugin-fixture-hello/host")
				.length.toString();

		const first = await harness.service.installUserPlugin("dsh-plugin-fixture-hello@1.0.0");
		assert.equal(first.alreadyRegistered, false);
		assert.equal(countRows(), "1");
		assert.ok(!readFileSync(patchPath, "utf8").includes("[]"), "空文档占位 [] 被摘除（与块式序列不能并存）");

		const second = await harness.service.installUserPlugin("dsh-plugin-fixture-hello@1.0.0");
		assert.equal(second.alreadyRegistered, true, "二次安装报告 alreadyRegistered");
		assert.equal(countRows(), "1", "行不重复");
		const backups = readdirSync(harness.dshHome).filter((name) => name.startsWith("cordis.patch.yml.bak-"));
		assert.equal(backups.length, 1, "写前备份恰好一份");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installUserPlugin：uiOnly 插件安装结果带 uiOnly=true", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-uionly-"));
	try {
		const staging = join(root, "staging", "web-widget");
		writePackageFixture(staging, { name: "dsh-plugin-fixture-web-widget", version: "0.3.0", dsh: { client: { platform: "web", inject: ["browser.js"] } } }, { "index.js": "export default {};\n" });
		const harness = createHarness({ fixtures: [{ spec: "dsh-plugin-fixture-web-widget@0.3.0", stagingDir: staging, tgzName: tgzFixtureName("dsh-plugin-fixture-web-widget", "0.3.0") }] });
		const result = await harness.service.installUserPlugin("dsh-plugin-fixture-web-widget@0.3.0");
		assert.equal(result.uiOnly, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installUserPlugin：恶意包名（../evil）触发受管根逃逸检查，不落位", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-evil-"));
	try {
		const staging = join(root, "staging", "evil");
		// pack spec 本身合法（evil-pkg），但包内 manifest.name 是 ../evil —— 落位阶段的逃逸闸
		writePackageFixture(staging, { name: "../evil", version: "1.0.0" }, { "index.js": "export {};\n" });
		const harness = createHarness({ fixtures: [{ spec: "evil-pkg", stagingDir: staging, tgzName: tgzFixtureName("evil-pkg", "1.0.0") }] });
		await assert.rejects(harness.service.installUserPlugin("evil-pkg"), /escapes managed directory/);
		const managedRoot = join(harness.userDataDir, MANAGED_PLUGINS_DIRNAME);
		// 受管根外无 evil 目录（rel 计算已拒绝；受管根内至多残留空的 .tmp 已被 finally 清理）
		assert.ok(!existsSync(join(harness.userDataDir, "evil")), "userData 根未被逃逸写入");
		assert.ok(!existsSync(join(managedRoot, "evil")), "受管根内无逃逸目录");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("installUserPlugin：非法 spec 在入口即被拒绝（不触 npm）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-badspec-"));
	try {
		const harness = createHarness({});
		await assert.rejects(harness.service.installUserPlugin("../evil"), /invalid npm package name/);
		await assert.rejects(harness.service.installUserPlugin("pkg@^1.0.0"), /exact version only/);
		assert.equal(harness.fake.calls.length, 0, "校验先于任何子进程");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* search：双源合并 / repo-only 跳过 / npm 过滤 / warnings                */
/* ------------------------------------------------------------------ */

const MARKET_PAYLOAD = [
	{ s: "dsh-plugin-market-a", vr: "1.0.0", d: "市场条目 A", c: "tools", t: [], r: { repo: "a/b", npmPackage: "dsh-plugin-market-a" } },
	{ s: "client-ui/dsh-plugin-web-widget", vr: "0.2.0", d: "Web 界面部件", c: "ui", t: ["interface"], r: { repo: "w/b", npmPackage: "client-ui-plugin-x" } },
	{ s: "repo-only-entry", vr: "0.1.0", d: "只有仓库链接", r: "someone/repo" },
	{ s: "unrelated-market", d: "desc", r: { repo: "x/y", npmPackage: "unrelated-market" } },
];

test("searchDshPluginMarket：市场 + npm 合并去重（市场优先），repo-only 跳过", async () => {
	clearMarketCatalogCache();
	const fetchImpl = async () => ({ ok: true, status: 200, json: async () => MARKET_PAYLOAD });
	const fake = createFakeNpm({
		searchPayload: [
			{ name: "dsh-plugin-market-a", version: "1.0.1", description: "npm 同名（应被市场条目去重）" },
			{ name: "dsh-plugin-from-npm", version: "2.0.0", description: "DeepSeek shell helper" },
			{ name: "totally-unrelated", version: "9.9.9", description: "a plain library with no shell ties" },
		],
	});
	const result = await searchDshPluginMarket({ keyword: "plugin", fetchImpl, runNpm: fake.runNpm });
	const names = result.entries.map((entry) => entry.name);
	assert.ok(names.includes("dsh-plugin-market-a"), "市场条目");
	assert.ok(names.includes("dsh-plugin-from-npm"), "npm 补充条目");
	assert.ok(!names.includes("repo-only-entry"), "repo-only 条目不可 npm 安装，跳过");
	assert.ok(!names.includes("unrelated-market"), "关键词过滤市场结果");
	assert.ok(!names.includes("totally-unrelated"), "npm 结果按 dsh 相关性过滤");
	assert.equal(names.filter((name) => name === "dsh-plugin-market-a").length, 1, "同名去重");
	assert.equal(result.entries.find((entry) => entry.name === "dsh-plugin-market-a").source, "market", "去重时市场优先");
	const webWidget = result.entries.find((entry) => entry.name === "client-ui-plugin-x");
	assert.ok(webWidget, "r.npmPackage 提供安装名");
	assert.equal(webWidget.uiOnly, true, "client-ui 命名/分类判 UI-only");
	assert.equal(result.warnings.length, 0);
});

test("searchDshPluginMarket：单源失败降级 warnings；双源失败抛错", async () => {
	clearMarketCatalogCache();
	const okFetch = async () => ({ ok: true, status: 200, json: async () => MARKET_PAYLOAD });
	const badFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
	const okNpm = createFakeNpm({ searchPayload: [{ name: "dsh-plugin-x", description: "dsh" }] });
	const badNpm = { runNpm: async () => ({ code: 1, stdout: "", stderr: "registry down" }) };

	const degraded = await searchDshPluginMarket({ keyword: "plugin", fetchImpl: badFetch, runNpm: okNpm.runNpm });
	assert.equal(degraded.entries.length, 1);
	assert.equal(degraded.warnings.length, 1);
	assert.match(degraded.warnings[0], /market/);

	const npmDown = await searchDshPluginMarket({ keyword: "plugin", fetchImpl: okFetch, runNpm: badNpm.runNpm });
	assert.equal(npmDown.warnings.length, 1);
	assert.match(npmDown.warnings[0], /npm/);

	// okFetch 那次已把目录拉进内存缓存：双失败断言前必须清掉，否则市场源命中缓存不会拒绝
	clearMarketCatalogCache();
	await assert.rejects(searchDshPluginMarket({ keyword: "plugin", fetchImpl: badFetch, runNpm: badNpm.runNpm }), /registry down|market/);
});

test("searchDshPluginMarket：市场目录缓存命中后不再 fetch", async () => {
	clearMarketCatalogCache();
	let fetchCount = 0;
	const countingFetch = async () => {
		fetchCount += 1;
		return { ok: true, status: 200, json: async () => MARKET_PAYLOAD };
	};
	const fake = createFakeNpm({ searchPayload: [] });
	await searchDshPluginMarket({ keyword: "plugin", fetchImpl: countingFetch, runNpm: fake.runNpm });
	await searchDshPluginMarket({ keyword: "plugin", fetchImpl: countingFetch, runNpm: fake.runNpm });
	assert.equal(fetchCount, 1, "10min TTL 内命中内存缓存");
	clearMarketCatalogCache();
});

test("validateSearchKeyword：1..80 字符、拒控制字符", () => {
	const trimmed = validateSearchKeyword("  hello ");
	assert.equal(trimmed.ok, true);
	assert.equal(trimmed.ok === true ? trimmed.value : "", "hello");
	assert.equal(validateSearchKeyword("").ok, false);
	assert.equal(validateSearchKeyword("x".repeat(81)).ok, false);
	assert.equal(validateSearchKeyword("line\nbreak").ok, false);
});

/* ------------------------------------------------------------------ */
/* listUserPlugins：受管行补全包信息                                     */
/* ------------------------------------------------------------------ */

test("listUserPlugins：受管目录内的行补全 packageName/version/uiOnly；裸行原样", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-plugin-list-"));
	try {
		const harness = createHarness({});
		const managedRoot = join(harness.userDataDir, MANAGED_PLUGINS_DIRNAME);
		const webDir = join(managedRoot, "dsh-plugin-fixture-web-widget");
		mkdirSync(webDir, { recursive: true });
		writeFileSync(join(webDir, "package.json"), JSON.stringify({ name: "dsh-plugin-fixture-web-widget", version: "0.3.0", dsh: { client: { platform: "web" } } }), "utf8");
		writeFileSync(
			join(harness.dshHome, "cordis.patch.yml"),
			["- insert:", "    - id: dsh-plugin-fixture-web-widget/host", `      name: ${pathToFileURL(join(webDir, "index.js")).href}`, "      config: {}", "", "- insert:", "    - id: manual-plugin/host", "      name: file:///elsewhere/manual-plugin/index.js", "      config: {}", ""].join("\n"),
			"utf8",
		);
		const entries = await harness.service.listUserPlugins();
		assert.equal(entries.length, 2);
		const web = entries.find((entry) => entry.rowId === "dsh-plugin-fixture-web-widget/host");
		assert.equal(web.packageName, "dsh-plugin-fixture-web-widget");
		assert.equal(web.version, "0.3.0");
		assert.equal(web.uiOnly, true);
		const manual = entries.find((entry) => entry.rowId === "manual-plugin/host");
		assert.equal(manual.packageName, undefined, "受管目录外的行保持裸 rowId/moduleName");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* npm runner：数组参数 + 不经 shell                                     */
/* ------------------------------------------------------------------ */

test("createDshPluginNpmRunner：execFile 数组传参、spawn 错误文本化、超时 kill", async () => {
	const invocations = [];
	const execFileLike = (file, args, options, callback) => {
		invocations.push({ file, args, options });
		if (args.includes("--fail-on-purpose")) {
			callback(new Error("spawn ENOENT"), "", "");
			return {};
		}
		if (args[0] === "slow") {
			// 模拟 execFile 的 timeout 语义：到点 kill 并以错误回调（真实实现由 child.kill 兜底）
			const timer = setTimeout(() => callback(new Error("spawn ETIMEDOUT"), "", ""), options.timeout ?? 5000);
			return {
				kill: () => {
					clearTimeout(timer);
					callback(new Error("spawn killed"), "", "");
				},
			};
		}
		callback(null, "ok", "");
		return {};
	};
	const runNpm = createDshPluginNpmRunner({ createInvocation: (command, args) => ({ command, args }), createProcessEnv: () => ({}) }, "npm", execFileLike);
	const ok = await runNpm(["search", "x"], { timeoutMs: 1000 });
	assert.equal(ok.code, 0);
	assert.equal(ok.stdout, "ok");
	assert.deepEqual([...invocations[0].args], ["search", "x"], "参数原样数组传递（无 shell 拼接）");
	assert.equal(invocations[0].file, "npm");

	// spawn 层错误不 reject：走结果码协议（code:-1 + stderr 带错误文本），调用方统一判 code
	const failed = await runNpm(["--fail-on-purpose"], {});
	assert.notEqual(failed.code, 0);
	assert.match(failed.stderr, /spawn ENOENT/);
	const slow = await runNpm(["slow"], { timeoutMs: 30 });
	assert.notEqual(slow.code, 0, "超时被 kill 并报告失败");
});
