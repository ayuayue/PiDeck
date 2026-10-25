import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { initializeAppBrand, APP_DISPLAY_NAME } = loadTsCommonJs("src/main/utils/appBrand.ts");

for (const displayName of [APP_DISPLAY_NAME, "PiDeck Dev"]) {
	test(`${displayName} 显示名在 ready 时恢复，密钥环初始化保留历史身份`, () => {
		let name = "pideck";
		let ready;
		initializeAppBrand(
			{
				setName(value) {
					name = value;
				},
				once(event, listener) {
					assert.equal(event, "ready");
					ready = listener;
				},
			},
			displayName,
		);
		// Electron 在 ready 前按此名字创建 OS crypt 配置，不能改成新的凭据域。
		const keychainIdentity = name;
		assert.equal(keychainIdentity, "pi-desktop");
		assert.equal(typeof ready, "function");
		ready();
		assert.equal(name, displayName);
		assert.equal(keychainIdentity, "pi-desktop");
	});
}

test("品牌初始化在 ready/窗口装配前，Dev 目录迁移在读取决策指针前", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.ok(source.indexOf("initializeAppBrand(app,") < source.indexOf("app.whenReady()"));
	assert.ok(source.indexOf("const devDirectoryMigration = migrateDevUserData(") < source.indexOf("readDataEnvDecision(channelDevDataDir)"));
	assert.ok(source.indexOf("const devDirectoryMigration = migrateDevUserData(") < source.indexOf("app.setPath("));
});
