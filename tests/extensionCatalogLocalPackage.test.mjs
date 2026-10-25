import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 本地路径包（pi install <dir>）回归：pi list 对这类包的 source 是不带协议前缀的裸路径。
 * 旧实现只认 npm:/file:/git:/github:/http(s): 前缀，整行被丢弃（扩展页看不到包），
 * 且卸载会把路径当成 ~/.pi/agent/extensions 里的文件名去删。
 *
 * 生产模块走 createTsSandbox（禁止手写 vm 加载器）：相对 import 由 helper 按源文件目录解析，
 * 桌面副作用（回收站 / 日志 / PiProcess / electron.net）按 specifier 打桩，与
 * tests/extensionManager.test.mjs 同一套桩。
 */
const loadProductionTs = createTsSandbox({
	stubs: {
		"../fs/trash": { trashPath: (path) => rm(path, { recursive: true, force: true }) },
		"../logging/sharedLogger": { getAppLogger: () => null },
		"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		electron: { net: { fetch: (...args) => globalThis.fetch(...args) } },
	},
	globals: { fetch: (...args) => globalThis.fetch(...args) },
});

/** 共享判据（唯一真值）：测试用它做交叉断言，证明主进程判定与资源层同源。 */
const sharedSources = loadTsCommonJs("src/shared/piPackageSource.ts");

const loadCatalogModule = () => loadProductionTs("src/main/extensions/piExtensionCatalog.ts");
const loadExtensionManagerModule = () => loadProductionTs("src/main/extensions/ExtensionManager.ts");

/** 把 vm 沙箱里的行拷回宿主 realm：跨原型的 deepStrictEqual 必败。 */
const plainRow = (extension) => ({
	id: extension.id,
	source: extension.source,
	path: extension.path ?? null,
	local: extension.local ?? null,
	filtered: extension.filtered ?? null,
	scope: extension.scope,
});

/** 造一个只记录命令的管理器：runPi 全部打桩，不 spawn 真实 pi。 */
function createRecordingManager(commands, options = {}) {
	const version = options.version ?? "1.0.0";
	const { ExtensionManager } = loadExtensionManagerModule();
	const manager = new ExtensionManager(
		{
			check: async () => ({ installed: true, version }),
			createInvocation: (command, args) => ({ command, args, shell: false }),
			createProcessEnv: () => ({}),
			warmWslCommand: async () => undefined,
		},
		() => ({}),
		() => ({}),
		async () => ({}),
		(key) => key,
	);
	manager.runPi = async (args) => {
		commands.push([...args]);
		return "ok";
	};
	return manager;
}

test("parsePiListOutput 保留 pi install 的本地目录包：source 与 path 正确且标记 local", () => {
	const { parsePiListOutput } = loadCatalogModule();
	const raw = ["User packages:", "  npm:pi-tracker", "    C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\pi-tracker", "  F:\\dsh-office-skills", "    F:\\dsh-office-skills", ""].join("\n");

	const rows = Array.from(parsePiListOutput(raw), plainRow);
	assert.deepEqual(rows, [
		{ id: "user:npm:pi-tracker", source: "npm:pi-tracker", path: "C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\pi-tracker", local: null, filtered: null, scope: "user" },
		// 旧实现把这一整行丢掉：路径型 source 不带协议前缀，扩展页永远看不到该包。
		{ id: "user:F:\\dsh-office-skills", source: "F:\\dsh-office-skills", path: "F:\\dsh-office-skills", local: true, filtered: null, scope: "user" },
	]);
});

test("parsePiListOutput 覆盖盘符/相对/POSIX 绝对/UNC 四种路径型 source（CRLF 也要容忍）", () => {
	const { parsePiListOutput } = loadCatalogModule();
	const raw = ["Project packages:", "  ./pkg", "    ./pkg", "  ../sibling-pkg", "    ../sibling-pkg", "  /opt/pkg", "    /opt/pkg", "  \\\\srv\\share\\pkg", "    \\\\srv\\share\\pkg", ""].join("\r\n");

	const rows = Array.from(parsePiListOutput(raw), plainRow);
	assert.deepEqual(rows, [
		{ id: "project:./pkg", source: "./pkg", path: "./pkg", local: true, filtered: null, scope: "project" },
		{ id: "project:../sibling-pkg", source: "../sibling-pkg", path: "../sibling-pkg", local: true, filtered: null, scope: "project" },
		{ id: "project:/opt/pkg", source: "/opt/pkg", path: "/opt/pkg", local: true, filtered: null, scope: "project" },
		{ id: "project:\\\\srv\\share\\pkg", source: "\\\\srv\\share\\pkg", path: "\\\\srv\\share\\pkg", local: true, filtered: null, scope: "project" },
	]);
});

