import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const modulePath = "src/main/projects/userDataNameMigration.ts";
const { runUserDataNameMigration } = loadTsCommonJs(modulePath);

for (const [oldName, newName] of [
	["pi-desktop-dev", "PiDeck-dev"],
	["pi-desktop-dev-feat-test", "PiDeck-dev-feat-test"],
	["pi-desktop-channel-dev", "PiDeck-channel-dev"],
]) {
	test(`${oldName} 升级时保留设置并改写路径，重复启动幂等`, (t) => {
		const root = fs.mkdtempSync(join(tmpdir(), "pideck-dev-migration-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const oldPath = join(root, oldName);
		const newPath = join(root, newName);
		fs.mkdirSync(oldPath);
		fs.writeFileSync(join(oldPath, "settings.json"), JSON.stringify({ path: join(oldPath, "runtime") }));
		const input = { appDataDir: root, homeDir: join(root, "home"), legacyUserDataName: oldName, userDataPathOverride: newPath };
		assert.equal(runUserDataNameMigration(input).kind, "migrated");
		assert.equal(fs.existsSync(oldPath), false);
		assert.equal(JSON.parse(fs.readFileSync(join(newPath, "settings.json"), "utf8")).path, join(newPath, "runtime"));
		assert.equal(runUserDataNameMigration(input).reason, "already-migrated");
	});
}

test("Dev 独立目录先迁移决策指针，避免升级后误判为首次选择", (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "pideck-dev-marker-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const oldPath = join(root, "pi-desktop-channel-dev");
	fs.mkdirSync(oldPath);
	const marker = '{"schemaVersion":1,"dataMode":"channel-dev"}';
	fs.writeFileSync(join(oldPath, "pideck-env.json"), marker);
	const { migrateDevUserData } = loadTsCommonJs("src/main/projects/devUserDataMigration.ts");
	const result = migrateDevUserData({ appDataDir: root, homeDir: root, devDirectoryName: "PiDeck-dev", isPackaged: true, channel: "dev" });
	assert.equal(result.channelDevDataDir, join(root, "PiDeck-channel-dev"));
	assert.equal(fs.readFileSync(join(result.channelDevDataDir, "pideck-env.json"), "utf8"), marker);
	assert.equal(fs.existsSync(oldPath), false);
});

for (const mode of ["stable", "explicit", "portable"]) {
	test(`${mode} 启动不搬动历史开发数据`, (t) => {
		const root = fs.mkdtempSync(join(tmpdir(), "pideck-dev-skip-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const legacy = join(root, "pi-desktop-channel-dev");
		fs.mkdirSync(legacy);
		fs.writeFileSync(join(legacy, "settings.json"), "{}");
		const { migrateDevUserData } = loadTsCommonJs("src/main/projects/devUserDataMigration.ts");
		const result = migrateDevUserData({ appDataDir: root, homeDir: root, devDirectoryName: "PiDeck-dev", isPackaged: true, channel: mode === "stable" ? "stable" : "dev", explicitDir: mode === "explicit" ? join(root, "custom") : undefined, portableExeDir: mode === "portable" ? root : undefined });
		assert.equal(result.migrations.length, 0);
		assert.equal(fs.readFileSync(join(legacy, "settings.json"), "utf8"), "{}");
		assert.equal(fs.existsSync(join(root, "PiDeck-channel-dev")), false);
	});
}

test("更名失败回退历史目录，不创建空的新配置目录", (t) => {
	const root = fs.mkdtempSync(join(tmpdir(), "pideck-dev-migration-fail-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const oldPath = join(root, "pi-desktop-dev");
	const newPath = join(root, "PiDeck-dev");
	fs.mkdirSync(oldPath);
	fs.writeFileSync(join(oldPath, "settings.json"), "{}");
	const blocked = loadTsCommonJs(modulePath, {
		stubs: {
			"node:fs": {
				...fs,
				renameSync() {
					throw new Error("simulated permission denial");
				},
			},
		},
	});
	const result = blocked.runUserDataNameMigration({ appDataDir: root, homeDir: root, legacyUserDataName: "pi-desktop-dev", userDataPathOverride: newPath });
	assert.equal(result.kind, "failed");
	assert.equal(result.userDataPath, oldPath);
	assert.equal(fs.readFileSync(join(oldPath, "settings.json"), "utf8"), "{}");
	assert.equal(fs.existsSync(newPath), false);
});
