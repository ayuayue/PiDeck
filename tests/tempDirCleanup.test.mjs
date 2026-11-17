import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./helpers/tempDir.mjs", import.meta.url).href;

function run(t, body, keep = false) {
	const parent = mkdtempSync(join(tmpdir(), "pideck-temp-helper-test-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { mkdtempSync, mkdtemp, cleanupTempDirs } from ${JSON.stringify(helper)}; import { join } from 'node:path'; import { renameSync, mkdirSync, writeFileSync } from 'node:fs'; const parent = process.argv[1]; ${body}`, parent], {
		encoding: "utf8",
		env: { ...process.env, PIDECK_E2E_KEEP: keep ? "1" : "" },
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	return { parent, paths: result.stdout.trim().split("\n") };
}

test("sync and async temporary directories are removed on process exit", (t) => {
	const { paths } = run(t, `console.log(mkdtempSync(join(parent, 'sync-'))); console.log(await mkdtemp(join(parent, 'async-'))); process.exit(0);`);
	assert.equal(paths.length, 2);
	for (const path of paths) assert.equal(existsSync(path), false);
});

test("KEEP preserves owned directories for diagnosis", (t) => {
	const { paths } = run(t, `console.log(mkdtempSync(join(parent, 'keep-')));`, true);
	assert.equal(existsSync(paths[0]), true);
});

test("cleanup skips a replacement directory and never sweeps matching neighbours", (t) => {
	const { parent, paths } = run(t, `const path = mkdtempSync(join(parent, 'owned-')); renameSync(path, path + '-moved'); mkdirSync(path); writeFileSync(join(path, 'user.txt'), 'keep replacement'); const neighbour = join(parent, 'owned-neighbour'); mkdirSync(neighbour); cleanupTempDirs(); console.log(path);`);
	assert.equal(readFileSync(join(paths[0], "user.txt"), "utf8"), "keep replacement");
	assert.equal(existsSync(join(parent, "owned-neighbour")), true);
	assert.equal(existsSync(`${paths[0]}-moved`), true);
});
