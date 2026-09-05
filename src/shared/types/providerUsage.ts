/**
 * Provider 用量/余额查询结果（主进程 ProviderUsageService 产出，渲染层圆环面板消费）。
 *
 * 各 provider 的用量接口形态差异很大，这里统一成三类展示形态：
 * - periods：三档占用百分比（滚动/周/月），opencode-go /v1/usage 等网关语义；
 * - balance：剩余额度（金额 + 币种），DeepSeek /user/balance 等；
 * - credits：额度点数（总额/已用/剩余），OpenRouter /credits 等。
 * 解析不出任何形态时保留 raw（脱敏后）供调试；kind 显式标注形态，避免渲染层靠字段猜测。
 *
 * 配置形态（学 cc-switch）：
 * - 内置候选表自动识别（零配置），命中即「内置模板」；
 * - 声明式模板（通用 / New API）由用户按 provider 配置，只有这两种可选；
 * - 不做脚本级自定义（用户和我们都整不明白），旧 probes 数组仅保留读取兼容。
 */
export type ProviderUsagePeriod = {
	/** 该档位用量百分比（0-100）；未知时省略。 */
	percent?: number;
	/** 该档位重置时间（ISO 字符串）；未知时省略。 */
	resetsAt?: string;
	/** 该档位可用状态（如 "ok" / "trial" / "over-quota"）；opencode-go 原样透传。 */
	status?: string;
};

export type ProviderUsageKind = "periods" | "balance" | "credits";

export type ProviderUsageCredits = {
	total?: number;
	used?: number;
	remaining?: number;
	/**
	 * 多窗口额度：同一 provider 的并列限额（如智谱 5h 滚动窗 + 周窗、
	 * xAI 套餐内额度 + 按需用量），各窗口是独立配额。
	 * 有则 UI 逐窗口展示（条 + 百分比）；无则仅主值。
	 */
	windows?: { key: string; total?: number; used?: number; remaining?: number }[];
};

/**
 * 独立货币额度（如 Kimi Coding 的 Boost 点数）：与主额度同响应、不同语义，
 * 单独展示而不混进主 credits 数值，避免误导用户当成同一单位的余额。
 * 所有金额字段统一为「元」或「点数主单位」的浮点数。
 */
export type ProviderUsageBooster = {
	/** 剩余余额（主单位，如元）。 */
	balance: number;
	/** 总额（主单位）；未知时省略。 */
	total?: number;
	/** 币种（如 CNY）；未知时省略。 */
	currency?: string;
	/** 本月已用（主单位）。 */
	monthlyUsed?: number;
	/** 月限额（主单位）；未启用或未知时省略。 */
	monthlyChargeLimit?: number;
	/** 月限额明确未启用（服务端返回 unlimited）。 */
	unlimitedMonthly?: boolean;
};

// ── 用量查询模板（面向用户场景，学 cc-switch：不给用户选显示方式） ──────────
//
// 显示方式完全由模板解析结果决定：unit=% → 百分比、币种 → 金额、点数 → 数字，
// 用户不参与选择；模板分类只决定弹窗里「识别命中」的说明文案。

/**
 * 模板类别（面向用户场景）：决定弹窗默认选中的 pill 与说明文案。
 * - balance：官方余额（DeepSeek / OpenRouter / Moonshot 官网 /user/balance 等）；
 * - plan：套餐额度（Kimi Coding / 智谱 Coding Plan / OpenCode Go 等）；
 * - subscription：官方订阅（登录态 OAuth：Codex / xAI，凭据来自 auth.json）；
 * - general：通用 OpenAI 兼容 /usage（端点自定义场景的可选覆盖模板）；
 * - newapi：New API / OneAPI 中转站（需要访问令牌 + 用户 ID）。
 */
export type UsageProbeTemplateCategory =
	| "balance"
	| "plan"
	| "subscription"
	| "general"
	| "newapi"
	| "cookie";

/** 声明式模板元数据（渲染层 pills 数据源；纯数据、无密钥）。 */
export type UsageProbeTemplateMeta = {
	id: string;
	category: UsageProbeTemplateCategory;
};

/** 内置候选的 templateId → 展示类别（识别命中的弹窗默认态）。 */
export type UsageProbeRecognition = {
	/** 命中的内置候选 templateId（如 "deepseek-balance"）。 */
	templateId: string;
	/** 面向用户的类别。 */
	category: UsageProbeTemplateCategory;
};

/** 用量查询的配置宿主：pi（~/.pi/agent/usage-probes.json）或 dsh（$DSH_HOME/usage-probes.json）。 */
export type UsageProbeBackend = "pi" | "dsh";

