/**
 * OneDrive / Google Drive 浏览器授权编排（PKCE + 回环回调）。从 `CloudSyncManager` 原样搬出：
 * codeVerifier 单次有效，回环 HTTP 服务随流程结束或 `dispose()` 清理；token 只在主进程流转，
 * 拿码换到 token 后交给宿主的 provider 配置落库（永不进 renderer）。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { CloudSyncGoogleFlowStart, CloudSyncOneDriveFlowStart, CloudSyncProviderConfigInput } from "../../../shared/types/cloudSync.ts";
import type { OAuthBuiltinCredentials } from "../oauthCredentials.ts";
import type { CloudSyncManagerOptions } from "../CloudSyncManager.ts";

/** 浏览器授权需要宿主提供的窄接口（主密码状态与 provider 配置落库都留在宿主）。 */
export interface CloudSyncProviderOAuthHost {
	securityState(): "NO_KEY" | "LOCKED" | "UNLOCKED";
	configureProvider(input: CloudSyncProviderConfigInput): Promise<void>;
}

export class CloudSyncProviderOAuthFlows {
	/** OneDrive 浏览器授权进行中的上下文（PKCE codeVerifier 单次有效，回环服务随 dispose 清理）。 */
	private oneDriveFlow: {
		clientId: string;
		codeVerifier: string;
		state: string;
		port: number;
		server: import("node:http").Server;
		resolved: { code: string } | { error: string } | null;
	} | null = null;
	/** Google 浏览器授权进行中的上下文（镜像 OneDrive，额外携带可选 clientSecret 供换码）。 */
	private googleFlow: {
		clientId: string;
		clientSecret?: string;
		codeVerifier: string;
		state: string;
		port: number;
		server: import("node:http").Server;
		resolved: { code: string } | { error: string } | null;
	} | null = null;

	private readonly host: CloudSyncProviderOAuthHost;
	private readonly options: CloudSyncManagerOptions;
	private readonly oauthBuiltins: OAuthBuiltinCredentials;

	constructor(host: CloudSyncProviderOAuthHost, options: CloudSyncManagerOptions, oauthBuiltins: OAuthBuiltinCredentials) {
		this.host = host;
		this.options = options;
		this.oauthBuiltins = oauthBuiltins;
	}

	// ── OneDrive 浏览器授权（PKCE + 回环回调，token 只在主进程流转） ──

