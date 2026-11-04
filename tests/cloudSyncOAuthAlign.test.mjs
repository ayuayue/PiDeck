import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { pollGithubDeviceFlow, startGithubDeviceFlow } from "../src/main/cloudSync/adapters/GithubGistObjectStorage.ts";
import { DEFAULT_GITHUB_CLIENT_ID, OAUTH_BUILTIN_CREDENTIALS, resolveOauthBuiltinCredentials } from "../src/main/cloudSync/oauthCredentials.ts";
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

/** 实现 PiDeckCloudObjectStorage 的假 GitHub 适配器（避免 connectProvider 打真实网络）。 */
function createGithubFakeAdapter() {
	return {
		providerId: "github",
		async connect() { return { account: { id: "gh", name: "GitHub" } }; },
		async disconnect() {},
		async getAccount() { return { id: "gh", name: "GitHub" }; },
		async getCapabilities() { return { revisions: true, conditionalWrites: true, atomicReplacement: false }; },
		async readObject(key) { return { found: false, key, bytes: null }; },
		async writeObject(key, bytes) { return { created: true, revision: "r1" }; },
		async deleteObject(key) { return { deleted: false }; },
	};
}

function makeManager({ userDataDir, homeDir, oauthBuiltins, createAdapter, startGithubDeviceFlowImpl, pollGithubDeviceFlowImpl }) {
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
		...(startGithubDeviceFlowImpl ? { startGithubDeviceFlowImpl } : {}),
		...(pollGithubDeviceFlowImpl ? { pollGithubDeviceFlowImpl } : {}),
	});
}

// ── 构建期 env 注入（对齐 Netcatty：VITE_SYNC_*） ─────────────────────────

test("resolveOauthBuiltinCredentials reads VITE_SYNC_* env vars", () => {
	assert.deepEqual(
		resolveOauthBuiltinCredentials({
			VITE_SYNC_GITHUB_CLIENT_ID: "gh-id",
			VITE_SYNC_ONEDRIVE_CLIENT_ID: " azure-id ",
			VITE_SYNC_GOOGLE_CLIENT_ID: "google-id",
			VITE_SYNC_GOOGLE_CLIENT_SECRET: "secret",
		}),
		{ githubClientId: "gh-id", onedriveClientId: "azure-id", googleClientId: "google-id", googleClientSecret: "secret" },
	);
	// 未注入 GitHub Client ID → 回退到公开默认值；其余 provider 仍为空（BYO）。
	assert.deepEqual(resolveOauthBuiltinCredentials({}), {
		githubClientId: DEFAULT_GITHUB_CLIENT_ID,
		onedriveClientId: "",
		googleClientId: "",
		googleClientSecret: "",
	});
	// 注入纯空白同样视为未注入 → 公开默认值。
	assert.deepEqual(resolveOauthBuiltinCredentials({ VITE_SYNC_GITHUB_CLIENT_ID: " \t " }), {
		githubClientId: DEFAULT_GITHUB_CLIENT_ID,
		onedriveClientId: "",
		googleClientId: "",
		googleClientSecret: "",
	});
});

