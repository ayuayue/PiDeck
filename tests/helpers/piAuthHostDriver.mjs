/**
 * 认证助手（resources/pi-auth-host.mjs）的测试驱动。
 *
 * 助手按设计要 import 用户本机安装的 pi SDK，测试里不能依赖真实 pi，因此这里
 * 生成一个「假 pi 包」（package.json + dist/index.js）作为 SDK 入口，用行为脚本
 * 覆盖各类登录流程。驱动器只做 NDJSON 收发与超时保护。
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AUTH_HOST_PATH = join(REPO_ROOT, "resources", "pi-auth-host.mjs");

/**
 * 假 pi SDK 源码。行为按 providerId 分派，覆盖真实世界里见到的四类流程：
 * manual_code（anthropic/xai 这类授权码）、device_code + select（Copilot 这类）、
 * 回调胜出导致的 prompt 取消、以及失败路径。
 */
export const FAKE_PI_SDK_SOURCE = `
export const VERSION = "9.9.9-test";

/** 运行时是否假装成「拿不到内置目录」的旧 pi：由 FAKE_PI_LEGACY=1 触发。 */
const FAKE_LEGACY = process.env.FAKE_PI_LEGACY === "1";

export const ModelRuntime = {
	async create(options) {
		return {
			__options: options,
			getProviders() {
				return [
					{ id: "oauth-basic", name: "OAuth Basic", auth: { oauth: { name: "OAuth Basic (subscription)", isSubscription: true, loginLabel: "Sign in with Basic", login: async () => {} } } },
					{ id: "both", name: "Both Provider", auth: { oauth: { name: "Both OAuth", login: async () => {} }, apiKey: { name: "Both API key", login: async () => {} } } },
					{ id: "key-only", name: "Key Only", auth: { apiKey: { name: "Key Only API key", login: async () => {} } } },
					{ id: "ambient-only", name: "Ambient Only", auth: { apiKey: { name: "Ambient Only env key" } } },
					{ id: "no-auth", name: "No Auth", auth: {} },
					// 下面是场景供应商：真实 pi 里它们都在 getProviders() 里，登录前先校验 provider 存在
					{ id: "device-provider", name: "Device Provider", auth: { oauth: { name: "Device OAuth", login: async () => {} } } },
					{ id: "cancel-provider", name: "Cancel Provider", auth: { oauth: { name: "Cancel OAuth", login: async () => {} } } },
					{ id: "out-of-band-provider", name: "Out Of Band Provider", auth: { oauth: { name: "Out Of Band OAuth", login: async () => {} } } },
					{ id: "fail-provider", name: "Fail Provider", auth: { oauth: { name: "Fail OAuth", login: async () => {} } } },
					// 模拟 models.json 里用户自定义的供应商：pi 会为它兜底合成 apiKey 认证，
					// 名字就是千篇一律的 "API key"（真实 runtime 的 defaultBuiltins 里没有它）。
					{ id: "custom-models-json", name: "Custom Models JSON", auth: { apiKey: { name: "API key", login: async () => {} } } },
					// 扩展注册的供应商：不在内置目录里，但 getRegisteredProviderIds 会报出来。
					{ id: "ext-provider", name: "Extension Provider", auth: { oauth: { name: "Extension OAuth", login: async () => {} } } },
				];
			},
			getProvider(providerId) {
				return this.getProviders().find((provider) => provider.id === providerId);
			},
			// 与真实 ModelRuntime 一致：defaultBuiltins 是 pi 自己的内置供应商目录（普通字段），
			// getRegisteredProviderIds 报出扩展注册的供应商。FAKE_PI_LEGACY=1 时两者都不给，
			// 用来验证「宿主拿不到内置信息时不能凭空下结论」（见 piAuthHost.test.mjs）。
			...(FAKE_LEGACY
				? {}
				: {
						defaultBuiltins: new Map(["oauth-basic", "both", "key-only", "ambient-only", "no-auth", "device-provider", "cancel-provider", "out-of-band-provider", "fail-provider"].map((id) => [id, {}])),
						getRegisteredProviderIds() {
							return ["ext-provider"];
						},
					}),
			// 与真实 ModelRuntime 一致：状态来自 auth.json，已登录 = configured
			getProviderAuthStatus(providerId) {
				return { configured: this.listCredentialsSync().some((entry) => entry.providerId === providerId) };
			},
			isUsingOAuth(providerId) {
				return this.listCredentialsSync().some((entry) => entry.providerId === providerId && entry.type === "oauth");
			},
			listCredentialsSync() {
				return [
					{ providerId: "both", type: "oauth" },
					{ providerId: "key-only", type: "api_key" },
				];
			},
			async listCredentials() {
				return this.listCredentialsSync();
			},
			async logout(providerId) {
				if (providerId === "unknown-provider") throw new Error("Unknown provider: unknown-provider");
			},
			async login(providerId, type, interaction) {
				if (providerId === "oauth-basic") {
					interaction.notify({ type: "auth_url", url: "https://example.test/oauth/authorize", instructions: "Open the link" });
					const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code", placeholder: "http://localhost:53692/callback" });
					if (code !== "CODE-123") throw new Error("Missing authorization code");
					interaction.notify({ type: "progress", message: "Exchanging code" });
					return { providerId, type: "oauth" };
				}
				if (providerId === "device-provider") {
					interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.test/device", intervalSeconds: 5, expiresInSeconds: 60 });
					const choice = await interaction.prompt({
						type: "select",
						message: "Which account?",
						options: [
							{ id: "acct-1", label: "Account 1", description: "first" },
							{ id: "acct-2", label: "Account 2" },
						],
					});
					if (choice !== "acct-2") throw new Error("expected select answer");
					interaction.notify({ type: "info", message: "Signed in as account 2" });
					return { providerId, type: "oauth" };
				}
				if (providerId === "cancel-provider") {
					interaction.notify({ type: "auth_url", url: "https://example.test/oauth/authorize" });
					const aborted = new Promise((_, reject) => {
						interaction.signal.addEventListener("abort", () => {
							const error = new Error("This operation was aborted");
							error.name = "AbortError";
							reject(error);
						});
					});
					await Promise.race([interaction.prompt({ type: "manual_code", message: "Waiting for browser" }), aborted]);
					throw new Error("unreachable: abort raced ahead of prompt");
				}
				if (providerId === "out-of-band-provider") {
					interaction.notify({ type: "auth_url", url: "https://example.test/oauth/authorize" });
					const inner = new AbortController();
					setTimeout(() => inner.abort(), 20);
					// 真实 provider 的写法：回调先拿到授权码时提问会作废，provider 吞掉这个拒绝继续完成登录
					const code = await interaction.prompt({ type: "manual_code", message: "Paste code or wait", signal: inner.signal }).catch(() => undefined);
					if (code !== undefined) throw new Error("expected cancelled prompt");
					interaction.notify({ type: "progress", message: "Signed in via callback" });
					return { providerId, type: "oauth" };
				}
				if (providerId === "fail-provider") {
					interaction.notify({ type: "auth_url", url: "https://example.test/oauth/authorize" });
					throw new Error("boom: token exchange failed");
				}
				if (providerId === "key-only" && type === "api_key") {
					const key = await interaction.prompt({ type: "secret", message: "Enter Key Only API key" });
					if (!key) throw new Error("Missing API key");
					return { providerId, type: "api_key" };
				}
				if (providerId === "both" && type === "api_key") {
					const label = await interaction.prompt({ type: "text", message: "Optional label", placeholder: "blank is fine" });
					interaction.notify({ type: "info", message: "label=" + label });
					return { providerId, type: "api_key" };
				}
				throw new Error("Unknown provider: " + providerId);
			},
		};
	},
};
`;

