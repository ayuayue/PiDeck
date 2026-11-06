// 2026-11 现场回归（WSL → Windows 切换）：同一目录在 WSL 模式下加过，
// 切回 Windows 后再「添加项目」选同一目录，记录必须翻回 windows 环境。
//
// 现场数据（用户 projects.json，revision 12）里只有一条 pi-desktop-dev：
//   locator = { kind: "local", environment: "wsl", localPath: "C:\\Users\\14012\\pi-desktop-dev" }
// —— WSL 模式下选 /mnt/c/... 会被归一成盘符路径存储（drvfs 不能存 UNC），所以
// 「wsl 环境 + 盘符路径」是合法存储形态，不是脏数据。
// 切回 Windows（settings.wslEnabled = false）后 `projectsIpc.getVisibleProjects()` 按环境
// 过滤，这条 wsl 记录被整条藏掉：toast 说「项目已添加」，侧栏与工作区却什么都没有。
//
// 契约：chooseAndAdd（Windows 系统对话框入口）必须以 windows 环境入库，让去重命中的
// 旧记录翻正；同时 C 盘目录再次以 WSL 档案身份添加时仍要翻回 wsl（不得矫枉过正）。
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const PROJECT_PATH = "C:\\Users\\dev\\pi-desktop-dev";

function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: {
			electron: {
				app: { getPath: () => userData },
				dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [PROJECT_PATH] }) },
			},
		},
	});
}

async function withStore(run) {
	const userData = join(tmpdir(), `pideck-project-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(userData, { recursive: true });
	try {
		const { ProjectStore } = loadProjectStore(userData);
		const store = new ProjectStore();
		await run(store, userData);
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
}

async function seedWslRecord(userData) {
	await writeFile(
		join(userData, "projects.json"),
		JSON.stringify([
			{
				id: "wsl-added-first",
				name: "pi-desktop-dev",
				path: PROJECT_PATH,
				lastOpenedAt: 1,
				sortOrder: 0,
				environment: "wsl",
				wslDistro: "Debian",
				wslUser: "debian",
			},
		]),
		"utf8",
	);
}

test("Windows 对话框重新添加 WSL 模式加过的同一目录，把项目翻回 windows 环境", async () => {
	await withStore(async (store, userData) => {
		await seedWslRecord(userData);
		await store.load();

		const added = await store.chooseAndAdd();

		assert.equal(added.id, "wsl-added-first", "同一目录必须复用既有记录，不新建重复项目");
		assert.equal(added.environment, "windows", "不改写环境会被 wslEnabled=false 的可见性过滤整条藏掉");
		// vm 沙箱里的数组跨 realm，展开成宿主数组再比（deepStrictEqual 比原型）。
		const visibleIds = [
			...store
				.list()
				.filter((project) => project.kind !== "chat")
				.map((project) => project.id),
		];
		assert.deepEqual(visibleIds, ["wsl-added-first"]);
	});
});

test("以 WSL 档案身份重新添加同一目录仍翻回 wsl（环境以本次选择为准）", async () => {
	await withStore(async (store, userData) => {
		await seedWslRecord(userData);
		await store.load();

		await store.chooseAndAdd();
		const readded = await store.add(PROJECT_PATH, undefined, "wsl", { hostId: "host-1", distro: "Debian", user: "debian" });

		assert.equal(readded.environment, "wsl");
		assert.equal(readded.wslDistro, "Debian");
		assert.equal(readded.wslUser, "debian");
	});
});
