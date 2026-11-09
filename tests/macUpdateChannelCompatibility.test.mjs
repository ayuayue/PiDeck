import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import "app-builder-lib";
import { MacPackager } from "app-builder-lib/out/macPackager.js";
import { getPublishConfigs } from "app-builder-lib/out/publish/PublishManager.js";
import { createUpdateInfoTasks } from "app-builder-lib/out/publish/updateInfoBuilder.js";
import { Arch, serializeToYaml } from "builder-util";
import { HttpError } from "builder-util-runtime";
import { SemVer } from "semver";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import { mergeLatestYml, serializeLatestYml } from "../scripts/merge-latest-mac-yml.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Use the actual builder's resolved GitHub configuration and metadata generator, without packaging. */
async function buildUpdateTasks(version) {
	const config = structuredClone(pkg.build);
	config.releaseInfo = { releaseNotes: "Update compatibility fixture" };
	const info = { metadata: { ...pkg, version }, config };
	const packager = new MacPackager(info);
	info.appInfo = packager.appInfo;
	const tasks = [];
	for (const [name, arch] of [
		["x64", Arch.x64],
		["arm64", Arch.arm64],
	]) {
		const publish = await getPublishConfigs(packager, null, arch, false);
		tasks.push(...(await createUpdateInfoTasks({ packager, arch, file: `/fixture/PiDeck-${version}-${name}.zip`, target: { outDir: "/fixture/release" }, updateInfo: { sha512: Buffer.alloc(64, arch + 1).toString("base64"), size: 1234 } }, publish)));
	}
	return tasks;
}

for (const version of ["0.12.1", "0.12.1-beta.1"]) {
	test(`GitHub builds of ${version} generate latest-mac.yml for both architectures`, async () => {
		const tasks = await buildUpdateTasks(version);
		assert.deepEqual(
			tasks.map((task) => basename(task.file)),
			["latest-mac.yml", "latest-mac.yml"],
		);
		const merged = mergeLatestYml(tasks.map((task) => ({ text: serializeToYaml(task.info, false, true) })));
		assert.equal(merged.files.length, 2);
	});
}

test("the prerelease GitHub provider falls back to the merged latest manifest and selects native ZIPs", async () => {
	const version = "0.12.1-beta.1";
	const tasks = await buildUpdateTasks(version);
	const manifest = serializeLatestYml(mergeLatestYml(tasks.map((task) => ({ text: serializeToYaml(task.info, false, true) }))));
	const paths = [];
	const executor = {
		async request(options) {
			paths.push(options.path);
			if (options.path.endsWith("releases.atom")) return `<feed><entry><title>Beta</title><link href="https://github.com/ayuayue/PiDeck/releases/tag/v${version}"/><content>Beta changes</content></entry></feed>`;
			if (options.path.endsWith("/beta-mac.yml")) throw new HttpError(404, "Not Found");
			if (options.path.endsWith("/latest-mac.yml")) return manifest;
			throw new Error(`Unexpected update request: ${options.path}`);
		},
	};
	const updater = { allowPrerelease: true, currentVersion: new SemVer("0.12.0-beta.1"), fullChangelog: false };
	const provider = new GitHubProvider({ provider: "github", owner: "ayuayue", repo: "PiDeck" }, updater, { executor, platform: "darwin" });
	const result = await provider.getLatestVersion();
	assert.equal(result.version, version);
	assert.deepEqual(paths.slice(1), [`/ayuayue/PiDeck/releases/download/v${version}/beta-mac.yml`, `/ayuayue/PiDeck/releases/download/v${version}/latest-mac.yml`]);
	const files = provider.resolveFiles(result);
	assert.deepEqual(
		MacUpdater.filterFilesForArch(files, false).map((file) => file.info.url),
		[`PiDeck-${version}-x64.zip`],
	);
	assert.deepEqual(
		MacUpdater.filterFilesForArch(files, true).map((file) => file.info.url),
		[`PiDeck-${version}-arm64.zip`],
	);
});
