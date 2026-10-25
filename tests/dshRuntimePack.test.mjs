import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as tar from "tar";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// dshRuntimeIo 依赖 electron（仅用于下载），测试里给个最小替身即可加载解压实现。
const { createTarExtractor, createNetDownloader, fetchDshRuntimeIndex } = loadTsCommonJs("src/main/dsh/runtime/dshRuntimeIo.ts", { stubs: { electron: { net: { request: () => undefined } } } });
const createFetchIndex = () => fetchDshRuntimeIndex;

const { DshRuntimeManager } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeManager.ts");

const APP_VERSION = "0.7.5";
const VERSION = "0.1.1-rc.2";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = (over = {}) => ({
	schemaVersion: 1,
	runtimeVersion: VERSION,
	builtByAppVersion: APP_VERSION,
	minAppVersion: "0.7.0",
	maxAppVersion: "",
	archiveSha256: "",
	requiredPackages: ["@deepseek-ai/dsh-base"],
	packageCount: 1,
	...over,
});

/** 造一个符合归档约定的 tgz：顶层 dsh-runtime/{manifest.json,node_modules/...}。 */
async function buildArchive(archivePath, { packages = ["@deepseek-ai/dsh-base"], manifestOver = {}, evil = false } = {}) {
	const src = mkdtempSync(join(tmpdir(), "dsh-tarsrc-"));
	mkdirSync(join(src, "node_modules"), { recursive: true });
	for (const pkg of packages) {
		mkdirSync(join(src, "node_modules", pkg), { recursive: true });
		writeFileSync(join(src, "node_modules", pkg, "package.json"), "{}");
	}
	writeFileSync(join(src, "manifest.json"), JSON.stringify(manifest(manifestOver)));
	await tar.c(
		{
			gzip: true,
			file: archivePath,
			cwd: src,
			portable: true,
			onWriteEntry: (entry) => {
				entry.path = `dsh-runtime/${entry.path}`;
			},
		},
		["./manifest.json", "./node_modules"],
	);
	// 额外塞一条逃逸条目（tar slip）：手动改写会破坏 gzip 流，这里用追加的方式
	// 单独生成一个未压缩条目不在本测试范围——改为在解压侧直接验证过滤器。
	if (evil) {
		const evilSrc = mkdtempSync(join(tmpdir(), "dsh-evil-"));
		writeFileSync(join(evilSrc, "evil.txt"), "pwned");
		await tar.c(
			{
				file: archivePath.replace(/\.tgz$/, "-evil.tar"),
				cwd: evilSrc,
				portable: true,
				onWriteEntry: (entry) => {
					entry.path = "../../escaped/evil.txt";
				},
			},
			["./evil.txt"],
		);
		rmSync(evilSrc, { recursive: true, force: true });
	}
	rmSync(src, { recursive: true, force: true });
	return archivePath;
}

test("打包产物能被安装端完整消费：剥掉顶层目录后落位正确", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive, { packages: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot"] });

	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		extract: createTarExtractor(),
	});
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.dirName, VERSION);

	const installed = join(root, "runtimes", "dsh", VERSION);
	assert.equal(existsSync(join(installed, "manifest.json")), true);
	assert.equal(existsSync(join(installed, "node_modules", "@deepseek-ai", "dsh-base", "package.json")), true);
	// 顶层目录必须被剥掉，不能嵌套一层 dsh-runtime/
	assert.equal(existsSync(join(installed, "dsh-runtime")), false);
	assert.equal(manager.resolveActive()?.dirName, VERSION);
	rmSync(root, { recursive: true, force: true });
});

test("安装端拒绝版本不兼容的归档（打包自更高 app 版本）", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive, { manifestOver: { minAppVersion: "9.0.0" } });

	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		extract: createTarExtractor(),
	});
	const result = await manager.installFromArchive(archive);
	assert.equal(result.ok, false);
	assert.equal(result.error, "app version incompatible");
	rmSync(root, { recursive: true, force: true });
});

