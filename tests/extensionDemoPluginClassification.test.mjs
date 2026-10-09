import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 插件开发 demo（pi-deck-demo-plugin.ts）是复制进用户扩展目录的普通扩展：
// 「内置」身份只应属于 -e 注入白名单（builtInExtensions.ts）。此前 scanLocalExtensions
// 按 pi-deck- 前缀判内置，导致 demo 行被当成内置扩展——移除走 disableBuiltIn（写
// removedBuiltInExtensions + 下次列表加载时删文件、行不再出现），既误导用户也让
// 关闭/禁用语义错乱。守卫三层：扫描分类、disableBuiltIn 白名单校验、复制 demo 后
// 失效扩展列表缓存。
const DEMO = "pi-deck-demo-plugin.ts";

async function createManager(home) {
	const { ExtensionManager } = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", { stubs: {} });
	const manager = new ExtensionManager(
		{},
		() => ({}),
		() => ({}),
		async () => ({}),
		(key) => key,
	);
	// 与 tests/extensionManager.test.mjs 同模式：把扩展目录边界切到临时 home
	manager.wslEnvironment = { windowsHome: home };
	return manager;
}

test("issue #321 demo 扩展按普通用户扩展分类：仅白名单成员才是内置", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-demo-classify-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(join(extensionsDir, DEMO), "export default {};", "utf8");
		await writeFile(join(extensionsDir, "pi-deck-todo.ts"), "export default {};", "utf8");
		await writeFile(join(extensionsDir, "random-tool.ts"), "export default {};", "utf8");
		const manager = await createManager(home);
		const rows = await manager.scanLocalExtensions();
		const bySource = new Map(rows.map((row) => [row.source, row]));
		assert.equal(bySource.get(DEMO).builtIn, false, "demo 是用户复制的普通扩展，不得判为内置");
		assert.equal(bySource.get("pi-deck-todo.ts").builtIn, true, "白名单成员的用户目录残留副本仍是内置（供启动迁移清理）");
		assert.equal(bySource.get("random-tool.ts").builtIn, false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("issue #321 disableBuiltIn 拒绝非白名单的 pi-deck-* 文件（demo 不可走内置移除路径）", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-demo-disable-"));
	let patched = null;
	try {
		const { ExtensionManager } = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", { stubs: {} });
		const manager = new ExtensionManager(
			{},
			() => ({}),
			() => ({}),
			async (patch) => (patched = patch),
			(key) => key,
		);
		manager.wslEnvironment = { windowsHome: home };
		await assert.rejects(manager.disableBuiltIn(DEMO, false), /只能操作内置扩展/);
		assert.equal(patched, null, "拒绝路径不得写 removedBuiltInExtensions");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("issue #321 复制 demo 后失效扩展列表缓存", async () => {
	const registered = new Map();
	const stubs = {
		electron: {
			ipcMain: { handle: (channel, handler) => registered.set(channel, handler) },
			shell: { showItemInFolder: () => undefined },
		},
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts", { stubs: {} });
	const { registerPluginDevIpc } = loadTsCommonJs("src/main/ipc/pluginDevIpc.ts", { stubs });
	let invalidated = 0;
	const service = {
		status: () => ({}),
		writeGuide: async () => "/tmp/guide.md",
		copyDemoPlugin: async () => ({ status: "copied", path: "/tmp/demo.ts" }),
	};
	registerPluginDevIpc(service, { onExtensionFilesChanged: () => invalidated++ });
	await registered.get(ipcChannels.pluginDevCopyDemo)();
	assert.equal(invalidated, 1, "复制 demo 落盘后必须失效扩展列表缓存，否则已打开的扩展页看不到新行");
});

test("issue #321 扩展开关/移除路由按白名单判定内置身份（源码契约）", async () => {
	const { readFileSync } = await import("node:fs");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	// 开关路由必须用白名单：demo（pi-deck-* 前缀但非内置）被误路由进内置分支时，
	// 「关」会打到 disableBuiltIn 并被守卫拒绝、「开」会变成无意义的 restoreBuiltIn。
	// 判定已收口在 ExtensionManager.toggleFromUi（桌面 IPC 与 Web 工作区路由共用同一入口）。
	assert.match(storeIpc, /extensionManager\.toggleFromUi\(/);
	assert.doesNotMatch(storeIpc, /startsWith\(\s*"pi-deck-"\s*\)/);
	const manager = readFileSync("src/main/extensions/ExtensionManager.ts", "utf8");
	assert.match(manager, /async toggleFromUi[\s\S]{0,600}?isBuiltInExtensionName\(normalized\)/);
	assert.doesNotMatch(manager, /toggleFromUi[\s\S]{0,600}?startsWith\(\s*"pi-deck-"\s*\)/);
	// 内置操作入口（removeBuiltIn/disableBuiltIn/uninstall）一律白名单守卫。
	assert.doesNotMatch(manager, /uninstall[\s\S]{0,400}startsWith\("pi-deck-"\)/);
});
