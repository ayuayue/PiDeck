import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshRuntimeInstaller } = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeInstaller.ts");
const { dshRuntimeArchiveName, dshRuntimeAssetDownloadUrl } = loadTsCommonJs("src/shared/types/dshRuntimeManifest.ts");
const { resolveDshRuntimeReleaseTag } = loadTsCommonJs("src/main/dsh/runtime/dshRuntimeReleaseTarget.ts");

const APP_VERSION = "0.7.5";

const release = (over = {}) => ({
	runtimeVersion: "0.1.1-rc.2",
	minAppVersion: "0.7.0",
	maxAppVersion: "",
	// 打包脚本写归档文件名占位；installer 再按 updateSource 改写成 latest 资产。
	url: dshRuntimeArchiveName(process.platform, process.arch),
	sha256: "abc",
	size: 100,
	...over,
});

/** 组装一个 installer，manager 用替身（不碰磁盘与网络）。 */
function makeInstaller({ index = { schemaVersion: 1, releases: [release()] }, url = "https://idx.test/i.json", manager = {}, updateSource = "atomgit", releaseTag, declared, bundled } = {}) {
	const progress = [];
	const calls = { installFromUrl: [], installFromArchive: [], installFromDirectory: [], uninstall: [] };
	const fakeManager = {
		installFromUrl: async (archiveUrl, sha256, options) => {
			calls.installFromUrl.push({ archiveUrl, sha256, options });
			// 复刻真实 manager 的阶段回调顺序（下载字节 → 校验 → 解压 → 落位）
			options?.onPhase?.("downloading");
			options?.onDownloadProgress?.(50, 100);
			for (const phase of ["verifying", "extracting", "finalizing"]) options?.onPhase?.(phase);
			return manager.installFromUrl ? manager.installFromUrl() : { ok: true, dirName: "0.1.1-rc.2" };
		},
		installFromArchive: async (filePath) => {
			calls.installFromArchive.push(filePath);
			return manager.installFromArchive ? manager.installFromArchive() : { ok: true, dirName: "0.1.1-rc.2", manifest: { runtimeVersion: "0.1.1-rc.2" } };
		},
		installFromDirectory: async (dirPath) => {
			calls.installFromDirectory.push(dirPath);
			return manager.installFromDirectory ? manager.installFromDirectory() : { ok: true, dirName: "0.1.1-rc.2", manifest: { runtimeVersion: "0.1.1-rc.2" } };
		},
		uninstall: (dirName) => {
			calls.uninstall.push(dirName);
			manager.uninstall?.(dirName);
		},
		resolveActive: () => manager.resolveActive ?? undefined,
		isVersionInstalled: (version) => (manager.isVersionInstalled ? manager.isVersionInstalled(version) : false),
	};
	const installer = new DshRuntimeInstaller({
		manager: fakeManager,
		indexUrl: () => url,
		updateSource: () => updateSource,
		releaseTag: releaseTag ? () => releaseTag : undefined,
		appVersion: () => APP_VERSION,
		// declared === undefined → 不传该 dep，保留旧行为（按兼容区间择优）给既有断言。
		declaredVersion: declared === undefined ? undefined : () => declared,
		bundledRuntime: bundled ? () => bundled : undefined,
		fetchIndex: async () => index,
		onProgress: (p) => progress.push(p),
	});
	return { installer, progress, calls };
}

test("dev 未发布同版本 tag 时跟随 latest，避免请求不存在的 beta Release", () => {
	assert.equal(resolveDshRuntimeReleaseTag({ isPackaged: false, appVersion: "0.7.6-beta" }), undefined);
	assert.equal(resolveDshRuntimeReleaseTag({ isPackaged: true, appVersion: "0.7.5" }), "v0.7.5");
	assert.equal(
		resolveDshRuntimeReleaseTag({
			explicitTag: " v0.7.5 ",
			isPackaged: false,
			appVersion: "0.7.6-beta",
		}),
		"v0.7.5",
	);
});

test("installFromIndex：按兼容区间挑版本并触发下载", async () => {
	const { installer, calls, progress } = makeInstaller();
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(calls.installFromUrl.length, 1);
	assert.equal(calls.installFromUrl[0].archiveUrl, dshRuntimeAssetDownloadUrl("atomgit", dshRuntimeArchiveName(process.platform, process.arch)), "归档文件名占位必须改写成当前 latest 应用 Release");
	assert.equal(calls.installFromUrl[0].sha256, "abc");
	// 结束时必须是 done=100，UI 据此收起进度条
	assert.equal(progress.at(-1).phase, "done");
	assert.equal(progress.at(-1).percent, 100);
});

