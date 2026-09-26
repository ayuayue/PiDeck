import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MAC_MANUAL_LATEST_RELEASE_URL, createMacManualUpdateChecker, parseGitHubReleaseVersion, parseLatestReleaseTagFromJson, resolveLatestReleaseVersion, shouldReadJsonBody } = loadTsCommonJs("src/main/update/macManualUpdate.ts", {
	stubs: {
		electron: {
			net: {
				fetch: async () => {
					throw new Error("not used in test");
				},
			},
		},
	},
});

// dev 通道 releases 列表 URL 与 ChannelSwitchService 同源（GITHUB_RELEASES_API）；单独加载取常量做断言。
const { GITHUB_RELEASES_API } = loadTsCommonJs("src/main/update/ChannelSwitchService.ts");

test("parseGitHubReleaseVersion accepts a redirected latest-release tag only", () => {
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4"), "0.7.4");
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/0.7.4-beta.1"), "0.7.4-beta.1");
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("https://atomgit.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("not a URL"), null);
});

test("parseLatestReleaseTagFromJson reads AtomGit / GitHub REST tag_name", () => {
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "v0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson("{"), null);
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ name: "v0.7.6" })), null);
});

test("resolveLatestReleaseVersion prefers a GitHub tag URL, then JSON tag_name", () => {
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
			body: JSON.stringify({ tag_name: "v9.9.9" }),
		}),
		"0.7.4",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest",
			body: JSON.stringify({ tag_name: "v0.7.6" }),
		}),
		"0.7.6",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://atomgit.com/ayuayue/PiDeck/releases/latest",
		}),
		null,
	);
});

test("shouldReadJsonBody is true for OpenAPI hosts and JSON content types", () => {
	assert.equal(shouldReadJsonBody("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest", "text/plain"), true);
	assert.equal(shouldReadJsonBody("https://api.github.com/repos/ayuayue/PiDeck/releases/latest", ""), true);
	assert.equal(shouldReadJsonBody("https://github.com/ayuayue/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://atomgit.com/ayuayue/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://example.com/latest", "application/json; charset=utf-8"), true);
});

test("manual macOS checker uses the static latest redirect and detects beta -> stable", async () => {
	let requestedUrl = "";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
			};
		},
	});

	const result = await check("0.7.3-beta");
	assert.equal(requestedUrl, MAC_MANUAL_LATEST_RELEASE_URL);
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, true);
});

test("manual macOS checker does not flag the same stable version", async () => {
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4",
		}),
	});

	const result = await check("0.7.4");
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker reads AtomGit OpenAPI tag_name when the HTML page has no tag URL", async () => {
	let requestedUrl = "";
	const apiUrl = "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url: apiUrl,
				body: JSON.stringify({ tag_name: "v0.7.6", release_status: "latest" }),
			};
		},
	});

	const result = await check("0.7.6", apiUrl);
	assert.equal(requestedUrl, apiUrl);
	assert.equal(result.latestVersion, "0.7.6");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker surfaces HTTP and unresolved latest-release failures", async () => {
	const unavailable = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({ ok: false, status: 503, url: "" }),
	});
	await assert.rejects(() => unavailable("0.7.3"), /503/);

	const spaShell = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: "https://atomgit.com/ayuayue/PiDeck/releases/latest",
		}),
	});
	await assert.rejects(() => spaShell("0.7.3"), /did not resolve/);
});

test("dev channel picks the newest prerelease from the releases list without the /latest redirect", async () => {
	const requestedUrls = [];
	const check = createMacManualUpdateChecker({
		channel: "dev",
		platform: "darwin",
		arch: "arm64",
		fetchReleases: async (url) => {
			requestedUrls.push(url);
			return {
				ok: true,
				status: 200,
				body: JSON.stringify([
					{ tag_name: "v0.7.4", prerelease: false, assets: [{ name: "PiDeck-0.7.4-arm64.dmg", browser_download_url: "https://github.com/ayuayue/PiDeck/releases/download/v0.7.4/x.dmg" }] },
					{ tag_name: "v0.8.0-beta.1", prerelease: true, assets: [{ name: "PiDeck-0.8.0-beta.1-arm64.dmg", browser_download_url: "https://github.com/ayuayue/PiDeck/releases/download/v0.8.0-beta.1/x.dmg" }] },
					{
						tag_name: "v0.8.0-beta.2",
						prerelease: true,
						html_url: "https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0-beta.2",
						assets: [{ name: "PiDeck-0.8.0-beta.2-arm64.dmg", browser_download_url: "https://github.com/ayuayue/PiDeck/releases/download/v0.8.0-beta.2/x.dmg" }],
					},
				]),
			};
		},
		fetchLatestRelease: async () => {
			throw new Error("dev path must not use /latest");
		},
	});

	const result = await check("0.7.3-beta");
	// dev 走 GitHub Releases API 全量列表（复用任务 6 GITHUB_RELEASES_API），不碰 /latest 302。
	assert.deepEqual(requestedUrls, [GITHUB_RELEASES_API]);
	assert.equal(result.latestVersion, "0.8.0-beta.2");
	assert.equal(result.hasUpdate, true);
});

test("dev channel surfaces a check error when no prerelease carries installable assets", async () => {
	const check = createMacManualUpdateChecker({
		channel: "dev",
		platform: "darwin",
		arch: "arm64",
		fetchReleases: async () => ({
			ok: true,
			status: 200,
			body: JSON.stringify([{ tag_name: "v0.8.0-beta.1", prerelease: true, assets: [] }]),
		}),
	});
	await assert.rejects(() => check("0.7.3-beta"), /prerelease/);
});
