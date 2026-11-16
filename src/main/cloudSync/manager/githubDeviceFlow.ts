/**
 * GitHub Device Flow（RFC 8628）编排。从 `CloudSyncManager` 原样搬出：
 * device code 与 access token 只在主进程流转，永不进 renderer。
 */

import type { CloudSyncGithubPollResult, CloudSyncProviderConfigInput } from "../../../shared/types/cloudSync.ts";
import { pollGithubDeviceFlow, startGithubDeviceFlow, type GithubDeviceFlowStart } from "../adapters/GithubGistObjectStorage.ts";
import type { OAuthBuiltinCredentials } from "../oauthCredentials.ts";
import type { CloudSyncManagerOptions } from "../CloudSyncManager.ts";

/** GitHub Device Flow 需要宿主提供的窄接口（token 落库走宿主的 provider 配置）。 */
export interface CloudSyncGithubDeviceFlowHost {
	configureProvider(input: CloudSyncProviderConfigInput): Promise<void>;
}

export class CloudSyncGithubDeviceFlow {
	/** GitHub Device Flow 进行中的上下文（主进程持有，token 永不进 renderer）。
	 *  retryIntervalMs：当前轮询间隔（毫秒），slow_down 时累加 5s，服务端 interval 为基准。 */
	private deviceFlow: (GithubDeviceFlowStart & { clientId: string; retryIntervalMs: number }) | null = null;

	private readonly host: CloudSyncGithubDeviceFlowHost;
	private readonly options: CloudSyncManagerOptions;
	private readonly oauthBuiltins: OAuthBuiltinCredentials;

	constructor(host: CloudSyncGithubDeviceFlowHost, options: CloudSyncManagerOptions, oauthBuiltins: OAuthBuiltinCredentials) {
		this.host = host;
		this.options = options;
		this.oauthBuiltins = oauthBuiltins;
	}

	/** 当前进行中的设备流上下文（成功/终态错误后为 null）。 */
	get pendingFlow(): (GithubDeviceFlowStart & { clientId: string; retryIntervalMs: number }) | null {
		return this.deviceFlow;
	}

	/**
	 * 启动 GitHub Device Flow。
	 * clientId：优先使用构建期注入的内置凭据（`VITE_SYNC_GITHUB_CLIENT_ID`，
	 * 对齐 Netcatty，用户零配置）；未注入时使用用户自备值（BYO）。
	 */
	async startGithubDeviceFlow(clientId: string): Promise<GithubDeviceFlowStart> {
		const resolvedClientId = clientId.trim() || this.oauthBuiltins.githubClientId;
		if (resolvedClientId.length === 0 || resolvedClientId.length > 128) throw new TypeError("GitHub client id is invalid");
		const flow = await (this.options.startGithubDeviceFlowImpl ?? startGithubDeviceFlow)(resolvedClientId);
		// retryIntervalMs 以服务端 device authorization 响应里的 interval 为基准（秒 → 毫秒），下限 5s；
		// 之后 slow_down 在此基准上每次累加 5s，渲染层据 retryAfterMs 安排下一跳轮询。
		this.deviceFlow = {
			...flow,
			clientId: resolvedClientId,
			retryIntervalMs: Math.max(5_000, Number.isFinite(flow.interval) ? flow.interval * 1000 : 5_000),
		};
		return flow;
	}

	/**
	 * 轮询设备授权（RFC 8628）：
	 * - authorization_pending → pending，带当前 retryAfterMs；
	 * - slow_down → 间隔累加 5s，并返回增大后的 retryAfterMs；
	 * - access token 到手 → 用 token 直接配置 github provider（token 只在主进程，永不进 renderer）；
	 * - 终态错误（access_denied/expired_token 等）→ 清空 flow 并返回可展示的 error。
	 */
	async pollGithubDeviceFlow(): Promise<CloudSyncGithubPollResult> {
		const flow = this.deviceFlow;
		if (!flow) return { status: "error", error: "No active device flow" };
		try {
			const poll = this.options.pollGithubDeviceFlowImpl ?? pollGithubDeviceFlow;
			const result = await poll(flow.clientId, flow.deviceCode);
			if (result.accessToken) {
				this.deviceFlow = null;
				await this.host.configureProvider({ provider: "github", config: { token: result.accessToken, clientId: flow.clientId } });
				return { status: "ok" };
			}
			if (result.error === "slow_down") {
				flow.retryIntervalMs += 5_000;
				return { status: "pending", retryAfterMs: flow.retryIntervalMs };
			}
			if (result.error === "authorization_pending") {
				return { status: "pending", retryAfterMs: flow.retryIntervalMs };
			}
			this.deviceFlow = null;
			return { status: "error", error: result.errorDescription ?? result.error ?? "GitHub device flow failed" };
		} catch (error) {
			this.deviceFlow = null;
			return { status: "error", error: error instanceof Error ? error.message : String(error) };
		}
	}
}
