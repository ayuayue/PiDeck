/**
 * 手动更新「设备 → 推荐安装包」纯规则单测。
 *
 * 资产名取自真实 v0.9.1 Release（GitHub/AtomGit 同名），覆盖三平台 + 两架构 +
 * 各安装形态；同时验证 blockmap / latest.yml / dsh-runtime / node 运行时等
 * 非安装包资产不会被误选。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { classifyInstallerAsset, looksLikeDebInstall, preferredAssetKinds, resolveManualUpdateTarget, resolveReleasePageUrl, selectNewestRelease, selectRecommendedAsset, toManualUpdateRelease } = loadTsCommonJs("src/main/update/manualUpdateSelection.ts");

/** v0.9.1 真实附件名（含必须被排除的非安装包资产）。 */
const RELEASE_ASSETS = [
	{ name: "v0.9.1.zip", browser_download_url: "https://example.com/v0.9.1.zip" },
	{ name: "v0.9.1.tar.gz", browser_download_url: "https://example.com/v0.9.1.tar.gz" },
	{ name: "dsh-runtime-darwin-arm64.tgz", browser_download_url: "https://example.com/dsh-runtime-darwin-arm64.tgz" },
	{ name: "node-v24.13.0-win-x64.zip", browser_download_url: "https://example.com/node.zip" },
	{ name: "latest.yml", browser_download_url: "https://example.com/latest.yml" },
	{ name: "latest-linux.yml", browser_download_url: "https://example.com/latest-linux.yml" },
	{ name: "PiDeck-0.9.1-arm64.dmg.blockmap", browser_download_url: "https://example.com/PiDeck-0.9.1-arm64.dmg.blockmap" },
	{ name: "PiDeck-0.9.1-arm64.dmg", browser_download_url: "https://example.com/PiDeck-0.9.1-arm64.dmg", size: 120_000_000 },
	{ name: "PiDeck-0.9.1-x64.dmg", browser_download_url: "https://example.com/PiDeck-0.9.1-x64.dmg", size: 118_000_000 },
	{ name: "PiDeck-0.9.1-arm64.zip", browser_download_url: "https://example.com/PiDeck-0.9.1-arm64.zip" },
	{ name: "PiDeck-0.9.1-x64.zip", browser_download_url: "https://example.com/PiDeck-0.9.1-x64.zip" },
	{ name: "PiDeck-0.9.1-setup.exe", browser_download_url: "https://example.com/PiDeck-0.9.1-setup.exe" },
	{ name: "PiDeck-0.9.1-setup.exe.blockmap", browser_download_url: "https://example.com/PiDeck-0.9.1-setup.exe.blockmap" },
	{ name: "PiDeck-0.9.1-portable.exe", browser_download_url: "https://example.com/PiDeck-0.9.1-portable.exe" },
	{ name: "PiDeck-0.9.1-win.zip", browser_download_url: "https://example.com/PiDeck-0.9.1-win.zip" },
	{ name: "PiDeck_0.9.1_amd64.deb", browser_download_url: "https://example.com/PiDeck_0.9.1_amd64.deb" },
	{ name: "PiDeck_0.9.1_arm64.deb", browser_download_url: "https://example.com/PiDeck_0.9.1_arm64.deb" },
	{ name: "PiDeck-0.9.1-x64.tar.gz", browser_download_url: "https://example.com/PiDeck-0.9.1-x64.tar.gz" },
	{ name: "PiDeck-0.9.1-arm64.tar.gz", browser_download_url: "https://example.com/PiDeck-0.9.1-arm64.tar.gz" },
	{ name: "PiDeck-x86_64.AppImage", browser_download_url: "https://example.com/PiDeck-x86_64.AppImage" },
	{ name: "PiDeck-arm64.AppImage", browser_download_url: "https://example.com/PiDeck-arm64.AppImage" },
];