test("installFromIndex：指定 Release tag 时 runtime 归档跟随同一应用版本", async () => {
	const { installer, calls } = makeInstaller({ releaseTag: "v0.7.6-beta" });
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(calls.installFromUrl[0].archiveUrl, `https://atomgit.com/ayuayue/PiDeck/releases/download/v0.7.6-beta/dsh-runtime-${process.platform}-${process.arch}.tgz`);
});

test("installFromIndex：file:// 归档不改写，离线验证直连本地文件", async () => {
	const localUrl = "file:///C:/tmp/dsh-runtime-win32-x64.tgz";
	const { installer, calls } = makeInstaller({
		index: { schemaVersion: 1, releases: [release({ url: localUrl })] },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(calls.installFromUrl[0].archiveUrl, localUrl);
});

test("installFromIndex：下载字节进度映射到 0-70%，阶段进度随后推进", async () => {
	const { installer, progress } = makeInstaller();
	await installer.installFromIndex();
	const downloading = progress.filter((p) => p.phase === "downloading");
	// 一半字节 → 约 35%，且不超过 70（给校验/解压留进度空间）
	assert.ok(
		downloading.some((p) => p.percent === 35),
		JSON.stringify(downloading),
	);
	assert.ok(downloading.every((p) => p.percent <= 70));
	assert.ok(progress.some((p) => p.phase === "extracting" && p.percent === 85));
});

test("installFromIndex：目标版本已装且校验通过时短路，不下载不解压", async () => {
	let checked;
	const { installer, calls, progress } = makeInstaller({
		manager: {
			isVersionInstalled: (version) => {
				checked = version;
				return true;
			},
		},
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(checked, "0.1.1-rc.2");
	assert.equal(calls.installFromUrl.length, 0, "已装版本不得再触发下载");
	// 短路也必须推送 done：UI 在发起时就进入了进度态，没有终止事件会一直转圈。
	assert.equal(progress.at(-1).phase, "done");
	assert.equal(progress.at(-1).percent, 100);
	assert.equal(progress.at(-1).runtimeVersion, "0.1.1-rc.2");
});

test("installFromIndex：isVersionInstalled 为 false（半残/损坏）时正常走重装", async () => {
	const { installer, calls } = makeInstaller({
		manager: { isVersionInstalled: () => false },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, true);
	assert.equal(calls.installFromUrl.length, 1);
});

test("installFromIndex：声明配套版本但索引只有旧版时失败，不再假成功（2026-10「点安装没反应」回归）", async () => {
	// 复现当时的现场：app 声明 0.2.0-rc.2，发布索引里只有 0.1.1-rc.2 且已装。
	// 旧实现把它判成「目标版本已装 → 跳过下载 → 成功」，UI 收到 done 但门控仍是
	// outdated，用户看到的就是点什么都没发生（日志里三条 skipping download）。
	const { installer, calls, progress } = makeInstaller({
		declared: "0.2.0-rc.2",
		manager: { isVersionInstalled: () => true },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(result.error, "runtime version unavailable: required=0.2.0-rc.2 available=0.1.1-rc.2");
	assert.equal(calls.installFromUrl.length, 0, "不相干的版本不该白下几十 MB");
	// 失败必须收口成 error 进度，否则 UI 停在乐观的「下载中」永久转圈。
	assert.equal(progress.at(-1).phase, "error");
});

test("installFromIndex：声明版本命中索引时照常安装（含已装短路、未装下载）", async () => {
	const installed = makeInstaller({ declared: "0.1.1-rc.2", manager: { isVersionInstalled: () => true } });
	assert.equal((await installed.installer.installFromIndex()).ok, true);
	assert.equal(installed.calls.installFromUrl.length, 0, "配套版本已装才允许短路");

	const fresh = makeInstaller({ declared: "0.1.1-rc.2", manager: { isVersionInstalled: () => false } });
	assert.equal((await fresh.installer.installFromIndex()).ok, true);
	assert.equal(fresh.calls.installFromUrl.length, 1);
});

test("installFromIndex：随包 runtime 与声明版本不一致时失败，不解压旧版", async () => {
	const bundled = { archivePath: "C:/pkg/dsh-runtime.tgz", manifest: { runtimeVersion: "0.1.1-rc.2", archiveSha256: "aa" } };
	const { installer, calls } = makeInstaller({ declared: "0.2.0-rc.2", bundled });
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.match(result.error, /^runtime version unavailable: required=0\.2\.0-rc\.2 available=0\.1\.1-rc\.2$/);
	assert.equal(calls.installFromArchive.length, 0);
});

test("installFromIndex：索引里没有兼容版本时不下载，避免下完才发现装不上", async () => {
	const { installer, calls, progress } = makeInstaller({
		index: { schemaVersion: 1, releases: [release({ minAppVersion: "9.0.0" })] },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(result.error, "no compatible runtime release");
	assert.equal(calls.installFromUrl.length, 0, "不该白耗几十 MB 流量");
	assert.equal(progress.at(-1).phase, "error");
});

test("installFromIndex：索引拉不到 / 未配置地址时失败且不下载", async () => {
	const noIndex = makeInstaller({ index: null });
	assert.equal((await noIndex.installer.installFromIndex()).error, "runtime index unavailable");
	assert.equal(noIndex.calls.installFromUrl.length, 0);

	const noUrl = makeInstaller({ url: "" });
	assert.equal((await noUrl.installer.installFromIndex()).error, "no runtime index url configured");
	assert.equal(noUrl.calls.installFromUrl.length, 0);
});

test("installFromIndex：落位失败时把原因带进进度事件（UI 能显示真实原因）", async () => {
	const { installer, progress } = makeInstaller({
		manager: { installFromUrl: () => ({ ok: false, error: "sha256 mismatch" }) },
	});
	const result = await installer.installFromIndex();
	assert.equal(result.ok, false);
	assert.equal(result.error, "sha256 mismatch");
	const last = progress.at(-1);
	assert.equal(last.phase, "error");
	assert.equal(last.error, "sha256 mismatch");
});

test("installFromLocalFile：走归档链路，不查索引也不联网", async () => {
	const { installer, calls, progress } = makeInstaller();
	const result = await installer.installFromLocalFile("C:/tmp/runtime.tgz");
	assert.equal(result.ok, true);
	assert.equal(calls.installFromArchive.length, 1);
	assert.equal(calls.installFromArchive[0], "C:/tmp/runtime.tgz");
	assert.equal(calls.installFromUrl.length, 0);
	assert.equal(progress.at(-1).phase, "done");
});

test("installFromLocalFile：本地导入失败时同样给出 error 进度", async () => {
	const { installer, progress } = makeInstaller({
		manager: { installFromArchive: () => ({ ok: false, error: "manifest missing" }) },
	});
	const result = await installer.installFromLocalFile("C:/tmp/bad.tgz");
	assert.equal(result.ok, false);
	assert.equal(progress.at(-1).error, "manifest missing");
});

test("installFromLocalFile：目录路径走 installFromDirectory，不查索引也不联网", async () => {
	const { installer, calls, progress } = makeInstaller();
	// installer 用 existsSync+statSync 判目录，必须给一个真实存在的目录才能走对分支
	const dir = mkdtempSync(join(tmpdir(), "dsh-import-dir-"));
	writeFileSync(join(dir, "manifest.json"), "{}");
	const result = await installer.installFromLocalFile(dir);
	assert.equal(result.ok, true);
	assert.equal(calls.installFromDirectory.length, 1);
	assert.equal(calls.installFromDirectory[0], dir);
	assert.equal(calls.installFromArchive.length, 0, "目录不应走归档解压链路");
	assert.equal(calls.installFromUrl.length, 0);
	assert.equal(progress.at(-1).phase, "done");
	rmSync(dir, { recursive: true, force: true });
});

test("installFromLocalFile：目录导入失败时同样给出 error 进度", async () => {
	const { installer, progress } = makeInstaller({
		manager: { installFromDirectory: () => ({ ok: false, error: "manifest missing" }) },
	});
	const dir = mkdtempSync(join(tmpdir(), "dsh-import-dir-"));
	const result = await installer.installFromLocalFile(dir);
	assert.equal(result.ok, false);
	assert.equal(progress.at(-1).error, "manifest missing");
	rmSync(dir, { recursive: true, force: true });
});

test("uninstall：卸载当前启用版本；没装时返回明确错误", async () => {
	const { installer, calls } = makeInstaller({
		manager: { resolveActive: { dirName: "0.1.1-rc.2", nodeModules: "x" } },
	});
	assert.equal((await installer.uninstall()).ok, true);
	assert.deepEqual(calls.uninstall, ["0.1.1-rc.2"]);

	const empty = makeInstaller();
	assert.equal((await empty.installer.uninstall()).error, "no runtime installed");
	assert.equal(empty.calls.uninstall.length, 0);
});

test("uninstall：manager 抛错（文件被占用）时收口成结构化错误，不再裸抛", async () => {
	const { installer, calls } = makeInstaller({
		manager: {
			resolveActive: { dirName: "0.1.1-rc.2", nodeModules: "x" },
			uninstall: () => {
				throw new Error("EPERM: operation not permitted");
			},
		},
	});
	// 复现回归：manager.uninstall 重试耗尽后抛 EPERM，installer 必须转成
	// { ok:false, error }，不能让裸异常跨 IPC 变成「未处理异常」。
	const result = await installer.uninstall();
	assert.equal(result.ok, false);
	assert.match(result.error, /EPERM/);
	assert.deepEqual(calls.uninstall, ["0.1.1-rc.2"]);
});