test("本地下载源：file:// 索引与归档都能读（发布位置未就绪时也能跑通链路）", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-local-"));
	const archive = join(root, "runtime.tgz");
	await buildArchive(archive);

	const { createHash } = await import("node:crypto");
	const { createReadStream } = await import("node:fs");
	const { pathToFileURL } = await import("node:url");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archive)) hash.update(chunk);

	const indexPath = join(root, "dsh-runtime-releases.json");
	writeFileSync(
		indexPath,
		JSON.stringify({
			schemaVersion: 1,
			releases: [
				{
					runtimeVersion: VERSION,
					minAppVersion: "0.7.0",
					maxAppVersion: "",
					url: pathToFileURL(archive).href,
					sha256: hash.digest("hex"),
					size: 1,
				},
			],
		}),
	);

	// 索引：file:// 走本地文件读取（Electron net 不发 file 请求）
	const index = await createFetchIndex()(pathToFileURL(indexPath).href);
	assert.equal(index?.releases?.length, 1);
	assert.equal(index.releases[0].runtimeVersion, VERSION);

	// 归档：file:// 走本地复制，且复制后的内容哈希与源一致
	const manager = new DshRuntimeManager({
		layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
		appVersion: () => APP_VERSION,
		download: createNetDownloader(),
		extract: createTarExtractor(),
	});
	const result = await manager.installFromUrl(pathToFileURL(archive).href, index.releases[0].sha256);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(manager.resolveActive()?.dirName, VERSION);
	rmSync(root, { recursive: true, force: true });
});

const { readBundledRuntime } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeManager.ts");

/** 造一个随包资源目录：manifest.json + dsh-runtime-<platform>-<arch>.tgz */
async function makeBundledDir(root, { over = {}, withArchive = true } = {}) {
	const dir = join(root, "dsh-runtime");
	mkdirSync(dir, { recursive: true });
	const archivePath = join(dir, `dsh-runtime-${process.platform}-${process.arch}.tgz`);
	if (withArchive) await buildArchive(archivePath);
	// 随包 manifest 必须带归档的真实 sha256（打包脚本就是这么写的），
	// 安装端会拿它校验——填占位值会直接被判 sha256 mismatch。
	const { createHash } = await import("node:crypto");
	const { createReadStream } = await import("node:fs");
	const hash = createHash("sha256");
	if (withArchive) {
		for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
	}
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest({ archiveSha256: hash.digest("hex"), ...over })));
	return dir;
}

test("readBundledRuntime：目录缺失 / 清单缺失 / 版本不兼容都返回 undefined", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	assert.equal(readBundledRuntime(undefined, APP_VERSION), undefined);
	assert.equal(readBundledRuntime(join(root, "nope"), APP_VERSION), undefined);
	// 只有清单没有归档（或反之）都不算可用
	const noArchive = await makeBundledDir(join(root, "a"), { withArchive: false });
	assert.equal(readBundledRuntime(noArchive, APP_VERSION), undefined, "归档缺失不可用");
	const incompatible = await makeBundledDir(join(root, "b"), { over: { minAppVersion: "9.0.0" } });
	assert.equal(readBundledRuntime(incompatible, APP_VERSION), undefined, "不兼容必须跳过");
	rmSync(root, { recursive: true, force: true });
});

test("readBundledRuntime：清单与归档齐备且兼容时返回可安装的一份", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const dir = await makeBundledDir(root);
	const bundled = readBundledRuntime(dir, APP_VERSION);
	assert.ok(bundled, "应能读到随包 runtime");
	assert.equal(bundled.manifest.runtimeVersion, VERSION);
	assert.equal(existsSync(bundled.archivePath), true);
	rmSync(root, { recursive: true, force: true });
});