test("resolveManualUpdateTarget: macOS 原生/Rosetta、Windows 便携、Linux AppImage/deb", () => {
	const macArm = resolveManualUpdateTarget({ platform: "darwin", arch: "arm64" });
	assert.equal(macArm?.arch, "arm64");
	assert.equal(macArm?.translated, false);

	// Rosetta：进程是 x64，但应推荐原生 arm64 包。
	const rosetta = resolveManualUpdateTarget({ platform: "darwin", arch: "x64", runningUnderArm64Translation: true });
	assert.equal(rosetta?.arch, "arm64");
	assert.equal(rosetta?.translated, true);

	const winPortable = resolveManualUpdateTarget({ platform: "win32", arch: "x64", isPortable: true });
	assert.equal(winPortable?.installKind, "portable");
	const winInstalled = resolveManualUpdateTarget({ platform: "win32", arch: "x64" });
	assert.equal(winInstalled?.installKind, "installed");

	const linuxAppImage = resolveManualUpdateTarget({ platform: "linux", arch: "x64", isAppImage: true });
	assert.equal(linuxAppImage?.installKind, "appimage");
	const linuxDeb = resolveManualUpdateTarget({ platform: "linux", arch: "arm64", execPath: "/opt/PiDeck/pideck" });
	assert.equal(linuxDeb?.installKind, "deb");
	assert.equal(linuxDeb?.arch, "arm64");

	assert.equal(resolveManualUpdateTarget({ platform: "freebsd", arch: "x64" }), null);
});

test("looksLikeDebInstall: 只认 electron-builder deb 的默认安装目录", () => {
	assert.equal(looksLikeDebInstall("/opt/PiDeck/pideck"), true);
	assert.equal(looksLikeDebInstall("/usr/lib/pideck/pideck"), true);
	assert.equal(looksLikeDebInstall("/home/me/Applications/PiDeck/pideck"), false);
	assert.equal(looksLikeDebInstall(undefined), false);
});

test("classifyInstallerAsset: 识别三平台安装包并排除非安装包资产", () => {
	assert.equal(classifyInstallerAsset("PiDeck-0.9.1-arm64.dmg", "darwin")?.kind, "dmg");
	assert.equal(classifyInstallerAsset("PiDeck-0.9.1-x64.dmg", "darwin")?.arch, "x64");
	assert.equal(classifyInstallerAsset("PiDeck-0.9.1-setup.exe", "win32")?.kind, "nsis");
	assert.equal(classifyInstallerAsset("PiDeck-0.9.1-portable.exe", "win32")?.kind, "portable");
	assert.equal(classifyInstallerAsset("PiDeck_0.9.1_amd64.deb", "linux")?.arch, "x64");
	assert.equal(classifyInstallerAsset("PiDeck_0.9.1_arm64.deb", "linux")?.arch, "arm64");
	assert.equal(classifyInstallerAsset("PiDeck-x86_64.AppImage", "linux")?.kind, "appimage");
	assert.equal(classifyInstallerAsset("PiDeck-arm64.AppImage", "linux")?.arch, "arm64");

	assert.equal(classifyInstallerAsset("PiDeck-0.9.1-arm64.dmg.blockmap", "darwin"), null);
	assert.equal(classifyInstallerAsset("latest-linux.yml", "linux"), null);
	assert.equal(classifyInstallerAsset("v0.9.1.zip", "darwin"), null);
	assert.equal(classifyInstallerAsset("v0.9.1.tar.gz", "linux"), null);
	assert.equal(classifyInstallerAsset("dsh-runtime-darwin-arm64.tgz", "darwin"), null);
	assert.equal(classifyInstallerAsset("node-v24.13.0-win-x64.zip", "win32"), null);
});

test("selectRecommendedAsset: 按真实 v0.9.1 资产为每类设备选中正确包", () => {
	const pick = (target) => selectRecommendedAsset(RELEASE_ASSETS, target)?.name ?? null;

	assert.equal(pick({ platform: "darwin", arch: "arm64", installKind: "installed", translated: false }), "PiDeck-0.9.1-arm64.dmg");
	assert.equal(pick({ platform: "darwin", arch: "x64", installKind: "installed", translated: false }), "PiDeck-0.9.1-x64.dmg");
	assert.equal(pick({ platform: "win32", arch: "x64", installKind: "installed", translated: false }), "PiDeck-0.9.1-setup.exe");
	assert.equal(pick({ platform: "win32", arch: "x64", installKind: "portable", translated: false }), "PiDeck-0.9.1-portable.exe");
	assert.equal(pick({ platform: "linux", arch: "x64", installKind: "appimage", translated: false }), "PiDeck-x86_64.AppImage");
	assert.equal(pick({ platform: "linux", arch: "arm64", installKind: "appimage", translated: false }), "PiDeck-arm64.AppImage");
	assert.equal(pick({ platform: "linux", arch: "x64", installKind: "deb", translated: false }), "PiDeck_0.9.1_amd64.deb");
	assert.equal(pick({ platform: "linux", arch: "arm64", installKind: "deb", translated: false }), "PiDeck_0.9.1_arm64.deb");
});

