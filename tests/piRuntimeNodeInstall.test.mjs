import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// runtimeNodeInstall 依赖 DshRuntimeManager（sha256OfFile / IO 类型），后者 import electron
// 仅用于常量与类型；测试里给最小替身即可加载。
const { installPiRuntimeNode, detectPiRuntimeNode, piRuntimeNodeExePath, piRuntimeNodeBinDir, piRuntimeRootDir, probeNodeVersion, copyDirEntryVerbatim, repairPortableNodeLinks } = loadTsCommonJs("src/main/pi/runtimeNodeInstall.ts", {
	stubs: { electron: { app: {} } },
});
const { PI_RUNTIME_NODE_VERSION, PI_RUNTIME_NODE_SHA256, piRuntimeNodeArchiveName, piRuntimeNodeDownloadUrls, piRuntimeNodeInnerDir, officialPiRuntimeNodeUrl, toPiRuntimePlatform, toPiRuntimeArch } = loadTsCommonJs("src/shared/types/piRuntimeNode.ts");

const EXPECTED_VERSION = `v${PI_RUNTIME_NODE_VERSION}`;

/**
 * 测试替身：解压出内层目录 + node.exe。
 * probeVersion 模拟真实语义：「文件存在且可执行才返回版本」——与真实 probeNodeVersion
 * 对缺失路径返回 undefined 的行为对齐。否则安装器的幂等短路分支（existing 检查）
 * 会误命中，download/extract 永远不会被执行。
 */
function fakeDeps({ probeVersion } = {}) {
	return {
		deps: {
			download: async (_url, destPath) => {
				await mkdir(join(destPath, ".."), { recursive: true });
				await writeFile(destPath, "archive-bytes");
			},
			extract: async (_zip, destDir) => {
				const dest = join(destDir, piRuntimeNodeInnerDir("win32", "x64"));
				await mkdir(dest, { recursive: true });
				await writeFile(join(dest, "node.exe"), "node-bin");
				return destDir;
			},
		},
		// 默认 probe：exe 已写入 userData 才成功（替身无法真的执行 node.exe）
		probeVersion: probeVersion ?? (async (nodePath) => (existsSync(nodePath) ? EXPECTED_VERSION : undefined)),
	};
}