test("路径型 source 与 (filtered) 组合：后缀剥离，同时标记 local 与 filtered", () => {
	const { parsePiListOutput, FILTERED_SUFFIX } = loadCatalogModule();
	assert.equal(FILTERED_SUFFIX, " (filtered)");
	const raw = ["User packages:", "  F:\\dsh-office-skills (filtered)", "    F:\\dsh-office-skills", "  ./pkg (filtered)", "    ./pkg", ""].join("\n");

	const rows = Array.from(parsePiListOutput(raw), plainRow);
	assert.deepEqual(rows, [
		// source 必须是剥离后缀后的干净路径：pi remove 与版本读取都以它为参数。
		{ id: "user:F:\\dsh-office-skills", source: "F:\\dsh-office-skills", path: "F:\\dsh-office-skills", local: true, filtered: true, scope: "user" },
		{ id: "user:./pkg", source: "./pkg", path: "./pkg", local: true, filtered: true, scope: "user" },
	]);
	assert.equal(rows[0].source.endsWith(FILTERED_SUFFIX), false);
});

test("路径型 source 后紧跟另一个包时，下一行不会被吞成本包的 path", () => {
	const { parsePiListOutput } = loadCatalogModule();
	// 本地包没有落盘路径行时，同缩进的 npm 源行必须是新包，而不是上一个包的 path。
	const raw = ["User packages:", "  F:\\pkg-a", "  npm:bbb", "    C:\\ext\\bbb", ""].join("\n");

	const rows = Array.from(parsePiListOutput(raw), plainRow);
	assert.deepEqual(rows, [
		{ id: "user:F:\\pkg-a", source: "F:\\pkg-a", path: null, local: true, filtered: null, scope: "user" },
		{ id: "user:npm:bbb", source: "npm:bbb", path: "C:\\ext\\bbb", local: null, filtered: null, scope: "user" },
	]);
});

test("npm / git / url 行行为不变：source 原样、不带 local、filtered 标记照旧", () => {
	const { parsePiListOutput } = loadCatalogModule();
	const raw = ["User packages:", "  npm:pi-web-access (filtered)", "    C:\\ext\\pi-web-access", "  github:owner/repo", "    C:\\ext\\repo", "  https://example.invalid/pkg.tgz", "    C:\\ext\\pkg", ""].join("\n");

	const rows = Array.from(parsePiListOutput(raw), plainRow);
	assert.deepEqual(rows, [
		{ id: "user:npm:pi-web-access", source: "npm:pi-web-access", path: "C:\\ext\\pi-web-access", local: null, filtered: true, scope: "user" },
		{ id: "user:github:owner/repo", source: "github:owner/repo", path: "C:\\ext\\repo", local: null, filtered: null, scope: "user" },
		{ id: "user:https://example.invalid/pkg.tgz", source: "https://example.invalid/pkg.tgz", path: "C:\\ext\\pkg", local: null, filtered: null, scope: "user" },
	]);
});

