import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	compareSemver,
	isAppVersionCompatible,
	selectRuntime,
	selectRelease,
	collectRecyclableRuntimes,
} = loadTsCommonJs("src/shared/types/dshRuntimeManifest.ts");

const {
	DshRuntimeManager,
	isSafeArchiveEntry,
	readRuntimeManifest,
	sha256OfFile,
} = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeManager.ts");

// ── 语义版本比较 ──

test("compareSemver：数字段逐段比较，缺位按 0 补齐", () => {
	assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
	assert.equal(compareSemver("0.7", "0.7.0"), 0, "0.7 与 0.7.0 等价");
	assert.equal(compareSemver("0.7.10", "0.7.9"), 1, "10 > 9，不能按字符串比较");
	assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
});

test("compareSemver：正式版大于同版本预发布；预发布按段比较", () => {
	assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
	assert.equal(compareSemver("0.1.1-rc.2", "0.1.1"), -1);
	assert.equal(compareSemver("0.1.1-rc.2", "0.1.1-rc.10"), -1, "预发布内的数字按数值比");
	assert.equal(compareSemver("0.1.1-beta", "0.1.1-rc.1"), -1);
});

// ── 兼容区间 ──

const manifest = (over = {}) => ({
	schemaVersion: 1,
	runtimeVersion: "0.1.1-rc.2",
	builtByAppVersion: "0.7.2",
	minAppVersion: "0.7.0",
	maxAppVersion: "0.9.0",
	archiveSha256: "deadbeef",
	requiredPackages: [],
	packageCount: 1,
	...over,
});

test("isAppVersionCompatible：下界含、上界不含", () => {
	assert.equal(isAppVersionCompatible("0.7.0", manifest()), true, "minAppVersion 含");
	assert.equal(isAppVersionCompatible("0.8.99", manifest()), true);
	assert.equal(isAppVersionCompatible("0.9.0", manifest()), false, "maxAppVersion 不含");
	assert.equal(isAppVersionCompatible("0.6.9", manifest()), false);
});

test("isAppVersionCompatible：maxAppVersion 空串 = 不设上限；schema 不认识一律不兼容", () => {
	assert.equal(isAppVersionCompatible("99.0.0", manifest({ maxAppVersion: "" })), true);
	assert.equal(isAppVersionCompatible("0.7.5", manifest({ schemaVersion: 999 })), false);
});

test("selectRuntime：在兼容版本里选最新的，更新但不兼容的版本被跳过", () => {
	const runtimes = [
		{ dirName: "0.1.0", manifest: manifest({ runtimeVersion: "0.1.0" }) },
		{ dirName: "0.1.1-rc.2", manifest: manifest({ runtimeVersion: "0.1.1-rc.2" }) },
		// 更新，但要求 app >= 0.9 —— 当前 app 0.7.5 不满足，必须被跳过
		{ dirName: "0.2.0", manifest: manifest({ runtimeVersion: "0.2.0", minAppVersion: "0.9.0", maxAppVersion: "" }) },
	];
	const picked = selectRuntime(runtimes, "0.7.5");
	assert.equal(picked.dirName, "0.1.1-rc.2");
	// app 升级到 0.9.0 后，0.2.0 才成为候选且被选中
	assert.equal(selectRuntime(runtimes, "0.9.0").dirName, "0.2.0");
});

test("collectRecyclableRuntimes：保留最新兼容版与指定版本，其余可回收", () => {
	const runtimes = [
		{ dirName: "0.1.0", manifest: manifest({ runtimeVersion: "0.1.0" }) },
		{ dirName: "0.1.1-rc.2", manifest: manifest({ runtimeVersion: "0.1.1-rc.2" }) },
		{ dirName: "broken-dir", manifest: manifest({ runtimeVersion: "0.0.1", schemaVersion: 999 }) },
	];
	const recyclable = collectRecyclableRuntimes(runtimes, "0.7.5");
	assert.equal(recyclable.includes("0.1.1-rc.2"), false, "最新兼容版必须保留");
	assert.equal(recyclable.includes("0.1.0"), true, "旧的兼容版可回收");
	assert.equal(recyclable.includes("broken-dir"), true, "清单不可用的目录可回收");
});

