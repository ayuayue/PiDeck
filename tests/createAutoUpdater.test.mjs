/**
 * createAutoUpdater 辅助函数与兜底逻辑单元测试。
 * 验证 Windows 便携版及缺失 app-update.yml 场景下的自动配置生成与差量下载策略。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const fakeApp = {
	isPackaged: true,
	getAppPath: () => "C:\\mock\\app",
	getPath: (name) => {
		if (name === "userData") return "C:\\mock\\userData";
		return "C:\\mock";
	},
};

const {
	DEFAULT_UPDATER_CACHE_DIR_NAME,
	FALLBACK_APP_UPDATE_CONFIG_FILENAME,
	generateFallbackAppUpdateConfigYaml,
	resolveDefaultAppUpdateConfigPath,
	ensureAppUpdateConfig,
	shouldDisableDifferentialDownload,
} = loadTsCommonJs("src/main/update/createAutoUpdater.ts", {
	stubs: {
		electron: { app: fakeApp },
	},
});

test("generateFallbackAppUpdateConfigYaml 生成合法的 GitHub provider 配置", () => {
	const yaml = generateFallbackAppUpdateConfigYaml();
	assert.match(yaml, /provider:\s*github/);
	assert.match(yaml, /owner:\s*ayuayue/);
	assert.match(yaml, /repo:\s*PiDeck/);
	assert.match(yaml, /updaterCacheDirName:\s*pi-desktop-updater/);

	const customYaml = generateFallbackAppUpdateConfigYaml({
		owner: "test-owner",
		repo: "test-repo",
		updaterCacheDirName: "custom-updater",
	});
	assert.match(customYaml, /owner:\s*test-owner/);
	assert.match(customYaml, /repo:\s*test-repo/);
	assert.match(customYaml, /updaterCacheDirName:\s*custom-updater/);
});

test("resolveDefaultAppUpdateConfigPath 区分打包态与开发态路径", () => {
	const packagedPath = resolveDefaultAppUpdateConfigPath(
		true,
		"C:\\mock\\resources",
		"C:\\mock\\app",
	);
	assert.equal(packagedPath, join("C:\\mock\\resources", "app-update.yml"));

	const devPath = resolveDefaultAppUpdateConfigPath(
		false,
		"C:\\mock\\resources",
		"C:\\mock\\app",
	);
	assert.equal(devPath, join("C:\\mock\\app", "dev-app-update.yml"));
});

test("ensureAppUpdateConfig: 当默认配置已存在时返回 null，不重复生成", () => {
	let written = false;
	const result = ensureAppUpdateConfig({
		isPackaged: true,
		resourcesPath: "C:\\mock\\resources",
		appPath: "C:\\mock\\app",
		userDataPath: "C:\\mock\\userData",
		existsSync: (path) => path.endsWith("app-update.yml"),
		mkdirSync: () => {},
		writeFileSync: () => {
			written = true;
		},
	});
	assert.equal(result, null);
	assert.equal(written, false);
});

test("ensureAppUpdateConfig: 当默认配置缺失（如便携版）时在 userData 写入兜底配置并返回路径", () => {
	const writtenFiles = new Map();
	const result = ensureAppUpdateConfig({
		isPackaged: true,
		resourcesPath: "C:\\mock\\resources",
		appPath: "C:\\mock\\app",
		userDataPath: "C:\\mock\\userData",
		existsSync: () => false,
		mkdirSync: () => {},
		writeFileSync: (path, content) => {
			writtenFiles.set(path, content);
		},
	});

	const expectedFallbackPath = join("C:\\mock\\userData", FALLBACK_APP_UPDATE_CONFIG_FILENAME);
	assert.equal(result, expectedFallbackPath);
	assert.equal(writtenFiles.has(expectedFallbackPath), true);
	const content = writtenFiles.get(expectedFallbackPath);
	assert.match(content, /provider:\s*github/);
	assert.match(content, /updaterCacheDirName:\s*pi-desktop-updater/);
});

test("shouldDisableDifferentialDownload: 便携版、缺失默认配置或 E2E 环境下必须禁用差量下载", () => {
	// 便携版
	assert.equal(
		shouldDisableDifferentialDownload({ isPortable: true, hasDefaultConfig: true }),
		true,
	);
	// 缺失默认配置
	assert.equal(
		shouldDisableDifferentialDownload({ isPortable: false, hasDefaultConfig: false }),
		true,
	);
	// E2E
	assert.equal(
		shouldDisableDifferentialDownload({ isE2E: true }),
		true,
	);
	// 普通完整安装版
	assert.equal(
		shouldDisableDifferentialDownload({ isPortable: false, hasDefaultConfig: true, isE2E: false }),
		false,
	);
});