test("扩展页展示的本地包版本取自包自身 package.json，不查 registry / 不产生 hasUpdate", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-ext-local-version-"));
	try {
		const packageDir = join(home, "dsh-office-skills");
		await mkdir(packageDir, { recursive: true });
		await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "dsh-office-skills", version: "0.3.1" }), "utf8");

		const manager = createRecordingManager([]);
		let registryQueries = 0;
		const resolveLatestVersion = async () => {
			registryQueries += 1;
			return "9.9.9";
		};

		const fromFlag = await manager.catalog.enrichExtensionVersion({ id: "user:" + packageDir, source: packageDir, path: packageDir, scope: "user", local: true }, resolveLatestVersion);
		assert.equal(fromFlag.currentVersion, "0.3.1");
		assert.equal(fromFlag.latestVersion, undefined, "本地包没有 registry 侧最新版本");
		assert.equal(fromFlag.hasUpdate, undefined, "本地包不得凭猜测报有更新");
		assert.equal(fromFlag.updateError, undefined);

		// source 形态兜底：即使行没有 local 标记（非 parsePiListOutput 构造），路径型 source 同样走本地逻辑。
		const fromSource = await manager.catalog.enrichExtensionVersion({ id: "user:" + packageDir, source: packageDir, path: packageDir, scope: "user" }, resolveLatestVersion);
		assert.equal(fromSource.currentVersion, "0.3.1");
		assert.equal(registryQueries, 0, "本地包绝不能触发 npm registry / npm view 查询");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("isLocalFileExtensionSource 只把裸文件名当 extensions 目录内的本地文件", () => {
	const { isLocalFileExtensionSource } = loadExtensionManagerModule();
	for (const bare of ["pi-deck-demo-plugin.ts", "orca-agent-status.ts", "my-extension", "pi-deck-todo.ts"]) {
		assert.equal(isLocalFileExtensionSource(bare), true, bare + " 是 extensions 目录里的裸文件名");
	}
	for (const notBare of ["F:\\x", "F:/x", "./x", "../x", "/x", "\\\\srv\\x", "npm:pi-tracker", "git:https://example.invalid/x.git", "github:owner/repo", "https://example.invalid/pkg.tgz", "file:./x"]) {
		assert.equal(isLocalFileExtensionSource(notBare), false, notBare + " 是 pi packages 条目，不是本地文件");
	}
	// 与共享判据同源：避免主进程判定和资源层各写一套正则后漂移。
	for (const value of ["F:\\x", "./x", "/x", "\\\\srv\\x", "npm:x", "pi-deck-demo-plugin.ts"]) {
		assert.equal(isLocalFileExtensionSource(value), !sharedSources.isPackageSource(value), value + " 与 shared/piPackageSource 不一致");
	}
});

test("uninstall：路径型 source 走 pi remove（保留 scope/projectRoot），绝不删 extensions 目录里的同名文件", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-ext-local-uninstall-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		// 旧实现的诱饵：basename(F:\dsh-office-skills) === dsh-office-skills，会被拼成
		// ~/.pi/agent/extensions/dsh-office-skills 删掉（路径根本不存在，卸载必然失败）。
		const decoy = join(extensionsDir, "dsh-office-skills");
		await writeFile(decoy, "export default {};", "utf8");

		const commands = [];
		const runOptions = [];
		const manager = createRecordingManager(commands);
		manager.wslEnvironment = { windowsHome: home };
		const recordCommand = manager.runPi;
		manager.runPi = async (args, timeout, options) => {
			runOptions.push(options ?? null);
			return recordCommand(args, timeout, options);
		};

		await manager.uninstall("F:\\dsh-office-skills");
		assert.deepEqual(commands, [["remove", "F:\\dsh-office-skills"]], "路径型 source 必须交给 pi remove");
		await readFile(decoy, "utf8");

		// 项目层卸载保持既有语义：-l + 项目 cwd + projectInstall。
		await manager.uninstall("F:\\project-pkg", "project", { projectRoot: join(home, "proj") });
		assert.deepEqual(commands[1], ["remove", "F:\\project-pkg", "-l"]);
		assert.equal(runOptions[1].projectInstall, true);
		assert.equal(runOptions[1].cwd, join(home, "proj"));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("updateExtension：路径型 source 走 pi update --extensions，npm source 仍是 pi update <source>", async () => {
	const commands = [];
	const manager = createRecordingManager(commands);

	const localResult = await manager.updateExtension("F:\\dsh-office-skills");
	assert.deepEqual(commands, [["update", "--extensions"]], "路径型 source 不能走 pi update <本地路径>（语义不稳定）");
	assert.equal(localResult.command, "pi update --extensions", "结果里的 command 必须如实反映实际执行的命令");
	assert.equal(localResult.updated, true);

	await manager.updateExtension("npm:pi-tracker");
	assert.deepEqual(commands[1], ["update", "npm:pi-tracker"], "协议源行为不变");
	assert.equal(commands.length, 2);
});
