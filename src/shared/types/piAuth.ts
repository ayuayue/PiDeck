/**
 * pi 供应商认证（登录/登出）的跨进程契约。
 *
 * 为什么单独一层：pi 的供应商登录只存在于它的 CLI 交互层（`pi` 里的 `/login`），
 * RPC 方法表与扩展 API 都没有入口。PiDeck 复用 pi 官方的 `ModelRuntime` 认证 API
 * 完成登录，凭据仍由 pi 自己写进它的 `auth.json`。这是 PiDeck 访问 pi 内部能力的
 * 唯一例外通道（详见仓库根 AGENTS.md「认证例外通道」），因此这里的类型刻意只覆盖
 * 「列供应商 / 登录 / 回答提问 / 取消 / 登出」五件事，不向通用 pi API 桥扩张。
 *
 * 事件与提问结构逐字对齐 `@earendil-works/pi-ai` 的 `AuthEvent` / `AuthPrompt`：
 * 认证流程由 pi 实现并演进，宿主只做渲染与回填，不对流程做二次语义加工。
 */

/** 登录方式：订阅登录（OAuth/设备码）或 API key。 */
export type PiAuthMethod = "oauth" | "api_key";

/** 一个可选认证方式：`label` 由 pi 给出（如 "Sign in with Kimi Code"）。 */
export type PiAuthOAuthOption = {
	label: string;
	/** pi 标记该方式走供应商订阅额度（而非按量计费）。 */
	isSubscription: boolean;
};

export type PiAuthApiKeyOption = {
	name: string;
	/**
	 * false = pi 侧没有交互式录入实现，只能用环境变量/AWS 凭据文件等外部来源。
	 * 宿主因此不给它「录入密钥」入口，避免点进去必然失败。
	 */
	canLogin: boolean;
};

/** 供应商列表项；`credential` 表示 pi 的 auth.json 里已有可用凭据。 */
export type PiAuthProviderOption = {
	id: string;
	name: string;
	oauth?: PiAuthOAuthOption;
	apiKey?: PiAuthApiKeyOption;
	/** 两种方式都没有交互式登录（如仅支持环境变量的供应商）。 */
	ambientOnly: boolean;
	credential?: { type: PiAuthMethod };
};

export type PiAuthProviderList = {
	providers: PiAuthProviderOption[];
	/** 当前解析到的 pi 版本；宿主可在过旧时提示。 */
	piVersion?: string;
};

/** pi 认证流程推送的事件（AuthEvent 原样透传）。 */
export type PiAuthFlowEvent =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };

/**
 * pi 需要用户回答的提问。
 * `kind` 与 AuthPrompt 的四型一一对应：text / secret / select / manual_code。
 */
export type PiAuthPrompt = {
	/** 本次登录内的提问 id；宿主回填时原样带回。 */
	id: string;
	kind: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	/** kind === "select" 时的可选项；回填值必须是某个 option 的 id。 */
	options?: readonly { id: string; label: string; description?: string }[];
};

/** 主进程 → 渲染层的登录流程推送。 */
export type PiAuthFlowUpdate = { kind: "event"; event: PiAuthFlowEvent } | { kind: "prompt"; prompt: PiAuthPrompt } | { kind: "prompt-cancelled"; promptId: string };

export type PiAuthLoginRequest = {
	providerId: string;
	method: PiAuthMethod;
};

/** 失败分类：渲染层据此挑选文案，不解析 message 文本。 */
export type PiAuthErrorKind = "unknown-provider" | "unsupported" | "login-failed" | "sdk-unavailable" | "spawn-failed" | "busy" | "timeout" | "protocol";

export type PiAuthLoginResult = {
	ok: boolean;
	/** 用户主动取消（关弹框/点取消）：不是错误，不弹红色提示。 */
	cancelled: boolean;
	providerId: string;
	/** 原始错误信息；渲染层包一层本地化文案后再展示。 */
	error?: string;
	errorKind?: PiAuthErrorKind;
};

export type PiAuthLogoutResult = {
	ok: boolean;
	providerId: string;
	error?: string;
};
