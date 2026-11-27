import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 只让指定文件的读取失败；目录和原子替换始终可写。 */
function failRead(t, filePath, code) {
	const error = Object.assign(new Error(code), { code });
	const readFile = t.mock.fn(async (path, ...args) => {
		if (path === filePath) throw error;
		return fs.readFile(path, ...args);
	});
	const writeFile = t.mock.fn(fs.writeFile);
	const rename = t.mock.fn(fs.rename);
	return { error, readFile, writeFile, rename, stubs: { "node:fs/promises": { ...fs, readFile, writeFile, rename } } };
}

const stores = [
	{ name: "FavoritesStore", module: "src/main/favorites/FavoritesStore.ts", file: "favorites.json", state: { version: 1, entries: [{ id: "saved", kind: "message", createdAt: 1, text: "保留收藏" }] } },
	{ name: "SessionGroupStore", module: "src/main/sessionGroups/sessionGroupStore.ts", file: "session-groups.json", state: { version: 1, migratedAt: 1, groups: [{ id: "saved", name: "保留分组" }] } },
];

for (const { name, module, file, state } of stores) {
	for (const code of ["EACCES", "EIO"]) {
		test(`${name} 读取返回 ${code} 时保留存档，恢复读取后可重新加载`, async (t) => {
			const dir = await fs.mkdtemp(join(tmpdir(), "pideck-store-read-"));
			t.after(() => fs.rm(dir, { recursive: true, force: true }));
			const path = join(dir, file);
			const original = JSON.stringify(state);
			await fs.writeFile(path, original);
			const io = failRead(t, path, code);
			const Store = loadTsCommonJs(module, { stubs: io.stubs })[name];
			const store = new Store(path);

			await assert.rejects(store.load(), (error) => error === io.error);
			assert.equal(io.writeFile.mock.callCount(), 0);
			assert.equal(io.rename.mock.callCount(), 0);
			assert.equal(await fs.readFile(path, "utf8"), original);

			io.readFile.mock.mockImplementation(fs.readFile);
			await store.load();
			assert.deepEqual(
				Array.from(store.list(), (item) => item.id),
				["saved"],
			);
		});
	}
}

test("旧插件分组暂时不可读时不写迁移标记，重试可导入原有分组", async (t) => {
	const dir = await fs.mkdtemp(join(tmpdir(), "pideck-group-migration-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session-groups.json");
	const legacyPath = join(dir, "legacy.json");
	await fs.writeFile(legacyPath, JSON.stringify({ "ws.meta": { groups: [{ id: "legacy", name: "旧分组" }] } }));
	const io = failRead(t, legacyPath, "EACCES");
	const { SessionGroupStore } = loadTsCommonJs("src/main/sessionGroups/sessionGroupStore.ts", { stubs: io.stubs });
	const store = new SessionGroupStore(path, legacyPath);

	await assert.rejects(store.load(), (error) => error === io.error);
	assert.equal(io.writeFile.mock.callCount(), 0);
	assert.equal(io.rename.mock.callCount(), 0);
	await assert.rejects(fs.readFile(path), { code: "ENOENT" });

	io.readFile.mock.mockImplementation(fs.readFile);
	await store.load();
	const persisted = JSON.parse(await fs.readFile(path, "utf8"));
	assert.deepEqual(
		persisted.groups.map((group) => group.id),
		["legacy"],
	);
	assert.equal(typeof persisted.migratedAt, "number");
});
