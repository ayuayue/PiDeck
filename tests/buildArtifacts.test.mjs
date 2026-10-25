import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { extractHtmlResourceReferences, verifyBuildArtifacts } from "../scripts/verify-build-artifacts.mjs";

async function withTempRepo(run) {
	const repo = await mkdtemp(join(tmpdir(), "pideck-artifacts-test-"));
	try {
		return await run(repo);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
}

async function put(path, content = "content") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function createBuildFixture(repo) {
	const sourceFiles = [join(repo, "src", "main", "index.ts"), join(repo, "src", "preload", "index.ts"), join(repo, "src", "renderer", "src", "main.tsx"), join(repo, "electron.vite.config.ts"), join(repo, "package.json")];
	for (const source of sourceFiles) await put(source, "source");
	const artifactFiles = [join(repo, "out", "main", "index.js"), join(repo, "out", "preload", "index.js"), join(repo, "out", "renderer", "assets", "app.js"), join(repo, "out", "renderer", "assets", "pet.js"), join(repo, "out", "renderer", "assets", "web.js"), join(repo, "out", "renderer", "assets", "style.css")];
	for (const artifact of artifactFiles) await put(artifact, "artifact");
	const indexHtml = join(repo, "out", "renderer", "index.html");
	const petHtml = join(repo, "out", "renderer", "pet.html");
	const webHtml = join(repo, "out", "renderer", "web.html");
	await put(indexHtml, '<link href="/assets/style.css" rel="stylesheet"><script src="/assets/app.js"></script>');
	await put(petHtml, '<script type="module" src="./assets/pet.js?hash=1"></script>');
	await put(webHtml, '<script type="module" src="./assets/web.js?hash=1"></script>');
	artifactFiles.push(indexHtml, petHtml, webHtml);
	const sourceTime = new Date("2026-01-01T00:00:00Z");
	const artifactTime = new Date("2026-01-01T00:01:00Z");
	await Promise.all(sourceFiles.map((path) => utimes(path, sourceTime, sourceTime)));
	await Promise.all(artifactFiles.map((path) => utimes(path, artifactTime, artifactTime)));
	return { sourceFiles, artifactFiles, indexHtml, petHtml, webHtml };
}

test("an empty build output fails with all required Electron entry points", async () => {
	await withTempRepo(async (repo) => {
		await mkdir(join(repo, "out"));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.equal(result.errors.length, 5);
		assert.match(result.errors.join("\n"), /main\/index\.js|main\\index\.js/);
		assert.match(result.errors.join("\n"), /preload\/index\.js|preload\\index\.js/);
		assert.match(result.errors.join("\n"), /renderer[/\\]index\.html/);
		assert.match(result.errors.join("\n"), /renderer[/\\]pet\.html/);
		assert.match(result.errors.join("\n"), /renderer[/\\]web\.html/);
	});
});

test("a complete temporary build fixture passes entry, resource, and freshness checks", async () => {
	await withTempRepo(async (repo) => {
		await createBuildFixture(repo);
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.checked.length, 9);
	});
});

test("missing and escaping HTML resource references fail verification", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		await put(fixture.indexHtml, '<script src="/assets/missing.js"></script><link href="../../outside.css">');
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Missing HTML resource/);
		assert.match(result.errors.join("\n"), /escapes renderer output/);
	});
});

test("malformed encoded references and non-regular or empty resources fail verification", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		await mkdir(join(repo, "out", "renderer", "assets", "directory"), { recursive: true });
		await put(join(repo, "out", "renderer", "assets", "empty.js"), "");
		await put(fixture.indexHtml, '<script src="/assets/%ZZ.js"></script><script src="/assets/empty.js"></script><link href="/assets/directory">');
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\\n"), /Malformed HTML resource path/);
		assert.match(result.errors.join("\\n"), /Empty or invalid HTML resource/);
	});
});

test("artifacts older than relevant source inputs are reported as stale", async () => {
	await withTempRepo(async (repo) => {
		const fixture = await createBuildFixture(repo);
		const staleTime = new Date("2025-12-01T00:00:00Z");
		await Promise.all(fixture.artifactFiles.map((path) => utimes(path, staleTime, staleTime)));
		const result = await verifyBuildArtifacts({ repoRoot: repo });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Stale main artifact/);
		assert.match(result.errors.join("\n"), /Stale preload artifact/);
		assert.match(result.errors.join("\n"), /Stale renderer artifact/);
	});
});

test("HTML reference extraction ignores remote, data, and fragment URLs", () => {
	assert.deepEqual(
		extractHtmlResourceReferences(`
		<script src="/assets/app.js"></script>
		<link href="https://example.test/style.css">
		<img src="data:image/png;base64,abc">
		<a href="#section">section</a>
	`),
		["/assets/app.js"],
	);
});
