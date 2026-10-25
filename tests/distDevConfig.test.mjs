/**
 * dev 通道构建差异配置：基于 package.json build 字段一层浅合并，
 * 只覆盖身份/产物名/协议，其余（asar/extraResources/files/...）跟随主配置，
 * 避免双份全量配置漂移。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { buildDevConfig, DEV_OVERRIDES } = await import("../scripts/dist-dev.js");

test("身份四件套覆盖：productName/appId/协议 scheme 与 stable 区分", () => {
	const config = buildDevConfig();
	assert.equal(config.productName, "PiDeck Dev");
	assert.equal(config.appId, "com.ayuayue.pi-desktop-dev");
	assert.deepEqual(config.protocols, [{ name: "PiDeck Dev Agent Link", schemes: ["pideck-dev"] }]);
});

test("三平台 artifactName 含 PiDeck-Dev 前缀、无空格、mac/linux 显式含 ${arch}", () => {
	const config = buildDevConfig();
	const names = [config.win.artifactName, config.nsis.artifactName, config.portable.artifactName, config.mac.artifactName, config.linux.artifactName];
	for (const name of names) {
		assert.ok(name.startsWith("PiDeck-Dev-"), name);
		assert.ok(!name.includes(" "), name);
	}
	assert.ok(config.mac.artifactName.includes("${arch}"));
	assert.ok(config.linux.artifactName.includes("${arch}"));
});

test("主配置非差异项原样跟随（浅合并不丢 icon/target/extraResources 等）", () => {
	const config = buildDevConfig();
	const base = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build;
	assert.deepEqual(config.win.target, base.win.target);
	assert.deepEqual(config.win.icon, base.win.icon);
	assert.deepEqual(config.extraResources, base.extraResources);
	assert.equal(config.asar, base.asar);
	assert.equal(config.afterPack, base.afterPack);
	// 差异项的兄弟键保留（nsis.oneClick 等）
	assert.equal(config.nsis.oneClick, base.nsis.oneClick);
});

test("DEV_OVERRIDES 不引用 productName 模板（避免空格透进产物名）", () => {
	for (const value of Object.values(DEV_OVERRIDES)) {
		if (typeof value === "string") assert.ok(!value.includes("${productName}"), value);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			for (const sub of Object.values(value)) {
				if (typeof sub === "string") assert.ok(!sub.includes("${productName}"), sub);
			}
		}
	}
});

// 双通道守卫（2026-09 channel-switch）：dev 更新走 GitHub prerelease 通道（任务 7 allowPrerelease），
// 不存在第二更新源——publish 必须原样继承主配置（github/ayuayue/PiDeck），差异项不得覆盖或改指向。
test("dev 构建不引入第二更新源：publish 继承主配置 github，DEV_OVERRIDES 无 atomgit 字样", () => {
	const config = buildDevConfig();
	const base = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build;
	// DEV_OVERRIDES 不显式覆盖 publish：浅合并后与主配置同源（provider: github）
	assert.deepEqual(config.publish, base.publish);
	assert.equal(config.publish.provider, "github");
	// 差异项对象本身不得引入 AtomGit 等第二更新源（脚本头注释提及 AtomGit 不在此列）
	assert.doesNotMatch(JSON.stringify(DEV_OVERRIDES), /atomgit/i);
});
