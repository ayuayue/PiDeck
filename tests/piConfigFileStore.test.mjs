import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readPiConfigFile, writePiConfigFile, revisionOf, stripBom, readStringArraySetting } = loadTsCommonJs("src/main/config/piConfigFileStore.ts");

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-piconfig-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readPiConfigFile reports missing, valid, and broken files", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		const missing = await readPiConfigFile(path);
		assert.equal(missing.exists, false);
		assert.equal(missing.error, undefined);
		assert.equal(missing.revision, revisionOf("", false));

		writeFileSync(path, '{\n  "defaultTools": ["read"],\n  "future": 1\n}\n', "utf8");
		const ok = await readPiConfigFile(path);
		assert.equal(ok.exists, true);
		assert.deepEqual([...ok.data.defaultTools], ["read"]);
		assert.equal(ok.data.future, 1);
		assert.equal(ok.revision, revisionOf(ok.raw, true));

		writeFileSync(path, "{ not json", "utf8");
		const broken = await readPiConfigFile(path);
		assert.ok(broken.error);
		assert.equal(broken.exists, true);
		// 原文保留（可视化保存会被 error 拦住，不会用空对象覆盖）
		assert.match(broken.raw, /not json/);

		writeFileSync(path, "[1,2,3]", "utf8");
		const notObject = await readPiConfigFile(path);
		assert.match(notObject.error ?? "", /must be a JSON object/);
	} finally {
		cleanup();
	}
});

test("BOM and string-array helpers", () => {
	assert.equal(stripBom("\uFEFF{}"), "{}");
	assert.equal(stripBom("{}"), "{}");
	assert.deepEqual([...readStringArraySetting({ extensions: ["a", 1, null, "b"] }, "extensions")], ["a", "b"]);
	assert.deepEqual([...readStringArraySetting({}, "extensions")], []);
});

test("writePiConfigFile patches only the mutated keys and preserves unknown fields", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ extensions: ["!keep.ts"], packages: [{ source: "npm:x", future: true }], unknownRoot: { deep: 1 } }, null, 2), "utf8");
		const result = await writePiConfigFile(path, (current) => ({ ...current, extensions: [...current.extensions, "-builtin:mcp"] }));
		assert.equal(result.ok, true);
		const written = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(written.extensions, ["!keep.ts", "-builtin:mcp"]);
		assert.deepEqual(written.packages, [{ source: "npm:x", future: true }]);
		assert.deepEqual(written.unknownRoot, { deep: 1 });
	} finally {
		cleanup();
	}
});

test("writePiConfigFile rejects a stale expectedRevision without touching the file", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, '{"extensions":[]}', "utf8");
		const before = readFileSync(path, "utf8");
		const result = await writePiConfigFile(path, (current) => ({ ...current, extensions: ["-builtin:mcp"] }), { expectedRevision: "deadbeef" });
		assert.equal(result.ok, false);
		assert.equal(result.conflict, true);
		assert.equal(readFileSync(path, "utf8"), before);
	} finally {
		cleanup();
	}
});

test("writePiConfigFile refuses to write over broken JSON", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, "{ broken", "utf8");
		const result = await writePiConfigFile(path, (current) => ({ ...current, extensions: [] }));
		assert.equal(result.ok, false);
		assert.ok(result.error);
		assert.equal(readFileSync(path, "utf8"), "{ broken");
	} finally {
		cleanup();
	}
});

test("writePiConfigFile creates a missing file and returns the new revision", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "nested", "settings.json");
		const result = await writePiConfigFile(path, () => ({ extensions: ["-builtin:mcp"] }));
		assert.equal(result.ok, true);
		assert.ok(existsSync(path));
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(parsed.extensions, ["-builtin:mcp"]);
		assert.equal(result.revision, revisionOf(readFileSync(path, "utf8"), true));
	} finally {
		cleanup();
	}
});

test("a missing settings file can be toggled with its summary revision without leaving a placeholder", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		const before = await readPiConfigFile(path);
		const rejected = await writePiConfigFile(path, () => ({ abort: "cancelled" }), { expectedRevision: before.revision });
		assert.equal(rejected.ok, false);
		assert.equal(existsSync(path), false, "aborted writes must not create user config");
		const saved = await writePiConfigFile(path, () => ({ extensions: ["-builtin:codemode"] }), { expectedRevision: before.revision });
		assert.equal(saved.ok, true, saved.error);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).extensions, ["-builtin:codemode"]);
	} finally {
		cleanup();
	}
});

test("Windows config writes keep the temporary file in the same directory", async () => {
	const writes = [];
	const renames = [];
	const raw = '{"extensions":[]}';
	const path = "C:\\Users\\test user\\.pi\\agent\\settings.json";
	const load = createTsSandbox({
		stubs: {
			"node:path": win32,
			"node:fs": { existsSync: () => true },
			"node:fs/promises": {
				mkdir: async () => {},
				readFile: async () => raw,
				writeFile: async (target) => {
					assert.equal(win32.dirname(target), win32.dirname(path), "temporary paths must use basename, not slash slicing");
					writes.push(target);
				},
				rename: async (source, target) => renames.push([source, target]),
				rm: async () => {},
			},
			"proper-lockfile": { lock: async () => async () => {} },
		},
	});
	const store = load("src/main/config/piConfigFileStore.ts");
	const result = await store.writePiConfigFile(path, (current) => ({ ...current, extensions: ["-builtin:codemode"] }));
	assert.equal(result.ok, true, result.error);
	assert.match(win32.basename(writes[0]), /^\.settings\.json\..*\.tmp$/);
	assert.equal(renames[0][1], path);
});

test("a failed atomic rename cleans up only its own temporary file", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, '{"extensions":[]}', "utf8");
		const before = readFileSync(path, "utf8");
		const load = createTsSandbox({
			stubs: {
				"node:fs/promises": {
					...fsPromises,
					rename: async () => {
						throw new Error("rename denied");
					},
				},
			},
		});
		const store = load("src/main/config/piConfigFileStore.ts");
		const result = await store.writePiConfigFile(path, () => ({ extensions: ["-builtin:codemode"] }));
		assert.equal(result.ok, false);
		assert.match(result.error, /rename denied/);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(dirname(path)), ["settings.json"]);
	} finally {
		cleanup();
	}
});

test("serialized concurrent writes keep both changes (lock + re-read)", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, '{"extensions":[]}', "utf8");
		// 两个"页面"几乎同时提交窄 patch：锁内重读保证两次修改都留下
		await Promise.all([writePiConfigFile(path, (current) => ({ ...current, extensions: [...current.extensions, "-builtin:mcp"] })), writePiConfigFile(path, (current) => ({ ...current, extensions: [...current.extensions, "-builtin:codemode"] }))]);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual([...parsed.extensions].sort(), ["-builtin:codemode", "-builtin:mcp"]);
	} finally {
		cleanup();
	}
});

test("expectedRevision missing 哨兵：允许从无到有写入；文件出现后同哨兵拒绝", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const path = join(dir, "settings.json");
		const created = await writePiConfigFile(path, () => ({ extensions: ["-builtin:mcp"] }), { expectedRevision: revisionOf("", false) });
		assert.equal(created.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).extensions, ["-builtin:mcp"]);

		const staleMissing = await writePiConfigFile(path, () => ({ extensions: [] }), { expectedRevision: revisionOf("", false) });
		assert.equal(staleMissing.ok, false);
		assert.equal(staleMissing.conflict, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).extensions, ["-builtin:mcp"]);
	} finally {
		cleanup();
	}
});
