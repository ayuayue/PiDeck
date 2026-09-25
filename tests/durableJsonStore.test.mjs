import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { writeDurableJsonFile } = loadTsCommonJs("src/main/persistence/durableJsonStore.ts");

test("durable writes sync a temp snapshot, rotate the previous primary, and honor recovery skip", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-durable-json-"));
	const filePath = join(directory, "store.json");
	const backupPath = `${filePath}.bak`;
	try {
		await writeDurableJsonFile(filePath, '{"revision":1}', { backupPath });
		assert.equal(await readFile(filePath, "utf8"), '{"revision":1}');
		await assert.rejects(readFile(backupPath, "utf8"), { code: "ENOENT" });

		await writeDurableJsonFile(filePath, '{"revision":2}', { backupPath });
		assert.equal(await readFile(filePath, "utf8"), '{"revision":2}');
		assert.equal(await readFile(backupPath, "utf8"), '{"revision":1}');

		await writeDurableJsonFile(filePath, '{"revision":3}', { backupPath, skipBackup: true });
		assert.equal(await readFile(filePath, "utf8"), '{"revision":3}');
		assert.equal(await readFile(backupPath, "utf8"), '{"revision":1}');

		await writeDurableJsonFile(filePath, '{"revision":4}', { backupPath });
		assert.equal(await readFile(filePath, "utf8"), '{"revision":4}');
		assert.equal(await readFile(backupPath, "utf8"), '{"revision":3}');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
