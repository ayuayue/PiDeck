import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 「内置」身份只属于 -e 注入白名单（builtInExtensions.ts），**不是** `pi-deck-` 前缀。
// 用户把带前缀的同名/自写扩展放进扩展目录后，此前按前缀判定会把它们当内置：开/关路由
// 打错分支（「关」被白名单守卫拒绝、「开」变成无意义的 restoreBuiltIn），用户无从恢复。
// 守卫两层：扫描分类与内置操作入口的白名单校验。
const USER_PI_PREFIX_EXT = "pi-deck-user-extension.ts";

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

test("非白名单的 pi-deck-* 用户扩展按普通扩展分类：仅白名单成员才是内置", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-classify-"));
	try {
		const extensionsDir = join(home, ".pi", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(join(extensionsDir, USER_PI_PREFIX_EXT), "export default {};", "utf8");
		await writeFile(join(extensionsDir, "pi-deck-todo.ts"), "export default {};", "utf8");
		await writeFile(join(extensionsDir, "random-tool.ts"), "export default {};", "utf8");
		const manager = await createManager(home);
		const rows = await manager.catalog.scanLocalExtensions();
		const bySource = new Map(rows.map((row) => [row.source, row]));
		assert.equal(bySource.get(USER_PI_PREFIX_EXT).builtIn, false, "带前缀的用户扩展不得判为内置");
		assert.equal(bySource.get("pi-deck-todo.ts").builtIn, true, "白名单成员的用户目录残留副本仍是内置（供启动迁移清理）");
		assert.equal(bySource.get("random-tool.ts").builtIn, false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("disableBuiltIn 拒绝非白名单的 pi-deck-* 文件（用户扩展不可走内置移除路径）", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-classify-disable-"));
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
		await assert.rejects(manager.disableBuiltIn(USER_PI_PREFIX_EXT, false), /只能操作内置扩展/);
		assert.equal(patched, null, "拒绝路径不得写 removedBuiltInExtensions");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("扩展开关/移除路由按白名单判定内置身份（源码契约）", async () => {
	const { readFileSync } = await import("node:fs");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	// 开关路由必须用白名单：带前缀但非内置的用户扩展被误路由进内置分支时，
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
