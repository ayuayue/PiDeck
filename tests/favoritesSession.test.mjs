import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

const { parseAddFavoriteInput } = loadTsCommonJs("src/main/favorites/favoriteInput.ts");
const { FavoritesStore } = loadTsCommonJs("src/main/favorites/FavoritesStore.ts");
const { collectFavoritedSessionIds, findSessionFavorite } = loadTsCommonJs("src/renderer/src/components/favorites/favoriteIdentity.ts");
const { filterFavorites } = loadTsCommonJs("src/renderer/src/components/favorites/favoriteFilters.ts");

/** 会话收藏 = 引用（sessionId + 标题 + 项目），正文恒为空；原会话删除后条目保留。 */
const sessionInput = (overrides = {}) => ({ kind: "session", text: "", sessionId: "s1", sessionTitle: "会话一", projectId: "p1", ...overrides });

async function withStore(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-favorites-session-"));
	try {
		await run(join(dir, "favorites.json"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("parseAddFavoriteInput：会话收藏允许空正文，但必须有 sessionId", () => {
	const parsed = parseAddFavoriteInput(sessionInput({ text: "调用方误传的正文" }));
	assert.equal(parsed.kind, "session");
	assert.equal(parsed.text, "", "会话收藏不复制正文");
	assert.equal(parsed.sessionId, "s1");
	assert.equal(parsed.role, null);
	assert.equal(parsed.messageId, null);
	assert.equal(parsed.partial, false);
	assert.throws(() => parseAddFavoriteInput(sessionInput({ sessionId: "" })), /sessionId/);
	// 消息/片段仍然必须带正文，不能因为新增 session 分支而放宽。
	assert.throws(() => parseAddFavoriteInput({ kind: "message", text: "   " }), /text is empty/);
});

test("FavoritesStore：会话收藏落盘为空正文引用，重启后仍保留", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const entry = await store.add(parseAddFavoriteInput(sessionInput()), 1_000);
		assert.equal(entry.kind, "session");
		assert.equal(entry.text, "");
		assert.equal(entry.sessionTitle, "会话一");
		assert.equal(entry.projectId, "p1");

		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(persisted.entries[0].kind, "session");
		assert.equal(persisted.entries[0].text, "");

		const reloaded = await new FavoritesStore(filePath).load();
		assert.equal(reloaded.length, 1);
		assert.equal(reloaded[0].sessionId, "s1");
	});
});

test("FavoritesStore：读盘时保留空正文会话，丢弃缺 sessionId 或正文为空的普通条目", async () => {
	await withStore(async (filePath) => {
		const entries = [
			{ id: "session", createdAt: 1, kind: "session", text: "", sessionId: "s1", sessionTitle: "会话" },
			{ id: "no-session-id", createdAt: 2, kind: "session", text: "" },
			{ id: "empty-message", createdAt: 3, kind: "message", text: "" },
		];
		await writeFile(filePath, JSON.stringify({ version: 1, entries }), "utf8");
		const loaded = await new FavoritesStore(filePath).load();
		assert.deepEqual([...loaded.map((entry) => entry.id)], ["session"]);
	});
});

test("会话收藏身份：按 sessionId 去重/切换，不把消息收藏算进来", () => {
	const entries = [
		{ id: "a", kind: "session", sessionId: "s1", text: "", sessionTitle: "会话一" },
		{ id: "b", kind: "message", sessionId: "s1", messageId: "m1", text: "回复" },
		{ id: "c", kind: "session", sessionId: "s2", text: "" },
	];
	const ids = collectFavoritedSessionIds(entries);
	assert.deepEqual([...ids].sort(), ["s1", "s2"]);
	assert.equal(findSessionFavorite(entries, "s1")?.id, "a");
	assert.equal(findSessionFavorite(entries, "missing"), undefined);
});

test("收藏页筛选：会话 kind 可单独筛出，搜索命中标题", () => {
	const entries = [
		{ id: "a", kind: "session", sessionId: "s1", text: "", sessionTitle: "重构计划" },
		{ id: "b", kind: "message", sessionId: "s1", text: "正文", sessionTitle: "会话一" },
	];
	assert.deepEqual([...filterFavorites(entries, "", "session").map((entry) => entry.id)], ["a"]);
	assert.deepEqual([...filterFavorites(entries, "重构", "all").map((entry) => entry.id)], ["a"]);
});

test("入口接线：侧栏/标签页/收藏页共用 useFavorites 与会话导航 atom", () => {
	const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
	const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	const workspace = readFileSync("src/renderer/src/components/favorites/FavoritesWorkspace.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useFavorites.ts", "utf8");
	assert.match(hook, /favoritedSessionIds: ReadonlySet<string>/);
	assert.match(hook, /toggleSessionFavorite/);
	assert.match(sidebar, /favorites\.toggleSessionFavorite\(/);
	assert.match(sidebar, /isSessionFavorited=/);
	assert.match(tabs, /favorites\.toggleSessionFavorite\(/);
	assert.match(tabs, /favorites\.saveSession/);
	assert.match(workspace, /favoritesOpenSessionRequestAtom/);
	assert.match(workspace, /favoriteDetailOpenAtom, favoritesOpenSessionRequestAtom/);
	const components = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	assert.match(components, /favorites\.saveSession/);
	const app = rendererAppSource;
	assert.match(app, /favoritesOpenSessionRequestAtom/);
	assert.match(app, /openSidebarSessionByIdWithTab\(request\.projectId, request\.sessionId, "permanent"\)/);
	assert.match(app, /deactivateWorkspacePage\(\);/);
});