test("官方 dev/lite 路径：不注入 bundledRuntime 时必须走在线索引", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-remote-only-"));
	let fetchCalled = false;
	const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
	const installer = new DshRuntimeInstaller({
		manager: new DshRuntimeManager({
			layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
			appVersion: () => APP_VERSION,
			extract: createTarExtractor(),
		}),
		indexUrl: () => "https://idx.test/i.json",
		appVersion: () => APP_VERSION,
		fetchIndex: async () => {
			fetchCalled = true;
			return null;
		},
		onProgress: () => {},
		// dev 和 lite 打包不注入 bundledRuntime；不能因为项目/残留资源存在而跳过远程索引。
		bundledRuntime: () => undefined,
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(fetchCalled, true);
	rmSync(root, { recursive: true, force: true });
});

test("兼容旧 full 包：显式注入随包资源时可不联网安装", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const dir = await makeBundledDir(root);

	let fetchCalled = false;
	const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
	const installer = new DshRuntimeInstaller({
		manager: new DshRuntimeManager({
			layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
			appVersion: () => APP_VERSION,
			extract: createTarExtractor(),
		}),
		indexUrl: () => "https://unreachable.test/index.json",
		appVersion: () => APP_VERSION,
		// 若走到在线分支就会被调用；用它断言「本地资源优先」
		fetchIndex: async () => {
			fetchCalled = true;
			return null;
		},
		onProgress: () => {},
		// 兼容旧 full 包：只有显式注入才允许本地资源优先。
		bundledRuntime: () => readBundledRuntime(dir, APP_VERSION),
	});

	const result = await installer.installFromIndex();
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(fetchCalled, false, "显式随包资源时不应发起网络请求");
	rmSync(root, { recursive: true, force: true });
});

