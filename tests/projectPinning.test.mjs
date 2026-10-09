// 项目置顶（2027-03 用户反馈「会话有置顶，项目没有」）：
// 1. setPinned 落库后 list() 置顶项目排在普通项目之前（聊天项目仍恒居首）。
// 2. 置顶持久化：重载 store 后仍生效；取消置顶后回到拖拽顺序原位。
// 3. 聊天项目与未知 id 拒绝置顶；幂等调用不改排序。
// 4. reorder 不破坏置顶分组：置顶项目之间仍按拖拽顺序排列。
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => userData }, dialog: {} } },
	});
}

async function withStore(projects, run) {
	const userData = join(tmpdir(), `pideck-project-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(userData, { recursive: true });
	try {
		await writeFile(join(userData, "projects.json"), JSON.stringify([{ id: "builtin-chat", name: "Chat", path: join(userData, "chat"), kind: "chat", pinned: true, sortOrder: -1, lastOpenedAt: 1 }, ...projects]), "utf8");
		const { ProjectStore } = loadProjectStore(userData);
		const store = new ProjectStore();
		await store.load();
		await run(store, userData);
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
}

const seed = [
	{ id: "a", name: "a", path: "C:/a", lastOpenedAt: 3, sortOrder: 0 },
	{ id: "b", name: "b", path: "C:/b", lastOpenedAt: 2, sortOrder: 1 },
	{ id: "c", name: "c", path: "C:/c", lastOpenedAt: 1, sortOrder: 2 },
];

test("setPinned 置顶后排到普通项目之前，聊天项目仍居首", async () => {
	await withStore(seed, async (store) => {
		await store.setPinned("c", true);
		const ids = [...store.list().map((project) => project.id)];
		assert.deepEqual(ids, ["builtin-chat", "c", "a", "b"]);
	});
});

test("置顶持久化，取消置顶后回到拖拽顺序原位", async () => {
	await withStore(seed, async (store, userData) => {
		await store.setPinned("b", true);
		// 重新加载同一 userData 验证 pinned 落盘
		const { ProjectStore } = loadProjectStore(userData);
		const reloaded = new ProjectStore();
		await reloaded.load();
		assert.deepEqual([...reloaded.list().map((project) => project.id)], ["builtin-chat", "b", "a", "c"]);

		await reloaded.setPinned("b", false);
		assert.deepEqual([...reloaded.list().map((project) => project.id)], ["builtin-chat", "a", "b", "c"]);
	});
});

test("聊天项目与未知 id 拒绝置顶", async () => {
	await withStore(seed, async (store) => {
		await assert.rejects(() => store.setPinned("builtin-chat", true), /PROJECT_PIN_NOT_ALLOWED/);
		await assert.rejects(() => store.setPinned("missing", true), /Project not found/);
	});
});

test("幂等置顶不改排序；reorder 后置顶分组仍按拖拽顺序排在最前", async () => {
	await withStore(seed, async (store) => {
		await store.setPinned("a", true);
		await store.setPinned("a", true);
		assert.deepEqual([...store.list().map((project) => project.id)], ["builtin-chat", "a", "b", "c"]);

		// 用户在置顶分组内拖动 a 到 c 之后，同时把 b、c 顺序对调：置顶组内仍跟随拖拽结果
		await store.reorder(["c", "b", "a"]);
		assert.deepEqual([...store.list().map((project) => project.id)], ["builtin-chat", "a", "c", "b"]);
	});
});