test("selectRelease：与 selectRuntime 同样按兼容区间 + 取最新", () => {
	const releases = [
		{ runtimeVersion: "0.1.0", minAppVersion: "0.7.0", maxAppVersion: "", url: "a", sha256: "a", size: 1 },
		{ runtimeVersion: "0.1.1", minAppVersion: "0.7.0", maxAppVersion: "0.8.0", url: "b", sha256: "b", size: 1 },
	];
	assert.equal(selectRelease(releases, "0.7.5").runtimeVersion, "0.1.1");
	// 0.8.0 时 0.1.1 超出上界，只剩 0.1.0
	assert.equal(selectRelease(releases, "0.8.0").runtimeVersion, "0.1.0");
	assert.equal(selectRelease(releases, "0.6.0"), undefined, "没有任何兼容版本");
});

// ── 归档条目安全（tar slip）──

test("isSafeArchiveEntry 拒绝绝对路径与 ../ 逃逸", () => {
	const dest = "C:/data/runtimes/dsh";
	assert.equal(isSafeArchiveEntry(dest, "node_modules/x/index.js"), true);
	assert.equal(isSafeArchiveEntry(dest, "../outside.js"), false);
	assert.equal(isSafeArchiveEntry(dest, "a/../../b.js"), false);
	assert.equal(isSafeArchiveEntry(dest, "/etc/passwd"), false);
	assert.equal(isSafeArchiveEntry(dest, "C:/Windows/system32/x.dll"), false);
});

// ── 管理器：真实临时目录 + 替身解压/下载 ──

/** 造一个「已解压好的 runtime」目录（含 manifest 与 requiredPackages）。 */
function stageRuntime(root, { version = "0.1.1-rc.2", packages = ["@deepseek-ai/dsh-base"], over = {} } = {}) {
	mkdirSync(root, { recursive: true });
	for (const pkg of packages) {
		mkdirSync(join(root, "node_modules", pkg), { recursive: true });
		writeFileSync(join(root, "node_modules", pkg, "package.json"), "{}");
	}
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify(manifest({ runtimeVersion: version, requiredPackages: packages, ...over })),
	);
}

function makeManager(over = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsh-rt-"));
	const layout = {
		runtimesRoot: join(root, "runtimes", "dsh"),
		tempRoot: join(root, "runtimes", ".tmp"),
	};
	const manager = new DshRuntimeManager({
		layout,
		appVersion: () => "0.7.5",
		...over,
	});
	return { manager, layout, root };
}

test("installFromArchive：校验通过后原子落位，版本目录可用", async () => {
	const { manager, layout, root } = makeManager({
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"));
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, true);
	assert.equal(result.dirName, "0.1.1-rc.2");
	// 归档约定：顶层 dsh-runtime/ 被剥掉，正式目录里直接是 node_modules + manifest
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "manifest.json")), true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "node_modules")), true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "dsh-runtime")), false);
	rmSync(root, { recursive: true, force: true });
});