	/**
	 * Start the OneDrive authorization-code + PKCE flow.
	 *
	 * clientId：优先使用构建期注入的内置凭据（`VITE_SYNC_ONEDRIVE_CLIENT_ID`，
	 * 对齐 Netcatty，用户零配置）；未注入时使用用户自备值（BYO）。
	 * 回环 HTTP 服务收回调；渲染层展示 verificationUrl 并轮询 pollOneDriveOAuth()。
	 */
	async startOneDriveOAuth(clientId: string): Promise<CloudSyncOneDriveFlowStart> {
		if (this.host.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		const resolvedClientId = clientId.trim() || this.oauthBuiltins.onedriveClientId;
		if (resolvedClientId.length === 0 || resolvedClientId.length > 128) throw new TypeError("OneDrive clientId is invalid");
		// 重启流程：关掉旧回环服务，避免端口/状态残留。
		this.closeOneDriveFlowServer();

		const codeVerifier = randomBytes(43).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const state = randomUUID();
		const resolved: { code: string } | { error: string } | null = null;

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			const callbackState = url.searchParams.get("state");
			if (this.oneDriveFlow && callbackState === this.oneDriveFlow.state && (code || error)) {
				this.oneDriveFlow.resolved = code ? { code } : { error: error ?? "access_denied" };
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end('<!doctype html><meta charset="utf-8"><p>授权成功，可以关闭此页面。</p>');
				// 回调已到达：只关本服务（resolved 留给 poll 处理，绝不能清 flow）。
				setTimeout(() => {
					try {
						server.close();
					} catch {
						// 已被 poll/dispose 关闭：忽略。
					}
				}, 300);
				return;
			}
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not found");
		});

		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", rejectListen);
				resolveListen();
			});
		});
		const port = (server.address() as { port: number }).port;
		this.oneDriveFlow = { clientId: resolvedClientId, codeVerifier, state, port, server, resolved };

		const redirectUri = encodeURIComponent(`http://localhost:${port}`);
		const verificationUrl =
			"https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize" + `?client_id=${encodeURIComponent(resolvedClientId)}` + `&response_type=code&redirect_uri=${redirectUri}` + "&scope=Files.ReadWrite.AppFolder%20offline_access" + `&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;
		return { verificationUrl, port };
	}

	/** 轮询 OneDrive 授权；拿到 code 后换 token 并完成 provider 配置。 */
	async pollOneDriveOAuth(): Promise<{ status: "ok" | "pending" | "error"; error?: string }> {
		const flow = this.oneDriveFlow;
		if (!flow) return { status: "error", error: "No active OneDrive authorization flow" };
		if (!flow.resolved) return { status: "pending" };
		try {
			if ("error" in flow.resolved) {
				// 先关服务再清状态：closeOneDriveFlowServer 依赖 flow 引用。
				this.closeOneDriveFlowServer();
				this.oneDriveFlow = null;
				return { status: "error", error: flow.resolved.error };
			}
			const redirectUri = `http://localhost:${flow.port}`;
			const exchange = this.options.exchangeOneDriveCode ?? this.exchangeOneDriveCode;
			const tokens = await exchange({
				clientId: flow.clientId,
				tenant: "consumers",
				code: flow.resolved.code,
				codeVerifier: flow.codeVerifier,
				redirectUri,
			});
			this.closeOneDriveFlowServer();
			this.oneDriveFlow = null;
			await this.host.configureProvider({
				provider: "onedrive",
				config: {
					clientId: flow.clientId,
					accessToken: tokens.accessToken,
					...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
					expiresAt: Date.now() + tokens.expiresIn * 1000,
				},
			});
			return { status: "ok" };
		} catch (error) {
			this.closeOneDriveFlowServer();
			this.oneDriveFlow = null;
			return { status: "error", error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 默认 token 交换：POST Microsoft identity 端点（全局 fetch，无新依赖）。 */
	private readonly exchangeOneDriveCode = async (input: { clientId: string; tenant: string; code: string; codeVerifier: string; redirectUri: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> => {
		const body = new URLSearchParams({
			client_id: input.clientId,
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.codeVerifier,
			scope: "Files.ReadWrite.AppFolder offline_access",
		});
		const response = await fetch(`https://login.microsoftonline.com/${input.tenant}/oauth2/v2.0/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		if (response.status !== 200) {
			throw new Error(`OneDrive token exchange failed (HTTP ${response.status})`);
		}
		const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (typeof token.access_token !== "string" || token.access_token.length === 0) {
			throw new Error("OneDrive token exchange returned no access token");
		}
		return {
			accessToken: token.access_token,
			...(typeof token.refresh_token === "string" && token.refresh_token.length > 0 ? { refreshToken: token.refresh_token } : {}),
			expiresIn: typeof token.expires_in === "number" && Number.isFinite(token.expires_in) ? token.expires_in : 3600,
		};
	};

	private closeOneDriveFlowServer(): void {
		const flow = this.oneDriveFlow;
		if (!flow) return;
		try {
			flow.server.close();
		} catch {
			// 已关闭/从未监听：忽略。
		}
	}

	// ── Google Drive 浏览器授权（PKCE + 回环回调，镜像 OneDrive 流程） ─────

	/**
	 * Start the Google authorization-code + PKCE flow (desktop app client).
	 * clientId/clientSecret：优先使用构建期注入的内置凭据（VITE_SYNC_GOOGLE_*，
	 * 对齐 Netcatty）；未注入时使用用户自备值（BYO）。access_type=offline +
	 * prompt=consent 保证个人账号有 refresh token。
	 */
	async startGoogleOAuth(clientId: string, clientSecret?: string): Promise<CloudSyncGoogleFlowStart> {
		if (this.host.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		const resolvedClientId = clientId.trim() || this.oauthBuiltins.googleClientId;
		const resolvedClientSecret = clientSecret?.trim() || this.oauthBuiltins.googleClientSecret || undefined;
		if (resolvedClientId.length === 0 || resolvedClientId.length > 128) throw new TypeError("Google Drive clientId is invalid");
		this.closeGoogleFlowServer();

		const codeVerifier = randomBytes(43).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const state = randomUUID();

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			const callbackState = url.searchParams.get("state");
			if (this.googleFlow && callbackState === this.googleFlow.state && (code || error)) {
				this.googleFlow.resolved = code ? { code } : { error: error ?? "access_denied" };
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end('<!doctype html><meta charset="utf-8"><p>授权成功，可以关闭此页面。</p>');
				// 回调已到达：只关本服务（resolved 留给 poll 处理，绝不能清 flow）。
				setTimeout(() => {
					try {
						server.close();
					} catch {
						// 已被 poll/dispose 关闭：忽略。
					}
				}, 300);
				return;
			}
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not found");
		});

		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", rejectListen);
				resolveListen();
			});
		});
		const port = (server.address() as { port: number }).port;
		this.googleFlow = {
			clientId: resolvedClientId,
			...(resolvedClientSecret ? { clientSecret: resolvedClientSecret } : {}),
			codeVerifier,
			state,
			port,
			server,
			resolved: null,
		};

		const redirectUri = encodeURIComponent(`http://localhost:${port}`);
		const scope = encodeURIComponent("https://www.googleapis.com/auth/drive.appfolder");
		const verificationUrl =
			"https://accounts.google.com/o/oauth2/v2/auth" + `?client_id=${encodeURIComponent(resolvedClientId)}` + `&redirect_uri=${redirectUri}` + `&response_type=code&scope=${scope}` + `&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}` + "&access_type=offline&prompt=consent";
		return { verificationUrl, port };
	}

	/** 轮询 Google 授权；拿到 code 后换 token 并完成 provider 配置。 */
	async pollGoogleOAuth(): Promise<{ status: "ok" | "pending" | "error"; error?: string }> {
		const flow = this.googleFlow;
		if (!flow) return { status: "error", error: "No active Google authorization flow" };
		if (!flow.resolved) return { status: "pending" };
		try {
			if ("error" in flow.resolved) {
				// 先关服务再清状态：closeGoogleFlowServer 依赖 flow 引用。
				this.closeGoogleFlowServer();
				this.googleFlow = null;
				return { status: "error", error: flow.resolved.error };
			}
			const redirectUri = `http://localhost:${flow.port}`;
			const exchange = this.options.exchangeGoogleCode ?? this.exchangeGoogleCode;
			const tokens = await exchange({
				clientId: flow.clientId,
				clientSecret: flow.clientSecret,
				code: flow.resolved.code,
				codeVerifier: flow.codeVerifier,
				redirectUri,
			});
			this.closeGoogleFlowServer();
			this.googleFlow = null;
			await this.host.configureProvider({
				provider: "google",
				config: {
					clientId: flow.clientId,
					...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
					accessToken: tokens.accessToken,
					...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
					expiresAt: Date.now() + tokens.expiresIn * 1000,
				},
			});
			return { status: "ok" };
		} catch (error) {
			this.closeGoogleFlowServer();
			this.googleFlow = null;
			return { status: "error", error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 默认 token 交换：POST Google token 端点（全局 fetch，无新依赖）。 */
	private readonly exchangeGoogleCode = async (input: { clientId: string; clientSecret?: string; code: string; codeVerifier: string; redirectUri: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> => {
		const body = new URLSearchParams({
			client_id: input.clientId,
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.codeVerifier,
		});
		if (input.clientSecret) body.set("client_secret", input.clientSecret);
		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		if (response.status !== 200) {
			throw new Error(`Google token exchange failed (HTTP ${response.status})`);
		}
		const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (typeof token.access_token !== "string" || token.access_token.length === 0) {
			throw new Error("Google token exchange returned no access token");
		}
		return {
			accessToken: token.access_token,
			...(typeof token.refresh_token === "string" && token.refresh_token.length > 0 ? { refreshToken: token.refresh_token } : {}),
			expiresIn: typeof token.expires_in === "number" && Number.isFinite(token.expires_in) ? token.expires_in : 3600,
		};
	};

	private closeGoogleFlowServer(): void {
		const flow = this.googleFlow;
		if (!flow) return;
		try {
			flow.server.close();
		} catch {
			// 已关闭/从未监听：忽略。
		}
	}

	/** 关闭两条回环服务并丢弃流程上下文（宿主 dispose 时调用）。 */
	dispose(): void {
		this.closeOneDriveFlowServer();
		this.oneDriveFlow = null;
		this.closeGoogleFlowServer();
		this.googleFlow = null;
	}
}