test("manager uses built-in GitHub clientId for the device flow when the user leaves it empty", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-gh-builtin-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const requestedClientIds = [];
		const manager = makeManager({
			userDataDir,
			homeDir,
			oauthBuiltins: { githubClientId: "builtin-gh-id", onedriveClientId: "", googleClientId: "", googleClientSecret: "" },
			createAdapter: () => createRotatingTokenAdapter(),
			startGithubDeviceFlowImpl: async (clientId) => {
				requestedClientIds.push(clientId);
				return { deviceCode: "dc", userCode: "uc", verificationUrl: "https://github.com/login/device", expiresIn: 900, interval: 5 };
			},
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);

		// 用户不填 clientId → 设备流请求使用内置 clientId（对齐 Netcatty）。
		const flow = await manager.startGithubDeviceFlow("");
		assert.ok(flow.verificationUrl.length > 0);
		assert.deepEqual(requestedClientIds, ["builtin-gh-id"]);
		assert.equal(manager.getStateSnapshot().oauthBuiltins.github, true);

		// 未显式注入内置凭据 → 模块默认内置凭据兜底：空输入直接使用内置 GitHub Client ID。
		const defaultRequests = [];
		const emptyManager = makeManager({
			userDataDir: join(base, "ud2"),
			homeDir,
			startGithubDeviceFlowImpl: async (clientId) => {
				defaultRequests.push(clientId);
				return { deviceCode: "dc", userCode: "uc", verificationUrl: "https://github.com/login/device", expiresIn: 900, interval: 5 };
			},
		});
		await emptyManager.initialize();
		await emptyManager.setupMasterKey(PASSWORD);
		const defaultFlow = await emptyManager.startGithubDeviceFlow("");
		assert.ok(defaultFlow.verificationUrl.length > 0);
		// 与模块级 OAUTH_BUILTIN_CREDENTIALS 一致（未注入 env 时即公开默认值）。
		assert.ok(OAUTH_BUILTIN_CREDENTIALS.githubClientId.length > 0);
		assert.deepEqual(defaultRequests, [OAUTH_BUILTIN_CREDENTIALS.githubClientId]);
		assert.equal(emptyManager.getStateSnapshot().oauthBuiltins.github, true);
		await emptyManager.dispose();

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
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
		// persistRotatedTokens 是异步 fire-and-forget（PBKDF2 密封较慢），有界轮询等它落盘。
		for (let attempt = 0; attempt < 40; attempt++) {
			const sealed = manager.providerConfigs.get("onedrive");
			if (sealed && "refreshToken" in sealed && sealed.refreshToken === "new-refresh") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

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

// ── GitHub Device Flow 轮询定稿（RFC 8628 / Netcatty 对齐） ──────────────

test("GitHub device flow poll: pending → slow_down → ok, token configures provider and never enters snapshot", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-gh-poll-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const staged = [
			{ accessToken: "", error: "authorization_pending" },
			{ accessToken: "", error: "slow_down" },
			{ accessToken: "gh-token-123" },
		];
		const polled = [];
		const manager = makeManager({
			userDataDir,
			homeDir,
			oauthBuiltins: { githubClientId: "", onedriveClientId: "", googleClientId: "", googleClientSecret: "" },
			createAdapter: () => createGithubFakeAdapter(),
			startGithubDeviceFlowImpl: async () => ({
				deviceCode: "dc", userCode: "uc", verificationUrl: "https://github.com/login/device", expiresIn: 900, interval: 5,
			}),
			pollGithubDeviceFlowImpl: async (clientId, deviceCode) => {
				polled.push({ clientId, deviceCode });
				return staged.shift();
			},
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);

		await manager.startGithubDeviceFlow("test-gh-client");

		// 首跳按服务端 interval（5s）返回 pending；slow_down 在下一次轮询时把间隔累加到 10s。
		const first = await manager.pollGithubDeviceFlow();
		assert.deepEqual(first, { status: "pending", retryAfterMs: 5000 });
		const second = await manager.pollGithubDeviceFlow();
		assert.deepEqual(second, { status: "pending", retryAfterMs: 10000 });
		const third = await manager.pollGithubDeviceFlow();
		assert.deepEqual(third, { status: "ok" });

		// 每次轮询都带启动时确定的 clientId 与设备码（不用 userCode）。
		assert.deepEqual(polled, [
			{ clientId: "test-gh-client", deviceCode: "dc" },
			{ clientId: "test-gh-client", deviceCode: "dc" },
			{ clientId: "test-gh-client", deviceCode: "dc" },
		]);

		// 成功后 flow 清空、provider 配置落地；快照只暴露 configured 状态，绝不携带 token。
		assert.equal(manager.githubDeviceFlow, null);
		assert.deepEqual(manager.providerConfigs.get("github"), { token: "gh-token-123", clientId: "test-gh-client" });
		const snapshot = manager.getStateSnapshot();
		assert.equal(snapshot.providers.github.configured, true);
		assert.equal(JSON.stringify(snapshot).includes("gh-token-123"), false);

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("GitHub device flow poll: terminal error clears flow and surfaces a displayable error", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-gh-deny-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const manager = makeManager({
			userDataDir,
			homeDir,
			oauthBuiltins: { githubClientId: "builtin-gh-id", onedriveClientId: "", googleClientId: "", googleClientSecret: "" },
			createAdapter: () => createGithubFakeAdapter(),
			startGithubDeviceFlowImpl: async () => ({
				deviceCode: "dc", userCode: "uc", verificationUrl: "https://github.com/login/device", expiresIn: 900, interval: 5,
			}),
			pollGithubDeviceFlowImpl: async () => ({ accessToken: "", error: "access_denied", errorDescription: "The user denied access" }),
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);

		await manager.startGithubDeviceFlow("");
		const result = await manager.pollGithubDeviceFlow();
		assert.deepEqual(result, { status: "error", error: "The user denied access" });
		// 终态错误必须清空 flow（避免渲染层继续轮询），且不配置 provider。
		assert.equal(manager.githubDeviceFlow, null);
		assert.equal(manager.getStateSnapshot().providers.github.configured, false);

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("GitHub adapter parses interval from device authorization and token responses", async () => {
	const fakeFetch = (response) => async () => response;

	// 服务端在 token 响应中下发 slow_down + interval（秒）→ 适配器原样透出，供上层累加。
	const slowDown = await pollGithubDeviceFlow("client-id", "device-code", fakeFetch({
		json: async () => ({ error: "slow_down", interval: 10 }),
	}));
	assert.deepEqual(slowDown, { accessToken: "", error: "slow_down", errorDescription: undefined, interval: 10 });

	const denied = await pollGithubDeviceFlow("client-id", "device-code", fakeFetch({
		json: async () => ({ error: "access_denied" }),
	}));
	assert.deepEqual(denied, { accessToken: "", error: "access_denied", errorDescription: undefined, interval: undefined });

	const ok = await pollGithubDeviceFlow("client-id", "device-code", fakeFetch({
		json: async () => ({ access_token: "tok" }),
	}));
	assert.deepEqual(ok, { accessToken: "tok" });

	// device authorization：显式 interval 原样返回；缺省兜底 5s。
	const withInterval = await startGithubDeviceFlow("client-id", fakeFetch({
		status: 200,
		json: async () => ({ device_code: "dc", user_code: "uc", verification_url: "https://github.com/login/device", expires_in: 900, interval: 7 }),
	}));
	assert.equal(withInterval.interval, 7);

	const defaultInterval = await startGithubDeviceFlow("client-id", fakeFetch({
		status: 200,
		json: async () => ({ device_code: "dc", user_code: "uc", verification_url: "https://github.com/login/device", expires_in: 900 }),
	}));
	assert.equal(defaultInterval.interval, 5);
});
