/**
 * 启动时补齐 pi settings.json 默认项不得破坏用户配置（数据丢失回归测试）。
 *
 * 背景（2026-10 用户反馈）：装好/部署完时 packages 正常，打开 PiDeck 后整个 settings.json
 * 被重置成默认项，只有 PiDeck 认识的键被陆续写回，packages 永久消失。旧实现在「读文件或
 * JSON.parse 失败」时把 current 退回 `{}`，随后因为默认项缺失而整份写盘——用户配置一次全丢；
 * 即便解析成功，也是裸 writeFile 读改写，与 pi/TUI 的并发写互相覆盖。
 *
 * 这里盯四件事：BOM/坏 JSON 不覆盖、未知键（packages）保留、已经齐全时一个字节都不写、
 * 文件不存在时仍要建出带默认项的文件。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ensurePiSettingsDefaults, missingPiSettingsDefaults, PI_SETTINGS_DEFAULTS } = loadTsCommonJs("src/main/config/piSettingsDefaults.ts");

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-settings-defaults-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("missingPiSettingsDefaults 只补缺失键，已齐全返回 null", () => {
	const empty = missingPiSettingsDefaults({});
	assert.deepEqual(Object.keys(empty).sort(), Object.keys(PI_SETTINGS_DEFAULTS).sort());

	const partial = missingPiSettingsDefaults({ theme: "light", packages: ["npm:x"] });
	assert.equal("theme" in partial, false, "已有键不能被默认值覆盖");
	assert.equal("packages" in partial, false, "未知键不是默认项，也不能被改动");

	assert.equal(missingPiSettingsDefaults({ ...PI_SETTINGS_DEFAULTS, lastChangelogVersion: "1.0.0" }, "1.0.0"), null);
	// vm 沙箱里的对象原型与本 realm 不同，deepEqual 会误判，统一用 structuredClone 归一。
	assert.deepEqual(structuredClone(missingPiSettingsDefaults({ ...PI_SETTINGS_DEFAULTS }, "1.2.3")), { lastChangelogVersion: "1.2.3" });
});

test("BOM + packages 的 settings.json：补默认项且不丢用户字段", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = join(dir, "settings.json");
		writeFileSync(filePath, `\uFEFF${JSON.stringify({ packages: ["npm:billion-context"], theme: "light", futureKey: { nested: true } }, null, 2)}`, "utf8");

		const result = await ensurePiSettingsDefaults(dir, "9.9.9");
		assert.equal(result.written, true);

		const data = JSON.parse(readFileSync(filePath, "utf8"));
		assert.deepEqual(data.packages, ["npm:billion-context"]);
		assert.equal(data.theme, "light", "用户已有的值不能被默认值覆盖");
		assert.deepEqual(data.futureKey, { nested: true });
		assert.equal(data.lastChangelogVersion, "9.9.9");
		assert.deepEqual(data.compaction, structuredClone(PI_SETTINGS_DEFAULTS).compaction);
	} finally {
		cleanup();
	}
});

test("坏 JSON：跳过而不是用默认项覆盖", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = join(dir, "settings.json");
		const raw = '{\n  "packages": ["npm:x"],\n  // 手改残留的注释\n}\n';
		writeFileSync(filePath, raw, "utf8");

		const result = await ensurePiSettingsDefaults(dir, "9.9.9");
		assert.equal(result.written, false);
		assert.equal(result.reason, "unparsable");
		assert.equal(readFileSync(filePath, "utf8"), raw, "无法解析的文件必须原样保留");
	} finally {
		cleanup();
	}
});

test("默认项已齐全时不写盘（不重排格式）", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = join(dir, "settings.json");
		const raw = JSON.stringify({ ...PI_SETTINGS_DEFAULTS, lastChangelogVersion: "1.0.0", packages: ["npm:x"] });
		writeFileSync(filePath, raw, "utf8");

		const result = await ensurePiSettingsDefaults(dir, "1.0.0");
		assert.equal(result.written, false);
		assert.equal(result.reason, "unchanged");
		assert.equal(readFileSync(filePath, "utf8"), raw);
	} finally {
		cleanup();
	}
});

test("settings.json 不存在：建出带默认项的文件", async () => {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = join(dir, "settings.json");
		assert.equal(existsSync(filePath), false);

		const result = await ensurePiSettingsDefaults(dir, "1.0.0");
		assert.equal(result.written, true);
		const data = JSON.parse(readFileSync(filePath, "utf8"));
		assert.deepEqual(Object.keys(data).sort(), [...Object.keys(PI_SETTINGS_DEFAULTS), "lastChangelogVersion"].sort());
	} finally {
		cleanup();
	}
});
