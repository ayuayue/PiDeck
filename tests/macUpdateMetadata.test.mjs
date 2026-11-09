import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load, dump } from "js-yaml";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import { mergeMacUpdateInfo } from "../scripts/merge-mac-update-metadata.mjs";

const SHA_X64 = Buffer.alloc(64, 1).toString("base64");
const SHA_ARM64 = Buffer.alloc(64, 2).toString("base64");
function info(arch, version = "0.12.1", prefix = "PiDeck") {
	const url = `${prefix}-${version}-${arch}.zip`;
	const sha512 = arch === "arm64" ? SHA_ARM64 : SHA_X64;
	return { version, files: [{ url, sha512, size: 1234 }], path: url, sha512, releaseDate: "2026-11-09T00:00:00.000Z" };
}

test("merged metadata feeds the native ZIP to Intel, Apple Silicon and Rosetta clients", () => {
	const result = mergeMacUpdateInfo([info("arm64"), info("x64")], "0.12.1");
	const files = result.files.map((file) => ({ url: new URL(file.url, "https://example.test/"), info: file }));
	assert.deepEqual(
		MacUpdater.filterFilesForArch(files, false).map((file) => file.info.url),
		["PiDeck-0.12.1-x64.zip"],
	);
	assert.deepEqual(
		MacUpdater.filterFilesForArch(files, true).map((file) => file.info.url),
		["PiDeck-0.12.1-arm64.zip"],
	);
	assert.equal(result.path, "PiDeck-0.12.1-x64.zip");
	assert.equal(result.files.find((file) => file.url.includes("arm64")).sha512, SHA_ARM64);
});

for (const [name, documents] of [
	["missing arm64 ZIP", [info("x64")]],
	["mismatched release versions", [info("x64"), info("arm64", "0.12.0")]],
	["malformed file digest", [info("x64"), { ...info("arm64"), files: [{ url: "PiDeck-0.12.1-arm64.zip", sha512: "bad", size: 1234 }] }]],
	["different channel branding", [info("x64"), info("arm64", "0.12.1", "PiDeck-Dev")]],
]) {
	test(`metadata publication rejects ${name}`, () => {
		assert.throws(() => mergeMacUpdateInfo(documents, "0.12.1"));
	});
}

test("both publishing workflows run the merge after architecture builds and withhold per-job feeds", async (t) => {
	for (const [file, buildJob] of [
		["release.yml", "build-release"],
		["build-dev.yml", "build-dev"],
	]) {
		const workflow = load(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
		const publish = workflow.jobs["publish-mac-update-metadata"];
		assert.ok(publish.needs.includes(buildJob));
		const release = workflow.jobs[buildJob].steps.find((step) => step.name === "Upload release assets");
		assert.match(release.with.files, /matrix\.platform != 'macos'/);
		const publisher = load(await readFile(new URL(`../${publish.uses}`, import.meta.url), "utf8"));
		const merge = publisher.jobs.publish.steps.find((step) => step.name === "Merge and validate both architectures");
		const root = await mkdtemp(join(tmpdir(), "pideck-workflow-mac-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const [executable, script, ...args] = merge.run.trim().split(/\s+/);
		assert.equal(executable, "node");
		for (const arch of ["x64", "arm64"]) {
			const dir = join(root, "release", "mac-metadata-inputs", arch);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "latest-mac.yml"), dump(info(arch)));
		}
		const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args.map((arg) => (arg === '"$VERSION"' ? "0.12.1" : arg))], { cwd: root, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, `${file}: ${result.stderr}`);
		assert.equal(load(await readFile(join(root, "release/mac-metadata/latest-mac.yml"), "utf8")).files.length, 2);
	}
});

test("the CLI merges stable and beta metadata from separate architecture artifacts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mac-metadata-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const arch of ["x64", "arm64"]) {
		await mkdir(join(root, "inputs", arch), { recursive: true });
		await writeFile(join(root, "inputs", arch, "latest-mac.yml"), dump(info(arch, "0.12.1-beta.1", "PiDeck-Dev")));
		await writeFile(join(root, "inputs", arch, "beta-mac.yml"), dump(info(arch, "0.12.1-beta.1", "PiDeck-Dev")));
	}
	const result = spawnSync(process.execPath, ["scripts/merge-mac-update-metadata.mjs", "--input-dir", join(root, "inputs"), "--output-dir", join(root, "outputs"), "--version", "0.12.1-beta.1"], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr);
	for (const file of ["latest-mac.yml", "beta-mac.yml"]) {
		const merged = load(await readFile(join(root, "outputs", file), "utf8"));
		assert.equal(merged.version, "0.12.1-beta.1");
		assert.equal(merged.files.length, 2);
	}
});