/** 造一个最小可用的假 pi 包，返回 SDK 入口路径与清理函数。 */
export async function createFakePiPackage(script = FAKE_PI_SDK_SOURCE) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-pi-auth-fake-"));
	await mkdir(join(dir, "dist"), { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9-test" }), "utf8");
	await writeFile(join(dir, "dist", "index.js"), script, "utf8");
	return {
		dir,
		entry: join(dir, "dist", "index.js"),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/**
 * 启动助手进程并按 NDJSON 收发。
 *
 * 助手会持续等待下一条指令（宿主靠关 stdin / 杀进程结束它），所以驱动器必须在
 * 流程跑完时显式关闭 stdin —— 默认在拿到 result / fatal / providers 时关闭，
 * 对应「一次进程一个操作」的用法；需要 list→login 复用同一进程时用
 * closeStdinAfterMessage 自定义。
 *
 * @param {{ entry?: string, env?: Record<string, string>, commands?: unknown[], onMessage?: (message: any, send: (command: unknown) => void) => void, timeoutMs?: number, closeStdinAfterMessage?: (message: any) => boolean }} options
 */
export function runAuthHost({ entry, env = {}, commands = [], onMessage, timeoutMs = 20000, closeStdinAfterMessage } = {}) {
	return new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		if (entry) childEnv.PIDECK_PI_SDK_ENTRY = entry;
		else delete childEnv.PIDECK_PI_SDK_ENTRY;
		const child = spawn(process.execPath, [AUTH_HOST_PATH], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
		const messages = [];
		const stderr = [];
		let stdoutBuffer = "";
		let settled = false;
		const send = (command) => {
			if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
		};
		const timer = setTimeout(() => {
			finish({ timedOut: true });
		}, timeoutMs);
		const finish = (extra = {}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve({ code: child.exitCode, messages, stderr, timedOut: false, ...extra });
		};
		const shouldCloseStdin = closeStdinAfterMessage ?? ((message) => message.type === "result" || message.type === "fatal" || message.type === "providers");
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk;
			let index = stdoutBuffer.indexOf("\n");
			while (index >= 0) {
				const line = stdoutBuffer.slice(0, index).trim();
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				if (line) {
					const message = JSON.parse(line);
					messages.push(message);
					onMessage?.(message, send);
					if (shouldCloseStdin(message) && child.stdin.writable) child.stdin.end();
				}
				index = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr.push(String(chunk).trim());
		});
		child.on("close", (code) => finish({ code }));
		for (const command of commands) send(command);
	});
}

/** 常用断言取数：拿到最后一个 result 消息。 */
export function resultOf(messages) {
	return messages.findLast?.((message) => message.type === "result") ?? messages.filter((m) => m.type === "result").at(-1);
}

/** 常用断言取数：按顺序取某类消息。 */
export function messagesOfType(messages, type) {
	return messages.filter((message) => message.type === type);
}
