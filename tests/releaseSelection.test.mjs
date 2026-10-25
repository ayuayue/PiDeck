/**
 * releaseSelection 纯函数单测（Task 6 步骤 2，规格 §3）：
 * - 目标 stable 选最新非 prerelease；目标 dev 选最新 prerelease；
 * - 无匹配（通道内无 release / 无平台资产）返回 null（服务层转结构化错误）；
 * - 资产匹配按 platform/arch 过滤：win x64 → NSIS Setup .exe；mac arm64/x64 → .dmg；linux x64 → .AppImage；
 * - 无资产 release 跳过、回退更旧的可安装 release；tag v 前缀剥离；notes 截断 300；digest 透传/缺失。
 * 纯函数无网络依赖，直接经 loadTsCommonJs 加载生产模块。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { selectTargetRelease, inverseChannel } = loadTsCommonJs("src/main/update/releaseSelection.ts");
const { RELEASES_URL } = loadTsCommonJs("src/main/update/releaseRepo.ts");

/** 固定 mock releases：stable 正式 ×2、dev prerelease ×3（最新无资产）、无 tag 项。 */
const MOCK_RELEASES = [
	{
		tag_name: "v0.7.4",
		prerelease: false,
		body: "stable older",
		html_url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
		assets: [{ name: "PiDeck-0.7.4-setup.exe", browser_download_url: "https://github.com/a/PiDeck-0.7.4-setup.exe" }],
	},
	{
		tag_name: "0.7.5",
		prerelease: false,
		body: "stable newest",
		html_url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.5",
		assets: [{ name: "PiDeck-0.7.5-setup.exe", browser_download_url: "https://github.com/a/PiDeck-0.7.5-setup.exe" }],
	},
	{
		tag_name: "v0.8.0-beta.2",
		prerelease: true,
		body: "dev newest（无平台资产，应被跳过）",
		html_url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0-beta.2",
		assets: [],
	},
	{
		tag_name: "v0.8.0-beta.1",
		prerelease: true,
		body: "dev installable",
		html_url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0-beta.1",
		assets: [
			{ name: "PiDeck-0.8.0-beta.1-setup.exe", browser_download_url: "https://github.com/a/setup.exe", digest: "sha256:abc123", size: 1024 },
			{ name: "PiDeck-0.8.0-beta.1-arm64.dmg", browser_download_url: "https://github.com/a/arm64.dmg", size: 2048 },
			{ name: "PiDeck-0.8.0-beta.1-x64.dmg", browser_download_url: "https://github.com/a/x64.dmg", size: 2048 },
			{ name: "PiDeck-x64.AppImage", browser_download_url: "https://github.com/a/AppImage", size: 4096 },
			{ name: "PiDeck-0.8.0-beta.1-win.zip", browser_download_url: "https://github.com/a/win.zip" },
		],
	},
	{
		prerelease: false,
		body: "缺 tag_name，应被忽略",
		assets: [],
	},
];

test("stable 目标：选最新非 prerelease（0.7.5），v 前缀剥离", () => {
	const release = selectTargetRelease(MOCK_RELEASES, "stable", "win32", "x64");
	assert.ok(release);
	assert.equal(release.version, "0.7.5");
	assert.equal(release.assetName, "PiDeck-0.7.5-setup.exe");
});

test("dev 目标：选最新带可安装资产的 prerelease（无资产的 beta.2 跳过，回退 beta.1）", () => {
	const release = selectTargetRelease(MOCK_RELEASES, "dev", "win32", "x64");
	assert.ok(release);
	assert.equal(release.version, "0.8.0-beta.1");
	assert.equal(release.assetName, "PiDeck-0.8.0-beta.1-setup.exe");
	// digest 形如 "sha256:hex"（GitHub API 可选字段）：存在则透传。
	assert.equal(release.digestSha256, "sha256:abc123");
	assert.equal(release.releasePageUrl, "https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0-beta.1");
});

test("资产匹配：mac arm64 选 arm64.dmg，mac x64 排除 arm64.dmg，linux x64 选 .AppImage", () => {
	const arm64 = selectTargetRelease(MOCK_RELEASES, "dev", "darwin", "arm64");
	assert.ok(arm64);
	assert.equal(arm64.assetName, "PiDeck-0.8.0-beta.1-arm64.dmg");

	const x64Mac = selectTargetRelease(MOCK_RELEASES, "dev", "darwin", "x64");
	assert.ok(x64Mac);
	assert.equal(x64Mac.assetName, "PiDeck-0.8.0-beta.1-x64.dmg");

	const linux = selectTargetRelease(MOCK_RELEASES, "dev", "linux", "x64");
	assert.ok(linux);
	assert.equal(linux.assetName, "PiDeck-x64.AppImage");
});

test("win 匹配排除 portable/zip 等非 NSIS 资产", () => {
	const releases = [
		{
			tag_name: "v1.0.0",
			prerelease: false,
			assets: [
				{ name: "PiDeck-1.0.0-portable.exe", browser_download_url: "https://github.com/a/portable.exe" },
				{ name: "PiDeck-1.0.0-win.zip", browser_download_url: "https://github.com/a/win.zip" },
				{ name: "PiDeck-1.0.0-setup.exe", browser_download_url: "https://github.com/a/setup.exe" },
			],
		},
	];
	const release = selectTargetRelease(releases, "stable", "win32", "x64");
	assert.ok(release);
	assert.equal(release.assetName, "PiDeck-1.0.0-setup.exe");
});

test("无匹配：通道内无 release / 有 release 但无平台资产 / 空 releases → null", () => {
	assert.equal(selectTargetRelease(MOCK_RELEASES, "dev", "linux", "arm64"), null);
	assert.equal(selectTargetRelease([], "stable", "win32", "x64"), null);
	assert.equal(selectTargetRelease([{ tag_name: "v1.0.0", prerelease: false, assets: [{ name: "other.txt", browser_download_url: "https://github.com/a.txt" }] }], "stable", "win32", "x64"), null);
});

test("digest 缺失 → digestSha256 undefined；html_url 缺失回退仓库 releases 页", () => {
	const release = selectTargetRelease([{ tag_name: "v1.2.3", prerelease: false, body: "note", assets: [{ name: "PiDeck-1.2.3-setup.exe", browser_download_url: "https://github.com/a/setup.exe" }] }], "stable", "win32", "x64");
	assert.ok(release);
	assert.equal(release.digestSha256, undefined);
	assert.equal(release.releasePageUrl, RELEASES_URL);
});

test("notesExcerpt 截断 300 字符", () => {
	const longBody = "x".repeat(500);
	const release = selectTargetRelease([{ tag_name: "v1.0.0", prerelease: false, body: longBody, assets: [{ name: "PiDeck-1.0.0-setup.exe", browser_download_url: "https://github.com/a/setup.exe" }] }], "stable", "win32", "x64");
	assert.ok(release);
	assert.equal(release.notesExcerpt.length, 301); // 300 + 截断省略号
	assert.ok(release.notesExcerpt.startsWith("x".repeat(300)));
});

test("inverseChannel：dev→stable、stable→dev（查询目标 = 反向通道）", () => {
	assert.equal(inverseChannel("dev"), "stable");
	assert.equal(inverseChannel("stable"), "dev");
});