test("installFromArchive：sha256 不匹配时拒绝安装，且不落位", async () => {
	const { manager, layout, root } = makeManager({
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"));
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	const result = await manager.installFromArchive(archive, "0".repeat(64));
	assert.equal(result.ok, false);
	assert.equal(result.error, "sha256 mismatch");
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2")), false, "校验失败绝不能落位");
	rmSync(root, { recursive: true, force: true });
});

test("installFromArchive：sha256 正确时通过（与 node crypto 一致）", async () => {
	const { manager, root } = makeManager({
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"));
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "payload");
	const expected = createHash("sha256").update("payload").digest("hex");
	assert.equal(await sha256OfFile(archive), expected);
	const result = await manager.installFromArchive(archive, expected.toUpperCase());
	assert.equal(result.ok, true, "哈希大小写不敏感");
	rmSync(root, { recursive: true, force: true });
});

test("installFromArchive：app 版本不兼容时拒绝（防止装了用不了的 runtime）", async () => {
	const { manager, layout, root } = makeManager({
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"), { over: { minAppVersion: "9.0.0", maxAppVersion: "" } });
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, false);
	assert.equal(result.error, "app version incompatible");
	assert.equal(existsSync(layout.runtimesRoot), false);
	rmSync(root, { recursive: true, force: true });
});

test("installFromArchive：requiredPackages 缺失时拒绝（归档与清单不一致）", async () => {
	const { manager, root } = makeManager({
		extract: async (_archive, destDir) => {
			// 清单声明需要两个包，实际只放了一个
			stageRuntime(join(destDir, "dsh-runtime"), { packages: ["@deepseek-ai/dsh-base"] });
			const manifestPath = join(destDir, "dsh-runtime", "manifest.json");
			const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
			parsed.requiredPackages = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot"];
			writeFileSync(manifestPath, JSON.stringify(parsed));
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, false);
	assert.match(result.error, /required package missing/);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：已解压目录直接校验落位，不经过解压", async () => {
	const { manager, layout, root } = makeManager();
	const source = join(root, "extracted");
	stageRuntime(source);
	const result = await manager.installFromDirectory(source);
	assert.equal(result.ok, true);
	assert.equal(result.dirName, "0.1.1-rc.2");
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "manifest.json")), true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "node_modules")), true);
	// 来源目录保持不动（复制而非移动）：用户自己的解压目录不能被消费掉
	assert.equal(existsSync(source), true);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：目录内带 dsh-runtime/ 顶层包装时剥掉这一层", async () => {
	const { manager, layout, root } = makeManager();
	const parent = join(root, "parent");
	stageRuntime(join(parent, "dsh-runtime"));
	const result = await manager.installFromDirectory(parent);
	assert.equal(result.ok, true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "manifest.json")), true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "dsh-runtime")), false);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：manifest 缺失时拒绝，且不落位不残留", async () => {
	const { manager, layout, root } = makeManager();
	const source = join(root, "junk");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "readme.txt"), "not a runtime");
	const result = await manager.installFromDirectory(source);
	assert.equal(result.ok, false);
	assert.equal(result.error, "manifest missing");
	assert.equal(existsSync(layout.runtimesRoot), false, "校验失败绝不能落位");
	const leftovers = existsSync(layout.tempRoot)
		? readdirSync(layout.tempRoot).filter((name) => name.startsWith("install-"))
		: [];
	assert.deepEqual(leftovers, []);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：选中父目录且仅一个有效 runtime 子目录时自动下钻", async () => {
	// 用户报告场景：卸载后 re-import 时选中了 runtimesRoot 父级（里面残留旧版本
	// runtime + 若干无 manifest 的目录），此时目录自身校验失败。只要子目录里恰好
	// 只有一个完整 runtime，就自动下钻采用它，而不是报误导性的 manifest missing。
	const { manager, layout, root } = makeManager();
	const staleVersion = join(layout.runtimesRoot, "0.1.1-rc.1");
	stageRuntime(staleVersion, { over: { runtimeVersion: "0.1.1-rc.1" } });
	mkdirSync(join(layout.runtimesRoot, "old-backup"), { recursive: true });
	const result = await manager.installFromDirectory(layout.runtimesRoot);
	assert.equal(result.ok, true);
	assert.equal(result.dirName, "0.1.1-rc.1");
	assert.equal(
		existsSync(join(layout.runtimesRoot, "0.1.1-rc.1", "manifest.json")),
		true,
		"下钻后仍应落到正式版本目录",
	);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：父目录有多个候选子目录时不猜，保持原错误", async () => {
	// 两义场景：多个子目录都含 manifest 时无法断定用户意图，必须拒绝而非误装。
	const { manager, layout, root } = makeManager();
	stageRuntime(join(layout.runtimesRoot, "0.1.1-rc.1"), { over: { runtimeVersion: "0.1.1-rc.1" } });
	stageRuntime(join(layout.runtimesRoot, "0.1.1-rc.2"));
	const result = await manager.installFromDirectory(layout.runtimesRoot);
	assert.equal(result.ok, false);
	assert.equal(result.error, "manifest missing");
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：同源目录卸载后重导成功（复制不破坏来源）", async () => {
	// 用户报告的完整环：目录导入 → 卸载 → 再次导入同一源目录。installFromDirectory
	// 是复制而非移动，源目录的 manifest 必须始终完好。
	const { manager, layout, root } = makeManager();
	const source = join(root, "user-runtime");
	stageRuntime(source);
	assert.equal((await manager.installFromDirectory(source)).ok, true);
	await manager.uninstall("0.1.1-rc.2");
	assert.equal(
		existsSync(join(source, "manifest.json")),
		true,
		"卸载后源目录的 manifest 不能被顺带删除",
	);
	const again = await manager.installFromDirectory(source);
	assert.equal(again.ok, true);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "manifest.json")), true);
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：app 版本不兼容时拒绝（防止装了用不了的 runtime）", async () => {
	const { manager, root } = makeManager();
	const source = join(root, "extracted");
	stageRuntime(source, { over: { minAppVersion: "9.0.0", maxAppVersion: "" } });
	const result = await manager.installFromDirectory(source);
	assert.equal(result.ok, false);
	assert.equal(result.error, "app version incompatible");
	rmSync(root, { recursive: true, force: true });
});