/**
 * 单 provider 的用量查询配置（~/.pi/agent/usage-probes.json 的 providers 映射条目）。
 * 内置命中的 provider 不写任何字段也生效（内置默认开）；显式 disabled=false 才关闭。
 */
export type UsageProbeProviderConfig = {
	/** 启动开关。不写 = 自动（内置命中即开、未命中即按未配置处理）。 */
	enabled?: boolean;
	/**
	 * 模板 id："general" | "newapi" | "cookie"（声明式）；内置命中的 provider 可省略
	 * （自动识别），识别不到时用户必须显式选一个声明式模板。
	 */
	template?: string;
	/** 通用模板可选覆盖：度量请求的 API Key；留空 = 自动使用供应商配置。 */
	apiKey?: string;
	/** 通用/New API/Cookie 模板可选覆盖：用量端点与推理端点不同域时的请求地址；留空 = 供应商地址。 */
	baseUrl?: string;
	/** NewAPI 模板：访问令牌（供应商「个人设置 → 安全」生成）。 */
	accessToken?: string;
	/** NewAPI 模板：用户 ID。 */
	userId?: string;
	/** Cookie 模板：网页登录态 Cookie 完整值（F12 → Network → 请求头 Cookie）。 */
	cookie?: string;
	/** Cookie 模板：余额/用量接口路径（以 / 开头，如 /api/wallet/summary）。 */
	cookiePath?: string;
	/** Cookie 模板：剩余额度字段路径（点号+方括号，如 data.availableBalanceCny）。 */
	valuePath?: string;
	/** Cookie 模板：币种字段路径（可选，如 data.currency）。 */
	currencyPath?: string;
	/** 超时（秒），默认 10。 */
	timeoutSecs?: number;
	/** 自动查询间隔（分钟），默认 5；0 = 不自动。 */
	intervalMinutes?: number;
};

/** get-usage-probes 返回（按 provider 查询，弹窗打开时拉取）。 */
export type UsageProbeSettingsResult = {
	/** 该 provider 已保存的配置；未配置过 = 省略。 */
	config?: UsageProbeProviderConfig;
	/** 内置模板自动识别结果；未命中 = null。 */
	recognized: UsageProbeRecognition | null;
	/** 声明式模板元数据（pills 渲染用）。 */
	templates: UsageProbeTemplateMeta[];
	/** 配置文件读取/校验错误（不含密钥）。 */
	errors: string[];
	/**
	 * 该 provider 命中的旧版 probes 数组条目（原样回显，含 cookie 等用户自有字段）：
	 * 弹窗用于「检测到旧格式配置 → 预填 Cookie 模板」迁移提示。未命中/无旧探针 = 省略。
	 */
	legacyProbes?: UsageProbeConfig[];
};

/** save-usage-probes 入参：按 provider 合并写（保留文件里其它 providers 与旧 probes 数组）。 */
export type UsageProbeSaveInput = {
	provider: string;
	/** 配置宿主：pi 落 ~/.pi/agent，dsh 落 $DSH_HOME（缺省 pi）。 */
	backend?: UsageProbeBackend;
	config: UsageProbeProviderConfig;
};

/** save-usage-probes 返回。 */
export type UsageProbeSaveResult = {
	ok: boolean;
	/** 校验/写盘失败原因；ok=true 时省略。 */
	error?: string;
};

/**
 * test-usage-probe 入参：模板 id + 模板所需字段（密钥只在主进程发请求，不回传）。
 * template 省略 = 按 provider 自动识别内置模板；无内置且未给模板时报错。
 */
export type UsageProbeTestInput = {
	provider: string;
	/** 配置宿主（缺省 pi）；dsh = 端点走 pi-ai catalog 兜底、凭据从 $DSH_HOME/.credentials.yaml 读。 */
	backend?: UsageProbeBackend;
	/** "general" | "newapi" | "cookie" | 内置 templateId（省略 = 自动识别）。 */
	template?: string;
	apiKey?: string;
	baseUrl?: string;
	accessToken?: string;
	userId?: string;
	cookie?: string;
	cookiePath?: string;
	valuePath?: string;
	currencyPath?: string;
	/** 测试用超时（秒）；缺省 10。 */
	timeoutSecs?: number;
};

// ── 旧格式兼容（AI 直接写的全局探针；只读，不再有 UI 管理入口） ──────────────
//
// usage-probes.json 里的 probes 数组仍保留读取（运行时按 baseUrl 合并探测），
// 供 AI/高级用户在终端直接写；弹窗不再暴露字段级自定义。