test("没有随包资源时走在线索引", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundled-"));
	const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
	let fetchCalled = false;
	const installer = new DshRuntimeInstaller({
		manager: new DshRuntimeManager({
			layout: { runtimesRoot: join(root, "runtimes", "dsh"), tempRoot: join(root, "runtimes", ".tmp") },
			appVersion: () => APP_VERSION,
			extract: createTarExtractor(),
		}),
		indexUrl: () => "https://idx.test/i.json",
		appVersion: () => APP_VERSION,
		fetchIndex: async () => {
			fetchCalled = true;
			return null;
		},
		onProgress: () => {},
		// lite/dev 路径显式不提供随包 runtime，必须查询远程索引。
		bundledRuntime: () => undefined,
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(fetchCalled, true, "没有随包资源时必须走在线索引");
	rmSync(root, { recursive: true, force: true });
});

test("runtime:pack 默认 lite，CI 交叉打满 6 平台并上传，禁止独立 dsh-runtime tag", () => {
	const pack = readFileSync("scripts/pack-dsh-runtime.mjs", "utf8");
	const pkgJson = readFileSync("package.json", "utf8");
	const pkg = JSON.parse(pkgJson);
	const release = readFileSync(".github/workflows/release.yml", "utf8");
	assert.match(pack, /const lite = !argv.includes\("--full"\)/, "官方默认 lite；--full 才把 runtime 拷进 extraResources");
	assert.match(pack, /isNpmHashedLeftoverDir/, "npm 升级残留 .pkg-<8char> 必须从种子/闭包/walk 跳过");
	assert.equal(pkg.scripts["runtime:pack"], "node scripts/pack-dsh-runtime.mjs");
	assert.match(pkgJson, /@larksuiteoapi\/node-sdk\/es/, "electron-builder files 必须排除飞书 SDK 的 ESM 副本");
	// 2026-09 起 runtime tgz 由 pack-dsh-runtime job（单 runner 交叉打包）上传，
	// 安装包构建 job 不再顺带产出 runtime（glob 已从它的 files 列表移除）。
	const packJob = release.split("pack-dsh-runtime:")[1] ?? "";
	assert.ok(packJob.includes("dsh-runtime-${{ matrix.os }}-${{ matrix.arch }}.tgz"), "交叉 job 必须上传目标平台命名的归档");
	assert.ok(packJob.includes("--target-os ${{ matrix.os }}"), "交叉 job 必须传 --target-*");
	assert.doesNotMatch(release, /releases\/download\/dsh-runtime/, "独立 sidecar tag 会抢走 GitHub /releases/latest");
});

// 2026-09-22 v0.7.7 两次事故都出在 pack 准备阶段「省掉完整 npm ci」：先漏 tar
// （12 个 runtime 资产全缺），补发时又缺 tsc + @types/node + @deepseek-ai 类型
// （本地包 dsh-tool-pwsh-persistent 构建失败，6 平台全挂）。这里把前提钉死：
// 两个 pack job 必须装完整依赖，并在 pack 前自检脚本裸 import 与构建工具链。
test("pack job 必须装完整依赖（tar / tsc / @deepseek-ai 类型缺一即事故）", () => {
	const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
	const publish = readFileSync(join(repoRoot, ".github/workflows/publish-dsh-runtime.yml"), "utf8");
	const jobs = [
		["release.yml pack-dsh-runtime", release.split("pack-dsh-runtime:")[1] ?? ""],
		["publish-dsh-runtime.yml pack-and-upload-cross", publish.split("pack-and-upload-cross:")[1]?.split("pack-and-upload:")[0] ?? ""],
	];
	for (const [label, job] of jobs) {
		assert.ok(job.includes("Pack DSH runtime (cross)"), `${label}: job 片段定位失败`);
		assert.match(job, /npm ci --ignore-scripts --no-audit --no-fund/, `${label}: 必须完整 npm ci（--ignore-scripts 跳过 electron 二进制）`);
		// 只看安装命令本身：注释里会出现 --omit=dev 这种历史说明，属于文档不是配置。
		assert.doesNotMatch(job, /npm (ci|install)[^\n]*--omit=dev/, `${label}: 禁止 --omit=dev（缺 tsc/@deepseek-ai 类型，本地包构建必挂）`);
		assert.doesNotMatch(job, /Restore semver/, `${label}: 不再手工 curl 拼 node_modules`);
		assert.ok(job.indexOf("Verify packing script deps resolvable") < job.indexOf("Pack DSH runtime (cross)"), `${label}: 自检必须在 pack 之前`);
		assert.match(job, /await import\('tar'\)/, `${label}: 自检要覆盖脚本裸 import`);
		assert.match(job, /require\.resolve\('typescript'\)/, `${label}: 自检要覆盖本地包构建工具链`);
	}
});

/** 手动补发入口：runtime 变更后不必重打安装包，但仍必须挂 latest v*。 */
test("publish-dsh-runtime.yml 提供手动上传入口，并要求同步到默认分支", () => {
	const publish = readFileSync(".github/workflows/publish-dsh-runtime.yml", "utf8");
	assert.match(publish, /workflow_dispatch/);
	assert.match(publish, /tag:/);
	// 目标 tag 改为下拉（choice）+ tag_custom 手填：choice 不接受空选项，
	// 故「留空 = latest」用哨兵值 auto 表达，脚本里再还原。
	assert.match(publish, /type: choice/);
	assert.match(publish, /tag_custom/);
	assert.match(publish, /默认分支 main/);
	assert.match(publish, /Actions 不会在页面注册\/显示/);
});

test("runtime 与 runner Node 补发都支持显式目标 Release tag", () => {
	const publishRuntime = readFileSync(".github/workflows/publish-dsh-runtime.yml", "utf8");
	const publishNode = readFileSync(".github/workflows/publish-dsh-runner-node.yml", "utf8");
	// 两个 workflow 都用同一套归一表达式：tag_custom 非空优先，否则用下拉选择；
	// 下游脚本负责把哨兵值 auto 还原成「未指定」。
	const resolve = /INPUT_TAG: \$\{\{ inputs\.tag_custom != '' && inputs\.tag_custom \|\| inputs\.tag \}\}/;
	assert.match(publishRuntime, resolve);
	assert.match(publishNode, resolve);
	assert.match(publishRuntime, /INPUT_TAG" = "auto"/);
	assert.match(publishNode, /INPUT_TAG" = "auto"/);
	assert.match(publishNode, /gh release upload/);
	assert.match(publishNode, /--clobber/);
});

test("publish-dsh-runtime.yml 不依赖不会触发 workflow 的 runtime:pack 脚本", () => {
	const publish = readFileSync(".github/workflows/publish-dsh-runtime.yml", "utf8");
	assert.doesNotMatch(publish, /npm run runtime:pack/);
	assert.match(publish, /node scripts\/pack-dsh-runtime\.mjs/);
});

test("publish-dsh-runtime.yml 默认原生矩阵 + 可选交叉模式，挂 latest 应用 Release", () => {
	const publish = readFileSync(".github/workflows/publish-dsh-runtime.yml", "utf8");
	assert.match(publish, /workflow_dispatch/);
	assert.match(publish, /node scripts\/pack-dsh-runtime\.mjs/);
	assert.match(publish, /node scripts\/check-dsh-asar\.mjs/);
	assert.match(publish, /releases\/latest/);
	assert.match(publish, /gh release upload/);
	assert.match(publish, /name: Publish DSH runtime/);
	assert.match(publish, /RELEASE_PAT/);
	assert.match(publish, /--clobber/);
	// 原生矩阵保留（回退路径）：win32-arm64 / darwin-x64 必须有原生 runner 覆盖。
	assert.match(publish, /windows-11-arm/);
	assert.match(publish, /ubuntu-24\.04-arm/);
	assert.match(publish, /macos-15-intel/);
	// 交叉模式（2026-09 新增）：单 ubuntu runner 打全 6 平台，--target-* 参数化。
	assert.match(publish, /cross_pack/);
	assert.match(publish, /--target-os \$\{\{ matrix\.os \}\} --target-arch \$\{\{ matrix\.arch \}\}/);
	assert.match(publish, /dsh-runtime-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}\.tgz/);
	assert.match(publish, /dsh-runtime-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.arch \}\}\.tgz/);
	assert.match(publish, /\^v\[0-9\]/, "只允许挂到 v* 应用 tag");
	assert.doesNotMatch(publish, /TAG=dsh-runtime/);
	assert.doesNotMatch(publish, /gh release create\s+dsh-runtime/, "禁止新建独立 sidecar Release");
});