test("installFromDirectory：路径不存在或不是目录时返回明确错误", async () => {
	const { manager, root } = makeManager();
	assert.equal((await manager.installFromDirectory(join(root, "nope"))).error, "directory not found");
	const file = join(root, "a-file");
	writeFileSync(file, "x");
	assert.equal((await manager.installFromDirectory(file)).error, "directory not found");
	rmSync(root, { recursive: true, force: true });
});

test("installFromArchive：解压抛错时失败，且暂存目录被清理（不留残骸）", async () => {
	const { manager, layout, root } = makeManager({
		extract: async (_archive, destDir) => {
			mkdirSync(join(destDir, "partial"), { recursive: true });
			throw new Error("boom");
		},
	});
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, false);
	assert.equal(result.error, "boom");
	// 失败后暂存根目录下不应残留 install-* 目录（半截解压产物会占着 userData）
	const leftovers = existsSync(layout.tempRoot)
		? readdirSync(layout.tempRoot).filter((name) => name.startsWith("install-"))
		: [];
	assert.deepEqual(leftovers, []);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2")), false, "失败时不能落位");
	rmSync(root, { recursive: true, force: true });
});

test("installFromUrl：下载后走同一条校验链路，临时归档被清理", async () => {
	const { manager, layout, root } = makeManager({
		download: async (url, destPath) => {
			assert.equal(url, "https://example.test/r.tgz");
			writeFileSync(destPath, "payload");
		},
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"));
		},
	});
	const sha = createHash("sha256").update("payload").digest("hex");
	const phases = [];
	const result = await manager.installFromUrl("https://example.test/r.tgz", sha, {
		onPhase: (phase) => phases.push(phase),
	});
	assert.equal(result.ok, true);
	assert.deepEqual(
		phases.slice(0, phases.indexOf("finalizing") + 1),
		["downloading", "verifying", "extracting", "finalizing"],
	);
	assert.equal(existsSync(join(layout.runtimesRoot, "0.1.1-rc.2", "manifest.json")), true);
	rmSync(root, { recursive: true, force: true });
});

test("resolveActive 按兼容区间选版本；uninstall 后回到未安装", async () => {
	const { manager, layout, root } = makeManager({
		extract: async (_archive, destDir) => {
			stageRuntime(join(destDir, "dsh-runtime"));
		},
	});
	assert.equal(manager.resolveActive(), undefined, "空目录没有可启用版本");
	const archive = join(root, "in.tgz");
	writeFileSync(archive, "fake");
	await manager.installFromArchive(archive);
	const active = manager.resolveActive();
	assert.equal(active.dirName, "0.1.1-rc.2");
	assert.equal(active.nodeModules, join(layout.runtimesRoot, "0.1.1-rc.2", "node_modules"));
	assert.equal(await manager.uninstall("0.1.1-rc.2"), true);
	assert.equal(manager.resolveActive(), undefined);
	assert.equal(await manager.uninstall("0.1.1-rc.2"), false, "重复卸载返回 false");
	rmSync(root, { recursive: true, force: true });
});

test("readRuntimeManifest：清单损坏或缺失返回 undefined（按未安装处理）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-man-"));
	assert.equal(readRuntimeManifest(join(root, "nope"), "0.7.5"), undefined);
	mkdirSync(join(root, "broken"), { recursive: true });
	writeFileSync(join(root, "broken", "manifest.json"), "{not json");
	assert.equal(readRuntimeManifest(join(root, "broken"), "0.7.5"), undefined);
	stageRuntime(join(root, "good"));
	const read = readRuntimeManifest(join(root, "good"), "0.7.5");
	assert.equal(read.compatible, true);
	assert.equal(read.manifest.runtimeVersion, "0.1.1-rc.2");
	rmSync(root, { recursive: true, force: true });
});