test("契约：版本、哈希表、镜像回退链与 URL 拼接", () => {
	assert.equal(PI_RUNTIME_NODE_VERSION, "24.13.0");
	// 六个平台-架构组合都必须有固化哈希，缺一个就是引导链路里的硬失败
	for (const key of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
		assert.match(PI_RUNTIME_NODE_SHA256[key], /^[0-9a-f]{64}$/, `sha256 for ${key}`);
	}
	// Windows 是 zip，其余是 tar.gz，命名与 nodejs.org/dist 一致
	assert.equal(piRuntimeNodeArchiveName("win32", "x64"), "node-v24.13.0-win-x64.zip");
	assert.equal(piRuntimeNodeArchiveName("darwin", "arm64"), "node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(piRuntimeNodeInnerDir("win32", "x64"), "node-v24.13.0-win-x64");
	// 回退链：npmmirror → 自有 Release（win32 才有）→ 华为云 → 官方（国内网络优先）。
	// 逐元素断言：vm 沙箱跨 realm 下 deepEqual 比较原型会误报。
	const urls = piRuntimeNodeDownloadUrls("win32", "x64");
	assert.equal(urls.length, 5);
	assert.equal(urls[0], "https://npmmirror.com/mirrors/node/v24.13.0/node-v24.13.0-win-x64.zip");
	// 自有 Release 资产：与 DSH runner node 共用同一份官方完整 zip（sha256 与官方一致）
	assert.equal(urls[1], "https://atomgit.com/ayuayue/PiDeck/releases/download/latest/node-v24.13.0-win-x64.zip");
	assert.equal(urls[2], "https://github.com/ayuayue/PiDeck/releases/latest/download/node-v24.13.0-win-x64.zip");
	assert.equal(urls[3], "https://mirrors.huaweicloud.com/nodejs/v24.13.0/node-v24.13.0-win-x64.zip");
	assert.equal(urls[4], officialPiRuntimeNodeUrl("win32", "x64"));
	// 非 Windows：Release 上没有对应资产，回退链不含自有源
	const darwinUrls = piRuntimeNodeDownloadUrls("darwin", "arm64");
	assert.equal(darwinUrls.length, 3);
	assert.equal(darwinUrls[0], "https://npmmirror.com/mirrors/node/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(darwinUrls[1], "https://mirrors.huaweicloud.com/nodejs/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(darwinUrls[2], officialPiRuntimeNodeUrl("darwin", "arm64"));
	assert.match(officialPiRuntimeNodeUrl("linux", "x64"), /nodejs\.org\/dist/);
	// 平台白名单：认识的返回原值，不认识的一律 null（引导入口不支持）
	assert.equal(toPiRuntimePlatform("win32"), "win32");
	assert.equal(toPiRuntimePlatform("freebsd"), null);
	assert.equal(toPiRuntimeArch("x64"), "x64");
	assert.equal(toPiRuntimeArch("ia32"), null);
});

test("installPiRuntimeNode：不认识的平台直接拒绝，不下载不写盘", async () => {
	let downloaded = false;
	const result = await installPiRuntimeNode(
		{ userDataPath: "C:\\should-not-write", platform: "freebsd", arch: "x64" },
		{
			download: async () => {
				downloaded = true;
			},
			extract: async () => {
				throw new Error("should not extract");
			},
		},
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /unsupported platform/);
	assert.equal(downloaded, false);
});

test("installPiRuntimeNode：镜像失败自动回退下一个源，最终成功并落盘 userData", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const attempted = [];
		const bytes = "archive-bytes";
		const { deps, probeVersion } = fakeDeps();
		const originalDownload = deps.download;
		deps.download = async (url, destPath) => {
			attempted.push(url);
			// 前 4 个源（npmmirror/AtomGit/GitHub/华为云）都模拟网络不可达，官方源成功
			if (attempted.length < 5) throw new Error("network unreachable");
			await originalDownload(url, destPath);
		};
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				probeVersion,
				// 用本地内容哈希做「官方归档校验通过」的替身（固化值不可能伪造本地内容）
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			deps,
		);
		assert.equal(result.ok, true, result.error);
		assert.equal(attempted.length, 5, "should try all 5 mirrors");
		assert.match(attempted[0], /npmmirror\.com/);
		assert.match(attempted[1], /atomgit\.com/);
		assert.match(attempted[2], /github\.com/);
		assert.match(attempted[3], /huaweicloud\.com/);
		assert.match(attempted[4], /nodejs\.org/);
		assert.equal(result.path, piRuntimeNodeExePath(root, "win32"));
		assert.equal(result.version, EXPECTED_VERSION);
		assert.equal(result.source, "download");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：sha256 不匹配时拒绝解压并换下一个源", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		let extractCalled = 0;
		let downloads = 0;
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				// 版本探测不应被走到（校验先失败）；真被走到说明防线失守。
				// 返回 undefined 对齐真实 probeNodeVersion 对缺失文件的行为，
				// 避免无状态替身误命中幂等 existing 分支。
				probeVersion: async () => undefined,
			},
			{
				download: async (_url, destPath) => {
					downloads += 1;
					await mkdir(join(destPath, ".."), { recursive: true });
					await writeFile(destPath, "tampered-bytes");
				},
				extract: async () => {
					extractCalled += 1;
					return tmpdir();
				},
			},
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /sha256 mismatch/);
		assert.equal(extractCalled, 0, "tampered archives must never be extracted");
		assert.equal(downloads, 5, "all mirrors must be tried before giving up");
		// 失败后不得在 userData 留下半截安装
		assert.equal(existsSync(piRuntimeNodeExePath(root, "win32")), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：版本探测不通过视为失败（半截安装防线）", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		// 解压产物存在但 node.exe 跑不起来（probe 返回 undefined）：
		// 对应真实场景「杀软拦截/下载中断导致文件在但不可执行」。
		const bytes = "archive-bytes";
		const { deps } = fakeDeps({ probeVersion: async () => undefined });
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			deps,
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /not executable/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：主版本不匹配视为失败（防御性校验）", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const bytes = "archive-bytes";
		const fake = fakeDeps({
			// probe 模拟「文件已存在时返回错误大版本」：existing 检查在下载前，
			// 无条件返回 v25.0.0 会误命中幂等分支 —— 必须与文件存在性绑定。
			probeVersion: async (nodePath) => (existsSync(nodePath) ? "v25.0.0" : undefined),
		});
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				probeVersion: fake.probeVersion,
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			fake.deps,
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /unexpected node version/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：已有可用副本时幂等返回，不重新下载", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		// 预置一个真的 exe 文件（幂等分支的判定是「文件存在且 probe 成功」，
		// 但 fakeDeps 默认 probe 也要求文件存在，所以这里用无条件成功的替身）
		const exePath = piRuntimeNodeExePath(root, "win32");
		await mkdir(join(exePath, ".."), { recursive: true });
		await writeFile(exePath, "node-bin");
		const result = await installPiRuntimeNode(
			{ userDataPath: root, platform: "win32", arch: "x64", probeVersion: async () => EXPECTED_VERSION },
			{
				download: async () => {
					throw new Error("should not download when copy already usable");
				},
				extract: async () => {
					throw new Error("should not extract when copy already usable");
				},
			},
		);
		assert.equal(result.ok, true, result.error);
		assert.equal(result.source, "existing");
		assert.equal(result.path, exePath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("probeNodeVersion：不可执行路径返回 undefined 而不是抛错", async () => {
	// 目录不是可执行文件，execFile 必然失败；正确行为是返回 undefined。
	const result = await probeNodeVersion(tmpdir());
	assert.equal(result, undefined);
});

test("detectPiRuntimeNode：无副本时 installed=false 且透传系统 node 状态", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const status = await detectPiRuntimeNode(root, "v22.0.0", "win32");
		assert.equal(status.installed, false);
		assert.equal(status.systemNodeAvailable, true);
		assert.equal(status.systemNodeVersion, "v22.0.0");
		assert.equal(status.installSupported, true);
		// 安装目录约定：<userData>/pi-runtime/node/
		assert.ok(piRuntimeRootDir(root).endsWith(join("pi-runtime")));
		assert.ok(piRuntimeNodeExePath(root, "win32").endsWith(join("pi-runtime", "node", "node.exe")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 回归（2026-09-30 Linux 实机）：POSIX 官方 node 发行包把可执行文件放在 bin/ 下，
// Windows zip 才直接放在发行包根目录。少这一层会同时弄坏三件事：
// 便携 node 永远判未安装、点安装报 extracted node is not executable、
// 引导永远回退到系统 npm（无系统 npm 的机器直接卡在第 2 步）。
test("便携 node 路径按平台区分 bin 层：POSIX 在 node/bin，Windows 在 node", () => {
	const root = "/tmp/userData";
	assert.ok(piRuntimeNodeExePath(root, "linux").endsWith(join("pi-runtime", "node", "bin", "node")));
	assert.ok(piRuntimeNodeExePath(root, "darwin").endsWith(join("pi-runtime", "node", "bin", "node")));
	assert.ok(piRuntimeNodeExePath(root, "win32").endsWith(join("pi-runtime", "node", "node.exe")));

	// 子进程 PATH 前置目录与可执行文件同源（pi 的 shim 是 #!/usr/bin/env node）
	assert.equal(piRuntimeNodeBinDir(root, "linux"), dirname(piRuntimeNodeExePath(root, "linux")));
	assert.equal(piRuntimeNodeBinDir(root, "win32"), dirname(piRuntimeNodeExePath(root, "win32")));
});

// 回归（2026-09-30 Linux 实机）：跨设备回退复制必须保留相对软链。
// Node 的 cpSync 默认 verbatimSymlinks:false 会把 bin/npm 这类相对链接改写成绝对路径，
// 解压临时目录（/tmp/pideck-node-extract-*）一删，便携 npm/npx/corepack 全部悬空。
// Windows 未开开发者模式/非管理员时创建符号链接被系统拒绝（EPERM）——环境限制，跳过。
async function trySymlink(target, path) {
	const { symlinkSync } = await import("node:fs");
	try {
		// 显式 "file"：不传 type 时 Node 会推断，悬空目标在某些 Windows 环境
		//（如 GitHub runner）会被建成目录型软链——rmSync(force) 对它报 ENOENT 假成功，
		// 修复路径的 unlink 实际删不掉链接，后续 symlinkSync 全部 EEXIST（2026-10 CI 实锤）。
		symlinkSync(target, path, "file");
		return true;
	} catch (error) {
		if (process.platform === "win32" && error.code === "EPERM") return false;
		throw error;
	}
}

test("跨设备回退复制保留相对软链（verbatimSymlinks）", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-link-"));
	try {
		const from = join(root, "src-bin");
		const to = join(root, "dest-bin");
		await mkdir(join(from, "..", "lib", "node_modules", "npm", "bin"), { recursive: true });
		await writeFile(join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "// cli\n", "utf8");
		await mkdir(from, { recursive: true });
		const { readlinkSync } = await import("node:fs");
		if (!(await trySymlink(join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(from, "npm")))) {
			t.skip("Windows 符号链接权限不足（EPERM）");
			return;
		}

		copyDirEntryVerbatim(from, to);

		const target = readlinkSync(join(to, "npm"));
		assert.equal(target, join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "复制后必须是相对链接，不能落到绝对路径");
		assert.ok(!target.includes(root), "链接目标不能包含临时目录路径");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 自愈：旧版本（cpSync 默认把相对链接写成绝对路径）装出来的便携副本里，
// npm/npx/corepack 会指向已被删掉的解压临时目录。判据保守，只修「绝对链接 + 目标已不在 + 本地有同名文件」。
test("repairPortableNodeLinks：悬空的绝对软链会被改写成可用的相对链接", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-node-repair-"));
	try {
		const { readlinkSync, mkdirSync } = await import("node:fs");
		const binDir = piRuntimeNodeBinDir(root, "linux");
		mkdirSync(join(root, "pi-runtime", "node", "lib", "node_modules", "npm", "bin"), { recursive: true });
		mkdirSync(binDir, { recursive: true });
		// fs/promises 的写盘必须 await：不 await 时自愈会在文件真正落盘前读到「本地副本不存在」，
		// 于是修不了（表现为随机失败，跑十几次才复现一次）。
		await writeFile(join(root, "pi-runtime", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "// cli\n", "utf8");
		// 复现旧安装的现场：指向已删除的解压目录。用 join(root,...) 造出「带盘符的绝对路径」，
		// 在任何机器上都确定性悬空——无盘符的 "/tmp/..." 在 Windows 上按 cwd 所在盘解析，
		// CI runner 上可能意外命中真实目录（2026-10 v0.7.8 发版时 CI 反复红）。
		const danglingTarget = join(root, "pideck-node-extract-gone", "node-v24.13.0-linux-x64", "lib", "node_modules", "npm", "bin", "npm-cli.js");
		if (!(await trySymlink(danglingTarget, join(binDir, "npm")))) {
			t.skip("Windows 符号链接权限不足（EPERM）");
			return;
		}
		// 相对链接本来就没问题，不应被动
		if (!(await trySymlink(join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(binDir, "npx")))) {
			t.skip("Windows 符号链接权限不足（EPERM）");
			return;
		}

		// 前置条件断言：把 repairPortableNodeLinks 各 continue 分支的输入锁定住，
		// 环境差异（软链被改成副本、悬空目标意外存在、本地副本未落盘）直接在断言消息里现形。
		const { existsSync: existsSyncSync, lstatSync, readlinkSync: readlinkRaw } = await import("node:fs");
		assert.equal(readlinkRaw(join(binDir, "npm")), danglingTarget, "npm 软链必须指向造出的绝对悬空目标");
		assert.equal(existsSyncSync(join(binDir, "npm")), false, "悬空目标在该机器上必须真的不存在");
		assert.equal(existsSyncSync(join(root, "pi-runtime", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js")), true, "本地 npm-cli.js 必须已落盘");

		// 环境探测：GitHub Windows runner 上 rmSync(force:true) 对「悬空」软链会静默假成功
		//（unlink 顺着 reparse 解析到不存在的目标 → ENOENT → force 吞掉，链接本体未删），
		// 修复循环 5 次重试全部 EEXIST、宿主重演同样删不掉（2026-10 v0.7.8 发版 CI 实锤：
		// rm 前=symlink rm 后=symlink）。非悬空软链删除不受影响；生产修复只在 POSIX 路径运行，
		// Windows 无此风险。探测到怪癖就跳过本用例，修复逻辑由「绝对但可解析」用例保覆盖。
		{
			const probe = join(binDir, "dangling-rm-probe");
			if (await trySymlink(join(root, "pideck-node-extract-gone", "definitely-missing"), probe)) {
				const { rmSync } = await import("node:fs");
				rmSync(probe, { force: true });
				let probeGone = false;
				try {
					lstatSync(probe);
				} catch {
					probeGone = true;
				}
				if (!probeGone) {
					rmSync(join(binDir, "npm"), { force: true });
					rmSync(join(binDir, "npx"), { force: true });
					// 链接已清理：修复必须安静无操作，至少保住模块在 CI 上被真实执行
					assert.deepEqual([...repairPortableNodeLinks(root, "linux")], [], "怪癖环境下（链接已清理）修复应为无操作");
					t.skip("此 Windows 环境 rmSync 删不掉悬空软链（已知 runner 怪癖）；修复逻辑由可解析绝对链接用例覆盖");
					return;
				}
			}
		}

		const repaired = repairPortableNodeLinks(root, "linux");
		// 先看链接终态再比对返回值：修复动作失败时（rm 后 symlink 被杀软锁住等），
		// 终态断言能直接现形「链接没了还是还悬空」，比空数组比对信息量大。
		assert.equal(readlinkRaw(join(binDir, "npm")), join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "修复后 npm 应指向相对链接");
		assert.deepEqual([...repaired], ["npm"]);
		assert.equal(readlinkSync(join(binDir, "npm")), join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
		assert.equal(readlinkSync(join(binDir, "npx")), join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
		// 幂等：再跑一次不应再报修复
		assert.deepEqual([...repairPortableNodeLinks(root, "linux")], []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("IPC / preload 三处同步注册 pi 环境引导通道", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	// 通道常量 + 主进程 handler + preload 暴露必须三处齐全（漏一处 = 运行时 undefined）
	assert.match(ipc, /piRuntimeNodeCheck:\s*"pi:runtime-node-check"/);
	assert.match(ipc, /piRuntimeNodeInstall:\s*"pi:runtime-node-install"/);
	assert.match(ipc, /piRuntimePiInstall:\s*"pi:runtime-pi-install"/);
	assert.match(systemIpc, /ipcChannels\.piRuntimeNodeCheck/);
	assert.match(systemIpc, /ipcChannels\.piRuntimeNodeInstall/);
	assert.match(systemIpc, /ipcChannels\.piRuntimePiInstall/);
	assert.match(systemIpc, /installPiRuntimeNode/);
	assert.match(preload, /runtimeNodeCheck:\s*\(\)\s*=>/);
	assert.match(preload, /runtimeNodeInstall:\s*\(\)\s*=>/);
	assert.match(preload, /runtimePiInstall:\s*\(useMirror:\s*boolean\)/);
	// 收紧通道断言：pi 安装只接受镜像布尔意图，不再让渲染层传任意命令字符串
	const body = preload.match(/runtimePiInstall:[\s\S]{0,220}/)?.[0] ?? "";
	assert.match(body, /useMirror === true/);
});

test("安装器复用 DSH runtime IO，index.ts 装配真实下载/解压实现", () => {
	const installer = readFileSync("src/main/pi/runtimeNodeInstall.ts", "utf8");
	assert.match(installer, /from "\.\.\/dsh\/runtime\/DshRuntimeManager"/);
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /piRuntimeNodeInstaller:\s*\{/);
	assert.match(index, /createNetDownloader/);
	assert.match(index, /createTarExtractor/);
});
