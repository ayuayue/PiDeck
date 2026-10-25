import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { migrateMergedSessionPinnedIds } = loadTsCommonJs("src/main/sessions/sessionPinnedIdsMigration.ts");

/** 主进程迁移入口的最小装配：catalog 条目、settings 读写与日志都按生产注入形状提供。 */
function harness({ sessions, pinned, writeFails = false }) {
	const writes = [];
	const warnings = [];
	const deps = {
		listCatalogSessions: () => sessions,
		readPinnedSessionIds: () => pinned,
		writePinnedSessionIds: async (ids) => {
			if (writeFails) throw new Error("settings.json is read-only");
			writes.push(ids);
		},
		logWarning: (cause) => warnings.push(cause),
	};
	return { deps, writes, warnings };
}

test("#354 pinned settings ids are migrated to the surviving session id", async () => {
	const sessions = [{ id: "survivor", mergedSessionIds: ["absorbed", "older-absorbed"] }, { id: "other" }];
	const { deps, writes } = harness({ sessions, pinned: ["absorbed", "other"] });
	await migrateMergedSessionPinnedIds(deps);
	// sandbox 里创建的数组属于 vm realm：展开成外层数组再比对，避免 prototype 不等。
	assert.deepEqual(
		writes.map((ids) => [...ids]),
		[["survivor", "other"]],
	);
});

test("#354 pinned migration keeps unknown ids and aliases that point at a real session", async () => {
	// 别名指向真实存在的其他会话时不是归并别名（那条记录是独立会话）；未知 ID 是用户数据，
	// 一律原样保留——迁移只做旧 ID → 现存 ID，不做清理。
	const sessions = [{ id: "survivor", mergedSessionIds: ["absorbed"] }, { id: "absorbed" }, { id: "unrelated" }];
	const { deps, writes } = harness({ sessions, pinned: ["absorbed", "unrelated", "unknown-id"] });
	await migrateMergedSessionPinnedIds(deps);
	assert.deepEqual(writes, []);
});

test("#354 pinned migration is a no-op when settings already reference surviving ids", async () => {
	const { deps, writes } = harness({ sessions: [{ id: "survivor", mergedSessionIds: ["absorbed"] }], pinned: ["survivor"] });
	await migrateMergedSessionPinnedIds(deps);
	assert.deepEqual(writes, [], "an unchanged list must not trigger a settings write");
});

test("#354 a failed pinned write reports the cause without rejecting startup", async () => {
	const { deps, writes, warnings } = harness({ sessions: [{ id: "survivor", mergedSessionIds: ["absorbed"] }], pinned: ["absorbed"], writeFails: true });
	await migrateMergedSessionPinnedIds(deps);
	assert.deepEqual(writes, []);
	assert.deepEqual(warnings, ["settings.json is read-only"]);
});
