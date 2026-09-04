import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compileModule(filePath, requireOverride = () => null) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) => {
				const dependency = requireOverride(specifier);
				if (dependency) return dependency;
				throw new Error(`Unexpected dependency: ${specifier}`);
			},
			URL,
			decodeURIComponent,
			Error,
			Promise,
			String,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const versionCompare = compileModule("src/main/utils/versionCompare.ts");
const macManualUpdate = compileModule("src/main/update/macManualUpdate.ts", (specifier) => {
	if (specifier === "electron") return { net: { fetch: async () => { throw new Error("not used in test"); } } };
	if (specifier === "../utils/versionCompare") return versionCompare;
	if (specifier === "./releaseRepo") {
		return { RELEASES_URL: "https://github.com/ayuayue/PiDeck/releases" };
	}
	return null;
});

const {
	MAC_MANUAL_LATEST_RELEASE_URL,
	createMacManualUpdateChecker,
	parseGitHubReleaseVersion,
} = macManualUpdate;

test("parseGitHubReleaseVersion accepts a redirected latest-release tag only", () => {
	assert.equal(
		parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4"),
		"0.7.4",
	);
	assert.equal(
		parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/tag/0.7.4-beta.1"),
		"0.7.4-beta.1",
	);
	assert.equal(parseGitHubReleaseVersion("https://github.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("not a URL"), null);
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

test("manual macOS checker surfaces HTTP and malformed redirect failures", async () => {
	const unavailable = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({ ok: false, status: 503, url: "" }),
	});
	await assert.rejects(() => unavailable("0.7.3"), /503/);

	const malformed = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: "https://github.com/ayuayue/PiDeck/releases/latest",
		}),
	});
	await assert.rejects(() => malformed("0.7.3"), /did not resolve/);
});
