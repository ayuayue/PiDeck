/**
 * 设置页保存不再整份覆盖 settings.json（数据回退回归测试）。
 *
 * 背景（2026-10 实测复现）：设置页渲染层持有的是打开页面时的整份 settings.json 快照；
 * 期间扩展开关/商店安装/迁移会并发改写 packages 等资源键。旧实现 saveSettingsConfig
 * 直接 writeJsonFile 整份覆盖，于是「装好/开好的扩展」在下一次设置页保存后被静默盖回
 * 停用形态。修复后保存走 writePiConfigFile（锁内重读）并只按表单归属合并：
 * 资源键以磁盘为准，其余键仍用表单值（含「表单里删掉的键」语义）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ConfigManager } = loadTsCommonJs("src/main/config/ConfigManager.ts", {
	// ConfigManager 顶层只引用 electron 的 net/session；测试不触发网络路径。
	stubs: { electron: { net: {}, session: {} } },
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-settings-form-"));
	return {
		dir,
		manager: new ConfigManager(dir, (key) => key),
		settingsPath: join(dir, "settings.json"),
		read: () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("表单里携带的旧资源键不覆盖磁盘上的并发改动", async () => {
	const { manager, settingsPath, read, cleanup } = setup();
	try {
		writeFileSync(settingsPath, JSON.stringify({ defaultModel: "old-model", packages: ["npm:kept"] }), "utf8");
		// 模拟：页面打开时 packages 是旧的，期间扩展开关把磁盘改成了 npm:kept
		const result = await manager.saveSettingsConfig({ defaultModel: "new-model", packages: ["npm:stale"], extensions: ["-stale.js"] });
		assert.equal(result.valid, true, JSON.stringify(result));
		const saved = read();
		assert.equal(saved.defaultModel, "new-model");
		assert.deepEqual(saved.packages, ["npm:kept"], "资源键必须以磁盘为准，不能被页面旧快照盖回");
		assert.equal("extensions" in saved, false, "payload 里的资源键不能在磁盘上凭空创建");
	} finally {
		cleanup();
	}
});

test("非资源键保持整表单语义：payload 有则覆盖、payload 没有则删除", async () => {
	const { manager, settingsPath, read, cleanup } = setup();
	try {
		writeFileSync(settingsPath, JSON.stringify({ theme: "light", quietStartup: true, packages: ["npm:foo"] }), "utf8");
		const result = await manager.saveSettingsConfig({ theme: "dark" });
		assert.equal(result.valid, true);
		const saved = read();
		assert.equal(saved.theme, "dark");
		assert.equal("quietStartup" in saved, false, "表单里删掉的键应该从磁盘消失");
		assert.deepEqual(saved.packages, ["npm:foo"]);
	} finally {
		cleanup();
	}
});

test("内容没变化时不重写文件（省一次写盘与 mtime 变化）", async () => {
	const { manager, settingsPath, cleanup } = setup();
	try {
		writeFileSync(settingsPath, `${JSON.stringify({ theme: "dark", packages: ["npm:foo"] }, null, 2)}\n`, "utf8");
		const before = readFileSync(settingsPath, "utf8");
		const result = await manager.saveSettingsConfig({ theme: "dark", packages: ["ignored"] });
		assert.equal(result.valid, true);
		assert.equal(readFileSync(settingsPath, "utf8"), before);
	} finally {
		cleanup();
	}
});

test("settings.json 损坏时拒绝保存而不是覆盖成表单快照", async () => {
	const { manager, settingsPath, cleanup } = setup();
	try {
		const broken = '{ "theme": "dark",';
		writeFileSync(settingsPath, broken, "utf8");
		const result = await manager.saveSettingsConfig({ theme: "light" });
		assert.equal(result.valid, false, "损坏文件应交给源文件页修复，表单不得静默覆盖");
		assert.match(String(result.error), /JSON|Unexpected|position/i);
		assert.equal(readFileSync(settingsPath, "utf8"), broken);
	} finally {
		cleanup();
	}
});
