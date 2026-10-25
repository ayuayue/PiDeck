/**
 * updateSource 一次性迁移单测（v0.7.5 默认源 github → atomgit）。
 *
 * SettingsStore 依赖 electron（app.getPath）无法直接 import，
 * 迁移逻辑抽成纯函数 migrateUpdateSourceToAtomgit 后用 loadTsCommonJs 加载验证。
 * 守护的边界：旧用户已保存 github → 补迁移；已迁移/未保存过 → 不动；后续显式保存尊重用户。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { migrateUpdateSourceToAtomgit } = loadTsCommonJs("src/main/settings/SettingsStore.ts");

test("旧用户已持久化 github 且未迁移：迁移为 atomgit 并写标记", () => {
	const settings = { updateSource: "github" };
	const changed = migrateUpdateSourceToAtomgit(settings);
	assert.equal(changed, true);
	assert.equal(settings.updateSource, "atomgit");
	assert.equal(settings.updateSourceAtomgitMigrated, true);
});

test("已迁移过（标记 true）：不再改动，用户显式保存的 github 生效", () => {
	const settings = { updateSource: "github", updateSourceAtomgitMigrated: true };
	const changed = migrateUpdateSourceToAtomgit(settings);
	assert.equal(changed, false);
	assert.equal(settings.updateSource, "github");
});

test("从未持久化过更新源（旧 JSON 缺字段）：不迁移（走新默认值 atomgit）", () => {
	const settings = {};
	const changed = migrateUpdateSourceToAtomgit(settings);
	assert.equal(changed, false);
	assert.equal(settings.updateSource, undefined);
});

test("已保存 atomgit：无需迁移，不改标记（幂等）", () => {
	const settings = { updateSource: "atomgit" };
	const changed = migrateUpdateSourceToAtomgit(settings);
	assert.equal(changed, false);
	assert.equal(settings.updateSource, "atomgit");
	assert.equal("updateSourceAtomgitMigrated" in settings, false);
});