test("解压器过滤逃逸条目：../ 不会写出目标目录", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-slip-"));
	const src = mkdtempSync(join(tmpdir(), "dsh-slipsrc-"));
	writeFileSync(join(src, "evil.txt"), "pwned");
	const archive = join(src, "evil.tar");
	await tar.c(
		{
			file: archive,
			cwd: src,
			portable: true,
			onWriteEntry: (e) => {
				e.path = "../../escaped/evil.txt";
			},
		},
		["./evil.txt"],
	);

	const dest = join(root, "dest");
	await createTarExtractor()(archive, dest);
	// 目标目录内不应出现任何越界文件；escaped/ 若被写出会在 root 之外一层
	assert.equal(existsSync(join(dest, "escaped")), false, "逃逸条目必须被过滤");
	const leaked = join(root, "..", "escaped", "evil.txt");
	assert.equal(existsSync(leaked), false, "绝不能写到目标目录之外");
	rmSync(root, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});

// 2026-09 v0.7.5 sidecar 事故：file: 本地包（dsh-tool-pwsh-persistent）在全新检出
// 下未构建（lib/ 是 gitignore 产物），源码-only 被打进归档 → host 启动
// require.resolve 直接崩。打包脚本必须在 tar 之前对磁盘入口做预检（缺失自动构建/报错）。
test("pack script pre-flights entry files before tarring", () => {
	const packScript = readFileSync(join(repoRoot, "scripts/pack-dsh-runtime.mjs"), "utf8");
	const pruneRules = readFileSync(join(repoRoot, "scripts/runtime-prune-rules.mjs"), "utf8");
	// 预检必须在闭包收集后、文件收集前执行（自动构建的产物要进归档）
	assert.match(packScript, /\/\/ 入口预检必须发生在文件收集之前[^\n]*\nensureClosureEntriesBuilt\(closure\);/);
	assert.match(packScript, /runtimeEntryResolvableOnDisk/);
	// 磁盘侧判定与归档侧校验（check-dsh-asar）同源复用同一入口提取逻辑
	assert.match(pruneRules, /export function runtimeEntryResolvableOnDisk/);
});

