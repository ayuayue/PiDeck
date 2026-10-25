import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertSafeOutputDir, buildWslInvocation, buildWslProbeScript, buildWslResetScript, createSizedSessionJsonl, generateSessionFixtures, isAllowedWslFixtureDir, parseWslProbe, prepareOutputDirectory, shellQuote } from "../scripts/generate-session-fixtures.mjs";

const SHA = "724fe6b22020bb90e30393096f5ec2d4b42b64df";
const execFile = promisify(execFileCallback);

async function findPosixShell() {
	if (process.platform === "win32") return null;
	const candidates = [...new Set([process.env.SHELL, "/bin/sh", "sh"].filter(Boolean))];
	for (const command of candidates) {
		try {
			await execFile(command, ["-c", "exit 0"], { encoding: "utf8" });
			return command;
		} catch {}
	}
	return null;
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function withTempDir(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-fixtures-test-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function safety(root) {
	return {
		homeDir: join(root, "home"),
		repoRoot: join(root, "repo"),
		userProfile: join(root, "profile"),
		appDataDir: join(root, "profile", "AppData", "Roaming"),
		localAppDataDir: join(root, "profile", "AppData", "Local"),
	};
}

async function fixture(root, options = {}) {
	return generateSessionFixtures({
		outputDir: join(root, "evidence"),
		sha: SHA,
		largeTargetBytes: 32 * 1024,
		safety: safety(root),
		...options,
	});
}

test("fixture generation is deterministic across a bounded regeneration", async () => {
	await withTempDir(async (root) => {
		const outputDir = join(root, "evidence");
		await fixture(root);
		const paths = [join(outputDir, "sessions", "scale", "messages-100.jsonl"), join(outputDir, "sessions", "scale", "messages-1000.jsonl"), join(outputDir, "sessions", "scale", "messages-10000.jsonl"), join(outputDir, "sessions", "scale", "messages-50mb.jsonl"), join(outputDir, "fixture-manifest.json")];
		const first = await Promise.all(paths.map(async (path) => digest(await readFile(path))));
		await fixture(root);
		const second = await Promise.all(paths.map(async (path) => digest(await readFile(path))));
		assert.deepEqual(second, first);
	});
});

test("the large JSONL fixture is exactly 50 MiB and remains valid line-delimited JSON", () => {
	const targetBytes = 50 * 1024 * 1024;
	const content = createSizedSessionJsonl({ label: "size-boundary", targetBytes, cwd: "F:/validation/project" });
	assert.equal(Buffer.byteLength(content), targetBytes);
	const lines = content.trimEnd().split("\n");
	assert.equal(JSON.parse(lines[0]).type, "session");
	assert.equal(JSON.parse(lines.at(-1)).type, "message");
});

test("manifest records scale reachability, separate templates, scenario mapping, and stat metadata", async () => {
	await withTempDir(async (root) => {
		const manifest = await fixture(root);
		assert.equal(manifest.version, 2);
		assert.equal(manifest.sha, SHA);
		assert.equal(manifest.fixtureManifestPath, join(root, "evidence", "fixture-manifest.json"));
		assert.deepEqual(
			Object.keys(manifest.scale.messages).sort((a, b) => Number(a) - Number(b)),
			["100", "1000", "10000"],
		);
		assert.equal(manifest.scale.large.bytes, 32 * 1024);
		assert.equal(manifest.nativeIdentity.expectedIndependentSessionCount, 1);
		assert.equal(new Set(manifest.nativeIdentity.expectedOriginKeys).size, 1);
		assert.equal(manifest.importIdentity.source, "codex");
		assert.equal(manifest.importIdentity.importedSourceId, "codex-thread-validation-001");
		assert.equal(manifest.userData.native.wsl, undefined);
		assert.equal(manifest.userData.wsl, null);
		assert.equal(manifest.scenarios.A3.userDataTemplate, "native");
		assert.equal(manifest.scenarios.A7.catalog, "corrupt");
		assert.equal(manifest.scenarios.A9, null);
		for (const path of [
			...manifest.nativeIdentity.paths,
			manifest.userData.native.settings,
			manifest.userData.native.projects,
			manifest.userData.native.catalog.primary,
			manifest.userData.native.catalog.backup,
			manifest.userData.native.catalog.corrupt,
			manifest.importIdentity.sourcePath,
			manifest.importIdentity.targetPath,
		]) {
			assert.equal(isAbsolute(path), true, path);
			const info = await stat(path);
			assert.equal(info.isFile(), true, path);
			assert.ok(info.size > 0, path);
		}
		assert.equal(JSON.parse(await readFile(manifest.userData.native.catalog.primary, "utf8")).sessions.length, 6);
		await assert.rejects(async () => JSON.parse(await readFile(manifest.userData.native.catalog.corrupt, "utf8")));
		const source = (await readFile(manifest.importIdentity.sourcePath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const target = (await readFile(manifest.importIdentity.targetPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(source[0], {
			type: "session_meta",
			payload: {
				id: manifest.importIdentity.importedSourceId,
				cwd: manifest.projectCwd,
				timestamp: "2026-01-15T08:00:00.000Z",
				model_provider: "openai",
				model: "codex-validation",
				thread_source: "user",
			},
		});
		assert.deepEqual(
			target.slice(0, 3).map((entry) => entry.type ?? entry.sessionName),
			["session", "Validate imported session identity", "codex_import"],
		);
		assert.equal(target[2].codexSessionId, manifest.importIdentity.importedSourceId);
		assert.equal(target[2].sourcePath, manifest.importIdentity.sourcePath);
		assert.equal(target[2].sourceMtime, manifest.importIdentity.sourceMtime);
		assert.equal(target[2].sourceSize, manifest.importIdentity.sourceSize);
		assert.equal(target[3].type, "model_change");
		assert.equal(target[4].message.role, "user");
		assert.equal(target[5].message.role, "assistant");
		assert.equal(target[5].message.api, "codex-import");
		assert.equal(target[5].message.model, "codex-validation");
		assert.equal(target[5].message.usage.totalTokens, 0);
		assert.equal((await stat(manifest.importIdentity.sourcePath)).mtimeMs, manifest.importIdentity.sourceMtime);
		assert.equal((await stat(manifest.importIdentity.sourcePath)).size, manifest.importIdentity.sourceSize);
	});
});

test("WSL probe and reset reject raw, noncanonical, traversal, non-ext4, mismatch, and symlink escapes", async () => {
	assert.match(buildWslProbeScript("o'neil"), /realpath/);
	assert.match(buildWslProbeScript("o'neil"), /findmnt/);
	const reset = buildWslResetScript({ home: "/home/o'neil", sha: SHA });
	assert.match(reset, /rm -rf --/);
	assert.match(reset, /realpath --/);
	assert.match(reset, /pideck-validation-/);
	assert.equal(parseWslProbe("RAW_HOME=/home/dev\nHOME=/home/dev\nUSER=dev\nFSTYPE=ext4\n").FSTYPE, "ext4");
	for (const [directory, home] of [
		["/mnt/c/tmp/pideck-validation-" + SHA, "/mnt/c/tmp"],
		["/mnt/.pi/agent/sessions/pideck-validation-" + SHA, "/mnt"],
		["/home/dev/.pi/agent/sessions/pideck-validation-" + SHA + "/../escape", "/home/dev"],
		["/home/dev/.pi/agent/sessions/pideck-validation-" + SHA, "/home/dev/../dev"],
		["/home/dev/.pi/agent/sessions-other/pideck-validation-" + SHA, "/home/dev"],
		["/home/dev/.pi/agent/sessions//pideck-validation-" + SHA, "/home/dev"],
	])
		assert.equal(isAllowedWslFixtureDir(directory, home), false);
	assert.equal(isAllowedWslFixtureDir(`/home/dev/.pi/agent/sessions/pideck-validation-${SHA}`, "/home/dev"), true);

	await withTempDir(async (root) => {
		const runner = async () => ({ stdout: "RAW_HOME=/home/dev\nHOME=/home/dev\nUSER=dev\nFSTYPE=xfs\n" });
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/home/dev", runner }), /not ext4/);
		await assert.rejects(stat(join(root, "evidence")), /ENOENT/);
		const mismatchRunner = async () => ({ stdout: "RAW_HOME=/home/dev\nHOME=/home/dev\nUSER=other\nFSTYPE=ext4\n" });
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/home/dev", runner: mismatchRunner }), /user mismatch/);
		const rawHomeMismatchRunner = async () => ({ stdout: "RAW_HOME=/home/dev-link\nHOME=/home/dev\nUSER=dev\nFSTYPE=ext4\n" });
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/home/dev", runner: rawHomeMismatchRunner }), /realpath mismatch/);
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/home/dev/../dev", runner }), /traversal/);
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/mnt", runner }), /ext4 POSIX/);
	});
});

test("WSL generation uses parameter arrays, safe local shell argv, exact POSIX cwd, and conditional template", async () => {
	await withTempDir(async (root) => {
		const calls = [];
		const runner = async (command, args, options = {}) => {
			calls.push({ command, args, options });
			if (calls.length === 1) return { stdout: "RAW_HOME=/home/o'neil\nHOME=/home/o'neil\nUSER=o'neil\nFSTYPE=ext4\n" };
			return { stdout: "" };
		};
		const manifest = await fixture(root, {
			wslDistro: "Ubuntu Test; echo unsafe",
			wslUser: "o'neil",
			wslRoot: "/home/o'neil",
			runner,
		});
		assert.equal(calls.length, 4);
		for (const call of calls) {
			assert.equal(call.command, "wsl.exe");
			assert.deepEqual(call.args, ["-d", "Ubuntu Test; echo unsafe", "-u", "o'neil", "--", "sh", "-s"]);
		}
		const resetScript = calls[1].options.input;
		assert.match(resetScript, /rm -rf --/);
		assert.match(resetScript, /realpath/);
		assert.match(resetScript, /'\"'\"'/);
		assert.equal(manifest.wslIdentity.expectedIndependentSessionCount, 2);
		assert.equal(manifest.scenarios.A9.userDataTemplate, "wsl");
		assert.equal(manifest.userData.wsl.projects, join(root, "evidence", "user-data", "wsl", "projects.json"));
		assert.equal(manifest.userData.wsl.catalog.backup.endsWith("session-catalog.json.bak"), true);
		assert.equal(manifest.userData.wsl.catalog.corrupt.endsWith("session-catalog.corrupt.json"), true);
		assert.equal(manifest.wslIdentity.projectCwd, `/home/o'neil/.pi/agent/sessions/pideck-validation-${SHA}/project`);
		assert.equal(manifest.wslIdentity.directory, `/home/o'neil/.pi/agent/sessions/pideck-validation-${SHA}`);
	});
});

test("a WSL reset failure leaves an owned marker that supports a safe native regeneration", async () => {
	await withTempDir(async (root) => {
		let calls = 0;
		const resetFailureRunner = async () => {
			calls += 1;
			if (calls === 1) return { stdout: "RAW_HOME=/home/dev\nHOME=/home/dev\nUSER=dev\nFSTYPE=ext4\n" };
			throw new Error("simulated WSL reset failure");
		};
		await assert.rejects(fixture(root, { wslDistro: "Ubuntu", wslUser: "dev", wslRoot: "/home/dev", runner: resetFailureRunner }), /simulated WSL reset failure/);
		const markerPath = join(root, "evidence", ".pideck-session-fixtures.json");
		assert.equal(JSON.parse(await readFile(markerPath, "utf8")).version, 2);
		const recovered = await fixture(root);
		assert.equal(recovered.wslIdentity, null);
		assert.equal((await stat(recovered.fixtureManifestPath)).isFile(), true);
	});
});

test("shell quoting and WSL invocation keep shell text out of argument positions", async () => {
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
	const invocation = buildWslInvocation({
		distro: "Ubuntu;false",
		user: "dev user;false",
		script: "printf ok",
	});
	assert.equal(invocation.command, "wsl.exe");
	assert.deepEqual(invocation.args, ["-d", "Ubuntu;false", "-u", "dev user;false", "--", "sh", "-s"]);
	assert.equal(invocation.args[1], "Ubuntu;false");
	assert.equal(invocation.args[3], "dev user;false");
	assert.equal(invocation.options.input, "printf ok");
	const boundaryPayload = "literal; touch /tmp/pideck-injected; echo escaped";
	const boundaryScript = `printf %s ${shellQuote(boundaryPayload)}`;
	const boundaryInvocation = buildWslInvocation({
		distro: "Ubuntu; touch /tmp/distro-injected",
		user: "dev; touch /tmp/user-injected",
		script: boundaryScript,
	});
	assert.deepEqual(boundaryInvocation.args, ["-d", "Ubuntu; touch /tmp/distro-injected", "-u", "dev; touch /tmp/user-injected", "--", "sh", "-s"]);
	assert.equal(boundaryInvocation.options.input, boundaryScript);
	assert.doesNotMatch(JSON.stringify(boundaryInvocation.args), /literal|pideck-injected|escaped/);

	const shellCommand = await findPosixShell();
	if (!shellCommand) return;

	await withTempDir(async (root) => {
		const output = join(root, "quoted-output.txt");
		const injected = join(root, "injected-by-shell");
		const payload = `literal; touch ${injected}; echo escaped`;
		const script = `set -eu; printf %s ${shellQuote(payload)} > ${shellQuote(output)}`;
		const execution = execFile(shellCommand, ["-s"], { encoding: "utf8" });
		execution.child.stdin.end(script);
		await execution;
		assert.equal(await readFile(output, "utf8"), payload);
		await assert.rejects(readFile(injected, "utf8"));
	});
});

test("cleanup refuses unmarked output and protected real paths while preserving unrelated marked content", async () => {
	await withTempDir(async (root) => {
		const unmarked = join(root, "unmarked");
		await writeFile(join(root, "placeholder"), "keep", "utf8");
		await assert.rejects(prepareOutputDirectory(root), /unmarked output directory/);
		await prepareOutputDirectory(unmarked);
		await writeFile(join(unmarked, "foreign"), "x", "utf8");
		await assert.rejects(prepareOutputDirectory(unmarked), /unmarked output directory/);

		const outputDir = join(root, "owned");
		const generationOptions = { outputDir, sha: SHA, largeTargetBytes: 32 * 1024, safety: safety(root) };
		await generateSessionFixtures(generationOptions);
		await writeFile(join(outputDir, "operator-note.txt"), "keep", "utf8");
		await generateSessionFixtures(generationOptions);
		assert.equal(await readFile(join(outputDir, "operator-note.txt"), "utf8"), "keep");
		const paths = [join(root, "repo", "child"), join(root, "profile"), join(root, "profile", "AppData"), join(root, "profile", "AppData", "Roaming", "child"), join(root, "profile", "AppData", "Local", "child")];
		for (const path of paths) await assert.rejects(assertSafeOutputDir(path, safety(root)), /protected|home/);

		const redirectTarget = join(root, "repo");
		const redirect = join(root, "redirect");
		await mkdir(redirectTarget, { recursive: true });
		await symlink(redirectTarget, redirect, "junction");
		await assert.rejects(assertSafeOutputDir(join(redirect, "child"), safety(root)), /protected/);
	});
});
