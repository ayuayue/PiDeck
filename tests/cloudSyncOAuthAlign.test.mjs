import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { resolveOauthBuiltinCredentials } from "../src/main/cloudSync/oauthCredentials.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const PASSWORD = "correct horse battery staple";

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

/** 实现 PiDeckCloudObjectStorage + setOnTokensRefreshed 的假适配器。 */
function createRotatingTokenAdapter() {
	const adapter = {
		providerId: "onedrive",
		refreshedCallback: null,
		async connect() { return { account: { id: "od", name: "OneDrive" } }; },
		async disconnect() {},
		async getAccount() { return { id: "od", name: "OneDrive" }; },
		async getCapabilities() { return { revisions: true, conditionalWrites: true, atomicReplacement: false }; },
		async readObject(key) { return { found: false, key, bytes: null }; },
		async writeObject(key, bytes) { return { created: true, revision: "r1" }; },
		async deleteObject(key) { return { deleted: false }; },
		setOnTokensRefreshed(callback) { this.refreshedCallback = callback; },
	};
	return adapter;
}

function makeManager({ userDataDir, homeDir, oauthBuiltins, createAdapter }) {
	return new CloudSyncManager({
		userDataDir,
		homeDir,
		deviceName: "test",
		appVersion: "0.0.0-test",
		listProjects: () => [],
		listSessionRecords: () => [],
		getDesktopSettings: minimalSettings,
		updateDesktopSettings: async () => undefined,
		...(oauthBuiltins ? { oauthBuiltins } : {}),
		...(createAdapter ? { createAdapter } : {}),
	});
}

// ── 构建期 env 注入（对齐 Netcatty：VITE_SYNC_*） ─────────────────────────

test("resolveOauthBuiltinCredentials reads VITE_SYNC_* env vars", () => {
	assert.deepEqual(
		resolveOauthBuiltinCredentials({
			VITE_SYNC_ONEDRIVE_CLIENT_ID: " azure-id ",
			VITE_SYNC_GOOGLE_CLIENT_ID: "google-id",
			VITE_SYNC_GOOGLE_CLIENT_SECRET: "secret",
		}),
		{ onedriveClientId: "azure-id", googleClientId: "google-id", googleClientSecret: "secret" },
	);
	assert.deepEqual(resolveOauthBuiltinCredentials({}), {
		onedriveClientId: "",
		googleClientId: "",
		googleClientSecret: "",
	});
});

test("manager uses built-in OneDrive clientId when the user leaves it empty", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-od-builtin-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const manager = makeManager({
			userDataDir,
			homeDir,
			oauthBuiltins: { onedriveClientId: "builtin-azure-id", googleClientId: "", googleClientSecret: "" },
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);

		const flow = await manager.startOneDriveOAuth(""); // 用户不填
		assert.match(flow.verificationUrl, /client_id=builtin-azure-id/);
		// 快照反映内置凭据存在（UI 据此隐藏输入框）
		assert.equal(manager.getStateSnapshot().oauthBuiltins.onedrive, true);
		assert.equal(manager.getStateSnapshot().oauthBuiltins.google, false);

		// 用户仍可覆盖（BYO 优先级更高）
		const overridden = await manager.startOneDriveOAuth("user-azure-id");
		assert.match(overridden.verificationUrl, /client_id=user-azure-id/);

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("manager uses built-in Google credentials when inputs are empty", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-gd-builtin-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const manager = makeManager({
			userDataDir,
			homeDir,
			oauthBuiltins: { onedriveClientId: "", googleClientId: "builtin-google-id", googleClientSecret: "builtin-secret" },
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);

		const flow = await manager.startGoogleOAuth("", "");
		assert.match(flow.verificationUrl, /client_id=builtin-google-id/);
		assert.equal(manager.getStateSnapshot().oauthBuiltins.google, true);

		// 无内置也无输入 → 报错
		const emptyManager = makeManager({ userDataDir: join(base, "ud2"), homeDir });
		await emptyManager.initialize();
		await emptyManager.setupMasterKey(PASSWORD);
		await assert.rejects(() => emptyManager.startGoogleOAuth(""), /Google Drive clientId is invalid/);
		await emptyManager.dispose();

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// ── token 轮换持久化（Netcatty #1189 教训） ───────────────────────────────

test("rotated OAuth tokens are persisted to the sealed provider config and survive restart", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-token-rotate-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const adapter = createRotatingTokenAdapter();

		const manager = makeManager({ userDataDir, homeDir, createAdapter: () => adapter });
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.configureProvider({
			provider: "onedrive",
			config: { clientId: "azure-id", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1 },
		});
		assert.ok(adapter.refreshedCallback, "connectProvider should wire the rotation callback");

		// 模拟刷新成功后 token 轮换（Microsoft consumer 每次刷新轮换并作废旧 token）。
		adapter.refreshedCallback({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 12345 });
		// persistRotatedTokens 是异步 fire-and-forget，等它落盘后再重启。
		await new Promise((resolve) => setTimeout(resolve, 100));

		const sealedConfig = manager.providerConfigs.get("onedrive");
		assert.ok(sealedConfig);
		if (sealedConfig && "refreshToken" in sealedConfig) {
			assert.equal(sealedConfig.refreshToken, "new-refresh");
			assert.equal(sealedConfig.accessToken, "new-access");
		}

		// 重启（新实例同 userData）→ 解锁后 unseal 应拿到轮换后的新 refresh token。
		const manager2 = makeManager({ userDataDir, homeDir, createAdapter: () => createRotatingTokenAdapter() });
		await manager2.initialize();
		assert.equal(manager2.securityState(), "LOCKED");
		assert.equal(await manager2.unlock(PASSWORD), true);
		const unsealed = manager2.providerConfigs.get("onedrive");
		assert.ok(unsealed);
		if (unsealed && "refreshToken" in unsealed) {
			assert.equal(unsealed.refreshToken, "new-refresh");
		}

		await manager.dispose();
		await manager2.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