// 2026-09 发版自动化链：push tag 后应无人值守完成「构建 → runtime tgz → AtomGit 同步」。
// 这里把链路契约固化：事件衔接、平台覆盖、PAT 要求、资产稳定窗口。
// （背景：v0.7.5 曾因 runtime tgz 缺平台 + 同名资产被静默跳过，镜像用户升到旧包。）
// 2026-09 起平台覆盖改由 release.yml 内 pack-dsh-runtime job 交叉打包全 6 平台
// （不再需要原生 runner 矩阵 + post-release-sidecars 补缺），sidecars 仅保留
// sync-atomgit 触发兑底。
test("发版自动化链：release → pack-dsh-runtime/sidecars → sync-atomgit 事件衔接完整", () => {
	const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
	const sidecars = readFileSync(join(repoRoot, ".github/workflows/post-release-sidecars.yml"), "utf8");
	const sync = readFileSync(join(repoRoot, ".github/workflows/sync-atomgit.yml"), "utf8");

	// 触发链：release.yml 用 PAT 发布（广播 release: published）→ sidecars 监听 published
	// → sidecars 结尾用 PAT workflow_dispatch 触发 sync-atomgit（sync 自身也监听 published）。
	assert.match(release, /token: \$\{\{ secrets\.RELEASE_PAT \}\}/, "softprops 必须用 PAT 发布");
	assert.match(sidecars, /release:\s*\n\s*types:\s*\[published\]/);
	assert.match(sidecars, /gh workflow run sync-atomgit\.yml/);
	assert.match(sidecars, /GH_TOKEN: \$\{\{ secrets\.RELEASE_PAT \}\}/, "触发下游必须用 PAT（GITHUB_TOKEN 不再触发 workflow）");
	assert.match(sync, /types:\s*\[published\]/);
	assert.match(sync, /workflow_dispatch/);

	// 平台覆盖：release.yml 的 pack-dsh-runtime job 必须交叉打满 6 平台
	// （win32/darwin/linux × x64/arm64），linux 强制 glibc（非 Linux 宿主上 npm 检测
	// 不到 libc 会静默过滤 @img/sharp-linux-x64 等平台包）。
	for (const [os, arch] of [
		["win32", "x64"],
		["win32", "arm64"],
		["darwin", "x64"],
		["darwin", "arm64"],
		["linux", "x64"],
		["linux", "arm64"],
	]) {
		assert.match(release, new RegExp(`os: ${os}\\s*\\n\\s*arch: ${arch}`), `缺失平台 ${os}-${arch}`);
	}
	assert.match(release, /--target-os \$\{\{ matrix\.os \}\} --target-arch \$\{\{ matrix\.arch \}\}/);
	// 归档校验必须带同一组 --target-* 参数（原生包在位断言按目标平台检查）。
	assert.match(release, /check-dsh-asar\.mjs --target-os \$\{\{ matrix\.os \}\} --target-arch \$\{\{ matrix\.arch \}\}/);
	// sidecars 不再打包/上传 runtime（补发职责已移除，仅保留 sync-atomgit 触发）。
	assert.doesNotMatch(sidecars, /pack-dsh-runtime\.mjs/);
	assert.doesNotMatch(sidecars, /gh release upload/);

	// sidecars 上传目标必须来自 release 事件本体且限定 v*（禁止 sidecar tag 抢 latest）。
	assert.match(sidecars, /github\.event\.release\.tag_name/);
	assert.match(sidecars, /\^v\[0-9\]/);

	// sync-atomgit 必须等资产清单稳定再同步（release:published 触发时构建 job 还在传资产）。
	assert.match(sync, /ASSET_WAIT_DEADLINE_SECONDS/);
	assert.match(sync, /ASSET_STABLE_REQUIRED/);
	assert.match(sync, /releases\/tags\/\$\{TAG\}/);
	// 预期 runtime tgz 总数 = 6（release.yml 交叉打满 6 平台）。
	assert.match(sync, /-ge 6/);
});