/** 多窗口条目（声明式）：绝对路径单窗 / 数组遍历 + where 匹配单窗。 */
export type UsageProbeWindowConfig =
	| {
			key: string;
			totalPath: string;
			usedPath: string;
			remainingPath?: string;
	  }
	| {
			key: string;
			/** 数组路径（如 "data.limits"）：在该数组里按 where 找第一个全部条件匹配的元素。 */
			listPath: string;
			/** 匹配条件（AND）：元素上 getByPath(path) 严格等于 eq（JSON 基本类型）。 */
			where: { path: string; eq: unknown }[];
			totalPath: string;
			usedPath: string;
			remainingPath?: string;
	  };

/** 独立货币额度解析规格（如 Kimi Boost 点数；定点余额/分钱字段换算成主单位）。 */
export type UsageProbeBoosterConfig = {
	balancePath: string;
	totalPath?: string;
	currencyPath?: string;
	monthlyUsedCentsPath?: string;
	monthlyChargeLimitCentsPath?: string;
	monthlyChargeLimitEnabledPath?: string;
	fixedPointPerCent?: number;
};

/**
 * 旧探针的响应解析规格；不接受 kind:"custom"（专用解析器仅限内置）。
 * credits 的 scale 用于「原始积分」类响应（如 New API 的 quota 字段需除以 500000 得美元）。
 */
export type UsageProbeParseConfig =
	| { kind: "periods" }
	| { kind: "balance"; valuePath: string; currencyPath?: string }
	| {
			kind: "credits";
			totalPath?: string;
			usedPath?: string;
			remainingPath?: string;
			/** 数值缩放：total/used/remaining 命中后先除以该值（New API quota → USD 用 500000）。 */
			scale?: number;
			windows?: UsageProbeWindowConfig[];
			booster?: UsageProbeBoosterConfig;
	  };

/** 单条旧探针（与 usage-probes.json 数组条目同构，全部可序列化纯数据）。 */
export type UsageProbeConfig = {
	/** 展示名（仅日志/自述用，不影响匹配）。 */
	name?: string;
	match?: {
		/** baseUrl 包含任一关键字即适用（小写匹配，可写域名或任意路径片段）。 */
		baseUrlContains?: string[];
		/** 可选：限定 api 类型（normalizeApiType 归一化后）。 */
		apiTypes?: string[];
	};
	request?: {
		/** 相对 baseUrl 的路径，如 "/user/balance"；必须以 / 开头。 */
		path?: string;
		/** 方法，缺省 GET。 */
		method?: "GET" | "POST";
		/** POST 请求体（GET 忽略）。 */
		body?: unknown;
		/** 额外请求头；可用 {{apiKey}} 占位，真实 key 只在主进程发请求时替换。 */
		headers?: Record<string, string>;
		/** 端点挂在 host 根而非 baseUrl 路径下（如智谱监控 API）：true 时只取 baseUrl origin 拼接。 */
		rootPath?: boolean;
	};
	parse?: UsageProbeParseConfig;
};

export type ProviderUsageResult = {
	success: boolean;
	/** provider 名（渲染层传入，原样带回，用于面板标题）。 */
	provider?: string;
	/** 解析出的展示形态；成功但未识别到任何形态时省略。 */
	kind?: ProviderUsageKind;
	/** kind=periods：三档用量。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", ProviderUsagePeriod>>;
	/** kind=balance：剩余额度（数值 + 可选币种）。 */
	balance?: { value: number; currency?: string };
	/** kind=credits：额度点数。remaining 优先展示；缺 remaining 时由 total-used 反推。 */
	credits?: ProviderUsageCredits;
	/** 与主额度并存的独立货币（如 Kimi Boost 点数）；有则 UI 追加展示。 */
	booster?: ProviderUsageBooster;
	/**
	 * 无法结构化解析时保留的原始响应体（已脱敏/截断，可安全展示）。
	 * 也用于标记「未启用用量查询」这类结构性失败（success=false 且 error 带标识）。
	 */
	raw?: string;
	/**
	 * 结构性失败标记：用量查询未开启（providers[name].enabled=false 门控命中）。
	 * 渲染层据此显示「用量查询未开启 → 去配置」的小引导，而不是通用错误文案。
	 */
	disabled?: boolean;
	/** 该 provider 生效的自动查询间隔（分钟；0 = 不自动）。主进程按配置计算，渲染层轮询用。 */
	intervalMinutes?: number;
	/** 失败原因（主进程本地文案或 HTTP 错误摘要）。 */
	error?: string;
	/**
	 * 失败时的排查明细（尝试过的 URL + HTTP 状态/网络错误 + 响应摘要 + 归纳提示），
	 * 多行文本、已脱敏；渲染层可折叠展示，帮用户定位「地址/鉴权/接口是否变更」。
	 */
	detail?: string;
	/** 查询时刻（Date.now()），渲染层据此判断数据新旧。 */
	at?: number;
};
