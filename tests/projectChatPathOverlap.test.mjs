// issue #149 回归测试：内置聊天区（Chat）路径与用户项目目录重叠时的项目区行为。
//
// 用户现场（Mac 日志）：chat-path.json 被指向用户项目目录后，再「添加项目」选同一目录，
// ProjectStore.add() 把内置聊天项目（builtin-chat）当作“已存在项目”返回，
// 项目区永远不出现新项目；ensureChatProject() 还会把同路径的普通项目整条吸收删除。
//
// 三个断言口径：
// 1. 添加与聊天目录同路径的目录，必须创建真正的项目记录（返回 id 不得是 builtin-chat）。
// 2. load() 不得吸收/删除路径与聊天目录相同的普通项目。
// 3. setChatProjectPath() 拒绝把聊天目录指向已注册的普通项目目录。
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadProjectPathPolicy() {
	const sandbox = { exports: {}, require, process };
	vm.runInNewContext(transpile("src/main/projects/projectPathPolicy.ts"), sandbox, {
		filename: "projectPathPolicy.ts",
	});
	return sandbox.exports;
}

const paths = loadWslPaths();
const pathPolicy = loadProjectPathPolicy();

/** 与 wslPaths.test.mjs 同款 vm 沙箱加载 ProjectStore，userData 可参数化（真实文件 I/O 落在临时目录）。 */
function loadProjectStore(userData) {
	const sandbox = {
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => userData }, dialog: {} };
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./projectPathPolicy") return pathPolicy;
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/projects/ProjectStore.ts"), sandbox, {
		filename: "ProjectStore.ts",
	});
	return sandbox.exports;
}

/** 每个用例独立 userData 目录，结束后清理；userFolder 即用户挑选的项目目录（与聊天目录同路径的候选）。 */
async function withStore(run) {
	const userData = join(tmpdir(), `pideck-chat-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(userData, { recursive: true });
	try {
		const { ProjectStore } = loadProjectStore(userData);
		const store = new ProjectStore();
		await run(store, { userData, userFolder: join(userData, "x-prd") });
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
}

test("添加与聊天目录同路径的目录必须返回真实项目，而不是 builtin-chat（issue #149 用户现场）", async () => {
	await withStore(async (store, { userData, userFolder }) => {
		// 复现用户 Mac 现场：chat-path.json 已指向用户项目目录（聊天区路径被占用），
		// projects.json 里只有被“占用”的聊天项目。
		await writeFile(join(userData, "chat-path.json"), JSON.stringify({ path: userFolder }), "utf8");
		await writeFile(
			join(userData, "projects.json"),
			JSON.stringify([
				{
					id: "builtin-chat",
					name: "Chat",
					path: userFolder,
					kind: "chat",
					pinned: true,
					sortOrder: -1,
					lastOpenedAt: 1,
				},
			]),
			"utf8",
		);
		await store.load();

		const added = await store.add(userFolder);
		assert.notEqual(added.id, "builtin-chat", "添加项目必须返回真实项目，而不是内置聊天项目");
		const nonChat = store.list().filter((project) => project.id !== "builtin-chat");
		assert.equal(nonChat.length, 1, "项目区必须出现新项目，不能只剩聊天区");
		assert.equal(nonChat[0].path, userFolder);
	});
});

test("load() 保留路径与聊天目录相同的普通项目，不吸收为聊天项目", async () => {
	await withStore(async (store, { userData, userFolder }) => {
		await writeFile(join(userData, "chat-path.json"), JSON.stringify({ path: userFolder }), "utf8");
		await writeFile(
			join(userData, "projects.json"),
			JSON.stringify([
				{
					id: "normal-1",
					name: "x-prd",
					path: userFolder,
					lastOpenedAt: 1,
					sortOrder: 0,
					environment: "windows",
				},
			]),
			"utf8",
		);
		await store.load();

		const listed = store.list();
		const normal = listed.find((project) => project.id === "normal-1");
		assert.ok(normal, "聊天目录与项目同路径时，普通项目记录必须保留");
		assert.notEqual(normal.kind, "chat", "普通项目不得被改写成聊天项目");
		assert.ok(
			listed.some((project) => project.id === "builtin-chat"),
			"内置聊天项目应同时存在",
		);
	});
});

test("setChatProjectPath 拒绝把聊天目录指向已注册的普通项目目录", async () => {
	await withStore(async (store, { userFolder }) => {
		await store.load();
		await store.add(userFolder);
		const before = store.getChatProjectPath();

		await assert.rejects(
			store.setChatProjectPath(userFolder),
			// vm 沙箱里的 Error 与测试进程不是同一构造器，只能按 message 断言
			(error) => String(error?.message ?? "").includes("CHAT_PATH_OVERLAPS_PROJECT"),
		);
		assert.equal(store.getChatProjectPath(), before, "拒绝后聊天目录不得被改动");
	});
});

test("remove 记住路径，add 同一目录后允许再次出现", async () => {
	await withStore(async (store, { userFolder }) => {
		await store.load();
		const added = await store.add(userFolder);
		await store.remove(added.id);
		assert.equal(
			store.list().some((project) => project.id === added.id),
			false,
		);
		assert.ok(store.listDismissedPaths().some((path) => path.includes("x-prd")));
		const restored = await store.add(userFolder);
		assert.ok(restored.id);
		assert.equal(store.listDismissedPaths().length, 0);
	});
});

test("load 丢掉 e2e 临时项目并记入已移除名单", async () => {
	await withStore(async (store, { userData }) => {
		const ephemeral = join(userData, "pideck-mockpi-abc", "profile", "chat-workspace");
		await store.load();
		await store.add(ephemeral);
		assert.equal(
			store.list().some((project) => project.path === ephemeral),
			true,
		);
		const reloaded = loadProjectStore(userData).ProjectStore;
		const next = new reloaded();
		await next.load();
		assert.equal(
			next.list().some((project) => project.path === ephemeral),
			false,
		);
		assert.ok(next.listDismissedPaths().some((path) => path.includes("pideck-mockpi-abc")));
	});
});

test("setChatProjectPath 仍允许指向未注册目录，且随后添加该目录会创建真实项目", async () => {
	await withStore(async (store, { userData }) => {
		await store.load();
		const chatFolder = join(userData, "custom-chat");
		await store.setChatProjectPath(chatFolder);
		assert.equal(store.getChatProjectPath(), chatFolder);

		const added = await store.add(chatFolder);
		assert.notEqual(added.id, "builtin-chat", "聊天目录也是可添加的真实项目目录");
		assert.equal(store.list().filter((project) => project.id !== "builtin-chat").length, 1);
	});
});