test("selectRecommendedAsset: 首选格式缺失时按优先级退化；无匹配返回 null", () => {
	const noDmg = RELEASE_ASSETS.filter((asset) => !asset.name.endsWith(".dmg"));
	assert.equal(selectRecommendedAsset(noDmg, { platform: "darwin", arch: "arm64", installKind: "installed", translated: false })?.name, "PiDeck-0.9.1-arm64.zip");

	const onlyX64 = [{ name: "PiDeck-0.9.1-x64.dmg", browser_download_url: "https://example.com/x64.dmg" }];
	assert.equal(selectRecommendedAsset(onlyX64, { platform: "darwin", arch: "arm64", installKind: "installed", translated: false }), null);

	// 非 https 的资产不进入下载候选，避免降级到明文传输。
	assert.equal(selectRecommendedAsset([{ name: "PiDeck-0.9.1-arm64.dmg", browser_download_url: "http://example.com/a.dmg" }], { platform: "darwin", arch: "arm64", installKind: "installed", translated: false }), null);
});

test("preferredAssetKinds: 先保持当前安装形态，再选可直接运行的格式", () => {
	// 跨 realm 数组不能 deepStrictEqual，按字符串断言顺序。
	assert.equal(preferredAssetKinds({ platform: "win32", arch: "x64", installKind: "portable", translated: false }).join(","), "portable,zip,nsis");
	assert.equal(preferredAssetKinds({ platform: "linux", arch: "x64", installKind: "deb", translated: false }).join(","), "deb,appimage,tar.gz");
	assert.equal(preferredAssetKinds({ platform: "darwin", arch: "arm64", installKind: "installed", translated: true }).join(","), "dmg,zip");
});

test("toManualUpdateRelease: 归一版本/资产/架构，AtomGit 无 html_url 时按 tag 拼发布页", () => {
	const release = {
		tag_name: "v0.9.1",
		prerelease: false,
		assets: RELEASE_ASSETS,
	};
	const recommended = toManualUpdateRelease(release, { platform: "darwin", arch: "arm64", installKind: "installed", translated: true }, "atomgit");
	assert.ok(recommended);
	assert.equal(recommended.version, "0.9.1");
	assert.equal(recommended.assetName, "PiDeck-0.9.1-arm64.dmg");
	assert.equal(recommended.assetUrl, "https://example.com/PiDeck-0.9.1-arm64.dmg");
	assert.equal(recommended.assetSize, 120_000_000);
	assert.equal(recommended.translated, true);
	assert.equal(recommended.releasePageUrl, "https://atomgit.com/ayuayue/PiDeck/releases/tag/v0.9.1");

	assert.equal(resolveReleasePageUrl("https://github.com/ayuayue/PiDeck/releases/tag/v0.9.1", "github", "v0.9.1"), "https://github.com/ayuayue/PiDeck/releases/tag/v0.9.1");
});

test("selectNewestRelease: stable 取最新正式版，dev 取最新预发布", () => {
	const releases = [
		{ tag_name: "v0.9.0", prerelease: false },
		{ tag_name: "v0.9.1", prerelease: false },
		{ tag_name: "v0.10.0-beta.1", prerelease: true },
		{ tag_name: "v0.10.0-beta.2", prerelease: true },
	];
	assert.equal(selectNewestRelease(releases, "stable")?.tag_name, "v0.9.1");
	assert.equal(selectNewestRelease(releases, "dev")?.tag_name, "v0.10.0-beta.2");
	assert.equal(selectNewestRelease([], "stable"), null);
});
