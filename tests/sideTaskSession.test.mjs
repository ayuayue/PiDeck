// 「侧边任务」会话标记（sideTask）落库与呈现契约。
// 产品口径：侧边任务会话正常出现在左栏列表（带徽标），唯一差别是发消息不晋升主区常驻 Tab。
// 因此标记必须由 catalog 持久化（跨重启），且只在显式 true 时落盘、显式 null 时清除。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});

async function freshCatalog(label) {
	const dir = await mkdtemp(join(tmpdir(), `pideck-${label}-`));
	const filePath = join(dir, "sessions.json");
	const catalog = new SessionCatalog(filePath);
	await catalog.load();
	return { dir, filePath, catalog };
}

// 草稿在 load 时会被 StaleDraftReaper 收掉（pi 后端），所以「跨重启」用例先把它抬成 active，
// 对应真实链路里发第一条消息后 runtime 激活的时机。
async function activeDraft(catalog, overrides) {
	const created = await catalog.createDraft({ projectId: "project-1", title: "任务", environment: "native", ...overrides });
	return catalog.promoteToActive(created.id);
}

test("createDraft 带 sideTask 的会话跨重启保留标记", async () => {
	const { dir, filePath, catalog } = await freshCatalog("side-task-keep");
	try {
		const created = await activeDraft(catalog, { sideTask: true });
		assert.equal(created.sideTask, true);

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		assert.equal(reloaded.getRecord(created.id).sideTask, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("普通会话不把 sideTask 写进存档（false 与缺省同义，不留噪声字段）", async () => {
	const { dir, filePath, catalog } = await freshCatalog("side-task-absent");
	try {
		await activeDraft(catalog, { sideTask: false });
		const raw = JSON.parse(await readFile(filePath, "utf8"));
		const entry = raw.sessions.find((item) => item.title === "任务");
		assert.ok(entry, "会话条目应已落盘");
		assert.equal("sideTask" in entry, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("update 置 null 释放回普通会话，会话本身保留", async () => {
	const { dir, filePath, catalog } = await freshCatalog("side-task-release");
	try {
		const created = await activeDraft(catalog, { sideTask: true });
		const updated = await catalog.update(created.id, { sideTask: null });
		assert.equal(updated.sideTask, undefined);
		assert.ok(catalog.get(created.id), "释放标记不得删除会话条目");

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		assert.equal(reloaded.getRecord(created.id).sideTask, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("update 可以把普通会话收进侧边任务面板", async () => {
	const { dir, catalog } = await freshCatalog("side-task-adopt");
	try {
		const created = await activeDraft(catalog);
		assert.equal(created.sideTask, undefined);
		const updated = await catalog.update(created.id, { sideTask: true });
		assert.equal(updated.sideTask, true);
		assert.equal(catalog.getRecord(created.id).sideTask, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 结构契约：面板复用主区会话渲染栈 + 抑制主区 Tab 晋升，是「复用所有会话渲染逻辑」这条需求的底线。
// 一旦有人换成第二套聊天实现、或忘了抑制 promote，侧边任务就会开始往主区弹 Tab。
const panel = readFileSync("src/renderer/src/components/workspace/SideTaskPanel.tsx", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const workspaceHook = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
const tabsMenu = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const sidebarMenu = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

test("侧边任务面板复用 ChatSessionPane 并抑制主区 Tab 晋升", () => {
	assert.match(panel, /<ChatSessionPane sessionId=\{currentId\}/);
	assert.match(panel, /promoteSessionToPermanent: \(\) => \{\}/);
	// 面板不是主区栏位：不抢 App 级 composer/header refs，也不改当前会话
	assert.match(panel, /focused=\{false\}/);
});

test("sideTask 注册为抽屉面板，有任务时才进抽屉活动栏", () => {
	assert.match(workspaceHook, /"sideTask"/);
	assert.match(drawer, /drawer === "sideTask"/);
	assert.match(drawer, /<SideTaskPanel/);
	// 一条任务都没有时不在活动栏挂空 tab，但面板已打开时要保留出口（否则关不掉）
	assert.match(app, /sideTasks\.ids\.length > 0 \|\| drawer === "sideTask"/);
});

test("两处会话菜单都接「新建侧边任务」入口", () => {
	assert.match(tabsMenu, /onCreateSideTask/);
	assert.match(sidebarMenu, /createSideTask/);
	assert.match(app, /onCreateSideTask: \(\) => void sideTasks\.create/);
});

test("抽屉宽度上限放宽到能装下整块会话渲染（880）", () => {
	assert.match(workspaceHook, /export const DRAWER_WIDTH_MAX = 880/);
});
