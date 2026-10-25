import type { McpServerDefinition } from "../../../shared/types/mcp";

/**
 * 内置 MCP 服务目录（国产服务批次接入方式逐项按官方文档核实，见 docs/mcp-config-form-redesign.md）。
 * 数据层只声明「凭据字段 + 写入位置」，不含密钥值；表单渲染与落盘字段映射都由这里的声明驱动。
 */
export type McpCatalogAuthKind = "none" | "oauth" | "header-key" | "env-key" | "url-key" | "multi-key";

export type McpCatalogCategory = "dev" | "work" | "data" | "maps" | "search" | "design";

/**
 * 单个凭据字段的写入位置：HTTP 头 / stdio 环境变量 / URL query 参数 / 命令行参数。
 * header 的 `scheme` 缺省表示按原值写入——腾讯文档、Exa 等官方要求裸 token（写 `Bearer ` 会被判 400006 invalid_token）。
 */
export type McpCatalogCredential = { kind: "header"; header: string; scheme?: "Bearer" } | { kind: "env"; envKey: string } | { kind: "url-query"; param: string } | { kind: "args"; flag: string };

/** 一个凭据输入框的声明：标签 + 写入位置 + 是否可留空。 */
export type McpCatalogCredentialField = {
	labelKey: McpCatalogTextKey;
	credential: McpCatalogCredential;
	/** 可选凭据（keyless 也可用）：不拦空值，提示语不同。 */
	optional?: boolean;
};

/** 文案 key 窄联合：t() 拿到字面量类型，双语漏加直接 typecheck 红灯。 */
export type McpCatalogTextKey =
	| "config.mcp.catalog.pideck"
	| "config.mcp.catalog.pideckHint"
	| "config.mcp.catalog.context7"
	| "config.mcp.catalog.playwright"
	| "config.mcp.catalog.chromeDevtools"
	| "config.mcp.catalog.github"
	| "config.mcp.catalog.sentry"
	| "config.mcp.catalog.supabase"
	| "config.mcp.catalog.linear"
	| "config.mcp.catalog.notion"
	| "config.mcp.catalog.baizhi"
	| "config.mcp.catalog.baizhiHint"
	| "config.mcp.catalog.baizhiKey"
	| "config.mcp.catalog.braveSearch"
	| "config.mcp.catalog.firecrawl"
	| "config.mcp.catalog.figma"
	| "config.mcp.catalog.lark"
	| "config.mcp.catalog.dingtalk"
	| "config.mcp.catalog.amap"
	| "config.mcp.catalog.tencentMap"
	| "config.mcp.catalog.rail12306"
	| "config.mcp.catalog.modelscope"
	| "config.mcp.catalog.alipay"
	| "config.mcp.catalog.context7Hint"
	| "config.mcp.catalog.playwrightHint"
	| "config.mcp.catalog.chromeDevtoolsHint"
	| "config.mcp.catalog.githubHint"
	| "config.mcp.catalog.sentryHint"
	| "config.mcp.catalog.supabaseHint"
	| "config.mcp.catalog.linearHint"
	| "config.mcp.catalog.notionHint"
	| "config.mcp.catalog.braveSearchHint"
	| "config.mcp.catalog.firecrawlHint"
	| "config.mcp.catalog.figmaHint"
	| "config.mcp.catalog.larkHint"
	| "config.mcp.catalog.dingtalkHint"
	| "config.mcp.catalog.amapHint"
	| "config.mcp.catalog.tencentMapHint"
	| "config.mcp.catalog.rail12306Hint"
	| "config.mcp.catalog.modelscopeHint"
	| "config.mcp.catalog.alipayHint"
	| "config.mcp.catalog.context7Key"
	| "config.mcp.catalog.githubKey"
	| "config.mcp.catalog.braveSearchKey"
	| "config.mcp.catalog.firecrawlKey"
	| "config.mcp.catalog.larkAppId"
	| "config.mcp.catalog.larkAppSecret"
	| "config.mcp.catalog.dingtalkClientId"
	| "config.mcp.catalog.dingtalkClientSecret"
	| "config.mcp.catalog.amapKey"
	| "config.mcp.catalog.tencentMapKey"
	| "config.mcp.catalog.modelscopeToken"
	| "config.mcp.catalog.alipayAppId"
	| "config.mcp.catalog.alipayAppKey"
	| "config.mcp.catalog.alipayPubKey"
	| "config.mcp.catalog.tavily"
	| "config.mcp.catalog.tavilyHint"
	| "config.mcp.catalog.tavilyKey"
	| "config.mcp.catalog.exa"
	| "config.mcp.catalog.exaHint"
	| "config.mcp.catalog.exaKey"
	| "config.mcp.catalog.tencentDocs"
	| "config.mcp.catalog.tencentDocsHint"
	| "config.mcp.catalog.tencentDocsToken"
	| "config.mcp.catalog.baiduNetdisk"
	| "config.mcp.catalog.baiduNetdiskHint"
	| "config.mcp.catalog.baiduNetdiskToken"
	| "config.mcp.catalog.qcc"
	| "config.mcp.catalog.qccHint"
	| "config.mcp.catalog.qccKey"
	| "config.mcp.catalog.credentialHeaderRaw";

export type McpServiceCatalogEntry = {
	id: string;
	defaultName: string;
	titleKey: McpCatalogTextKey;
	hintKey: McpCatalogTextKey;
	category: McpCatalogCategory;
	/** 纯展示用（命令行或 URL）；真实定义看 base/credentials。 */
	endpointDisplay: string;
	docsUrl: string;
	auth: McpCatalogAuthKind;
	/** 凭据字段列表（无凭据服务不声明）；表单按数组渲染多个输入框。 */
	credentials?: McpCatalogCredentialField[];
	/** 无凭据时的完整定义（凭据由 credentials 声明在保存时注入）。 */
	base: McpServerDefinition;
};

/**
 * 动态客户端注册（DCR）不认 `pi`、必须借用已进白名单客户端名的服务。
 * 2026-10 实测：Figma 的注册端点对 client_name 白名单校验，`pi` 403 / `Claude Code` 200；
 * Sentry、Supabase、Linear、Notion、Context7、Exa 对 `pi` 均正常放行（无需覆盖）。
 * 新增条目若登录报 403 Forbidden 且正文是裸文本，按同一方法（换 client_name 试注册）确认后再登记到这里。
 */
export const MCP_DCR_CLIENT_NAME_OVERRIDES: Readonly<Record<string, string>> = { figma: "Claude Code" };

/**
 * 目录条目 → 落盘定义：OAuth 服务的客户端名覆盖在此统一注入。
 * 覆盖值是 pi 的 `oauth.clientName`（仅动态注册时发送），改回默认名需先 `pi mcp logout`。
 */
export function buildCatalogBase(entry: McpServiceCatalogEntry): McpServerDefinition {
	const clientName = MCP_DCR_CLIENT_NAME_OVERRIDES[entry.id];
	if (!clientName) return entry.base;
	return { ...entry.base, oauth: { ...entry.base.oauth, clientName } };
}

export const MCP_SERVICE_CATALOG: readonly McpServiceCatalogEntry[] = [
	{
		id: "pideck",
		defaultName: "pideck",
		titleKey: "config.mcp.catalog.pideck",
		hintKey: "config.mcp.catalog.pideckHint",
		category: "dev",
		endpointDisplay: "127.0.0.1",
		docsUrl: "https://github.com/ayuayue/PiDeck/blob/main/docs/pideck-mcp.md",
		auth: "header-key",
		// PiDeckMcpPanel obtains the actual endpoint/credential only after explicit host consent.
		base: { enabled: false },
	},
	{
		id: "context7",
		defaultName: "context7",
		titleKey: "config.mcp.catalog.context7",
		hintKey: "config.mcp.catalog.context7Hint",
		category: "dev",
		endpointDisplay: "https://mcp.context7.com/mcp",
		docsUrl: "https://github.com/upstash/context7",
		auth: "header-key",
		credentials: [{ labelKey: "config.mcp.catalog.context7Key", optional: true, credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }],
		base: { url: "https://mcp.context7.com/mcp" },
	},
	{
		id: "modelscope",
		defaultName: "modelscope",
		titleKey: "config.mcp.catalog.modelscope",
		hintKey: "config.mcp.catalog.modelscopeHint",
		category: "dev",
		endpointDisplay: "uvx modelscope-mcp-server",
		docsUrl: "https://github.com/modelscope/modelscope-mcp-server",
		auth: "env-key",
		credentials: [{ labelKey: "config.mcp.catalog.modelscopeToken", credential: { kind: "env", envKey: "MODELSCOPE_API_TOKEN" } }],
		base: { command: "uvx", args: ["modelscope-mcp-server"] },
	},
	{
		id: "playwright",
		defaultName: "playwright",
		titleKey: "config.mcp.catalog.playwright",
		hintKey: "config.mcp.catalog.playwrightHint",
		category: "dev",
		endpointDisplay: "npx @playwright/mcp@latest",
		docsUrl: "https://github.com/microsoft/playwright-mcp",
		auth: "none",
		base: { command: "npx", args: ["@playwright/mcp@latest"] },
	},
	{
		id: "chrome-devtools",
		defaultName: "chrome-devtools",
		titleKey: "config.mcp.catalog.chromeDevtools",
		hintKey: "config.mcp.catalog.chromeDevtoolsHint",
		category: "dev",
		endpointDisplay: "npx -y chrome-devtools-mcp@latest",
		docsUrl: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
		auth: "none",
		base: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
	},
	{
		id: "github",
		defaultName: "github",
		titleKey: "config.mcp.catalog.github",
		hintKey: "config.mcp.catalog.githubHint",
		category: "dev",
		endpointDisplay: "https://api.githubcopilot.com/mcp/",
		docsUrl: "https://github.com/github/github-mcp-server",
		auth: "header-key",
		credentials: [{ labelKey: "config.mcp.catalog.githubKey", credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }],
		base: { url: "https://api.githubcopilot.com/mcp/" },
	},
	{
		id: "sentry",
		defaultName: "sentry",
		titleKey: "config.mcp.catalog.sentry",
		hintKey: "config.mcp.catalog.sentryHint",
		category: "dev",
		endpointDisplay: "https://mcp.sentry.dev/mcp",
		docsUrl: "https://github.com/getsentry/sentry-mcp",
		auth: "oauth",
		base: { url: "https://mcp.sentry.dev/mcp" },
	},
	{
		id: "supabase",
		defaultName: "supabase",
		titleKey: "config.mcp.catalog.supabase",
		hintKey: "config.mcp.catalog.supabaseHint",
		category: "dev",
		endpointDisplay: "https://mcp.supabase.com/mcp",
		docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
		auth: "oauth",
		base: { url: "https://mcp.supabase.com/mcp" },
	},
	{
		id: "linear",
		defaultName: "linear",
		titleKey: "config.mcp.catalog.linear",
		hintKey: "config.mcp.catalog.linearHint",
		category: "work",
		endpointDisplay: "https://mcp.linear.app/mcp",
		docsUrl: "https://linear.app/docs/mcp",
		auth: "oauth",
		base: { url: "https://mcp.linear.app/mcp" },
	},
	{
		id: "notion",
		defaultName: "notion",
		titleKey: "config.mcp.catalog.notion",
		hintKey: "config.mcp.catalog.notionHint",
		category: "work",
		endpointDisplay: "https://mcp.notion.com/mcp",
		docsUrl: "https://developers.notion.com/docs/mcp",
		auth: "oauth",
		base: { url: "https://mcp.notion.com/mcp" },
	},
	{
		id: "lark",
		defaultName: "lark-mcp",
		titleKey: "config.mcp.catalog.lark",
		hintKey: "config.mcp.catalog.larkHint",
		category: "work",
		endpointDisplay: "npx -y @larksuiteoapi/lark-mcp mcp",
		docsUrl: "https://github.com/larksuite/lark-openapi-mcp",
		auth: "multi-key",
		credentials: [
			{ labelKey: "config.mcp.catalog.larkAppId", credential: { kind: "args", flag: "-a" } },
			{ labelKey: "config.mcp.catalog.larkAppSecret", credential: { kind: "args", flag: "-s" } },
		],
		base: { command: "npx", args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"] },
	},
	{
		id: "dingtalk",
		defaultName: "dingtalk-mcp",
		titleKey: "config.mcp.catalog.dingtalk",
		hintKey: "config.mcp.catalog.dingtalkHint",
		category: "work",
		endpointDisplay: "npx -y dingtalk-mcp@latest",
		docsUrl: "https://open.dingtalk.com/document/ai-dev/second-level-node-1",
		auth: "multi-key",
		credentials: [
			{ labelKey: "config.mcp.catalog.dingtalkClientId", credential: { kind: "env", envKey: "DINGTALK_Client_ID" } },
			{ labelKey: "config.mcp.catalog.dingtalkClientSecret", credential: { kind: "env", envKey: "DINGTALK_Client_Secret" } },
		],
		base: { command: "npx", args: ["-y", "dingtalk-mcp@latest"] },
	},
	{
		id: "alipay",
		defaultName: "alipay-mcp",
		titleKey: "config.mcp.catalog.alipay",
		hintKey: "config.mcp.catalog.alipayHint",
		category: "work",
		endpointDisplay: "npx -y @alipay/mcp-server-alipay",
		docsUrl: "https://www.npmjs.com/package/@alipay/mcp-server-alipay",
		auth: "multi-key",
		credentials: [
			{ labelKey: "config.mcp.catalog.alipayAppId", credential: { kind: "env", envKey: "AP_APP_ID" } },
			{ labelKey: "config.mcp.catalog.alipayAppKey", credential: { kind: "env", envKey: "AP_APP_KEY" } },
			{ labelKey: "config.mcp.catalog.alipayPubKey", credential: { kind: "env", envKey: "AP_PUB_KEY" } },
		],
		base: { command: "npx", args: ["-y", "@alipay/mcp-server-alipay"] },
	},
	{
		id: "tencent-docs",
		defaultName: "tencent-docs",
		titleKey: "config.mcp.catalog.tencentDocs",
		hintKey: "config.mcp.catalog.tencentDocsHint",
		category: "work",
		endpointDisplay: "https://docs.qq.com/openapi/mcp",
		docsUrl: "https://docs.qq.com/open/document/mcp/get-token",
		auth: "header-key",
		// 官方配置要求 Authorization 头直接写 token 原文（不能加 Bearer），否则报 400006。
		credentials: [{ labelKey: "config.mcp.catalog.tencentDocsToken", credential: { kind: "header", header: "Authorization" } }],
		base: { url: "https://docs.qq.com/openapi/mcp" },
	},
	{
		id: "baidu-netdisk",
		defaultName: "baidu-netdisk",
		titleKey: "config.mcp.catalog.baiduNetdisk",
		hintKey: "config.mcp.catalog.baiduNetdiskHint",
		category: "work",
		endpointDisplay: "npx -y mcp-remote https://mcp-pan.baidu.com/sse",
		docsUrl: "https://github.com/baidu-netdisk/mcp",
		auth: "env-key",
		// 官方远程端点只有 SSE（pi 只支持 streamable HTTP），因此经 mcp-remote 桥接：
		// 桥接进程先试 streamable HTTP，405 时自动回退 SSE，Authorization 由 --header 传给两条路。
		credentials: [{ labelKey: "config.mcp.catalog.baiduNetdiskToken", credential: { kind: "env", envKey: "BAIDU_NETDISK_ACCESS_TOKEN" } }],
		base: { command: "npx", args: ["-y", "mcp-remote@latest", "https://mcp-pan.baidu.com/sse", "--header", "Authorization: Bearer ${BAIDU_NETDISK_ACCESS_TOKEN}"] },
	},
	{
		id: "amap",
		defaultName: "amap-maps",
		titleKey: "config.mcp.catalog.amap",
		hintKey: "config.mcp.catalog.amapHint",
		category: "maps",
		endpointDisplay: "https://mcp.amap.com/mcp?key=<KEY>",
		docsUrl: "https://lbs.amap.com/api/mcp-server/gettingstarted",
		auth: "url-key",
		credentials: [{ labelKey: "config.mcp.catalog.amapKey", credential: { kind: "url-query", param: "key" } }],
		base: { url: "https://mcp.amap.com/mcp" },
	},
	{
		id: "tencent-map",
		defaultName: "tencent-map",
		titleKey: "config.mcp.catalog.tencentMap",
		hintKey: "config.mcp.catalog.tencentMapHint",
		category: "maps",
		endpointDisplay: "https://mcp.map.qq.com/mcp?key=<KEY>",
		docsUrl: "https://lbs.qq.com/service/MCPServer/MCPServerGuide/userGuide",
		auth: "url-key",
		credentials: [{ labelKey: "config.mcp.catalog.tencentMapKey", credential: { kind: "url-query", param: "key" } }],
		base: { url: "https://mcp.map.qq.com/mcp" },
	},
	{
		id: "rail12306",
		defaultName: "12306-mcp",
		titleKey: "config.mcp.catalog.rail12306",
		hintKey: "config.mcp.catalog.rail12306Hint",
		category: "maps",
		endpointDisplay: "npx -y 12306-mcp",
		docsUrl: "https://github.com/Joooook/12306-mcp",
		auth: "none",
		base: { command: "npx", args: ["-y", "12306-mcp"] },
	},
	{
		id: "baizhi",
		defaultName: "baizhi",
		titleKey: "config.mcp.catalog.baizhi",
		hintKey: "config.mcp.catalog.baizhiHint",
		category: "search",
		endpointDisplay: "https://agent-toolkit.app.baizhi.cloud/mcp",
		docsUrl: "https://agent-toolkit.app.baizhi.cloud/access-guide",
		auth: "header-key",
		credentials: [{ labelKey: "config.mcp.catalog.baizhiKey", credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }],
		base: { url: "https://agent-toolkit.app.baizhi.cloud/mcp" },
	},
	{
		id: "brave-search",
		defaultName: "brave-search",
		titleKey: "config.mcp.catalog.braveSearch",
		hintKey: "config.mcp.catalog.braveSearchHint",
		category: "search",
		endpointDisplay: "npx -y @brave/brave-search-mcp-server --transport stdio",
		docsUrl: "https://github.com/brave/brave-search-mcp-server",
		auth: "env-key",
		credentials: [{ labelKey: "config.mcp.catalog.braveSearchKey", credential: { kind: "env", envKey: "BRAVE_API_KEY" } }],
		base: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"] },
	},
	{
		id: "firecrawl",
		defaultName: "firecrawl",
		titleKey: "config.mcp.catalog.firecrawl",
		hintKey: "config.mcp.catalog.firecrawlHint",
		category: "search",
		endpointDisplay: "https://mcp.firecrawl.dev/mcp",
		docsUrl: "https://docs.firecrawl.dev/mcp-server",
		auth: "header-key",
		credentials: [{ labelKey: "config.mcp.catalog.firecrawlKey", optional: true, credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }],
		base: { url: "https://mcp.firecrawl.dev/mcp" },
	},
	{
		id: "exa",
		defaultName: "exa",
		titleKey: "config.mcp.catalog.exa",
		hintKey: "config.mcp.catalog.exaHint",
		category: "search",
		endpointDisplay: "https://mcp.exa.ai/mcp",
		docsUrl: "https://docs.exa.ai/reference/exa-mcp",
		auth: "header-key",
		// Keyless 也可用（限速）；填 key 走高额度，官方要求裸值写 x-api-key 头。
		credentials: [{ labelKey: "config.mcp.catalog.exaKey", optional: true, credential: { kind: "header", header: "x-api-key" } }],
		base: { url: "https://mcp.exa.ai/mcp" },
	},
	{
		id: "tavily",
		defaultName: "tavily-remote-mcp",
		titleKey: "config.mcp.catalog.tavily",
		hintKey: "config.mcp.catalog.tavilyHint",
		category: "search",
		endpointDisplay: "https://mcp.tavily.com/mcp/?tavilyApiKey=<KEY>",
		docsUrl: "https://docs.tavily.com/documentation/mcp",
		auth: "url-key",
		credentials: [{ labelKey: "config.mcp.catalog.tavilyKey", credential: { kind: "url-query", param: "tavilyApiKey" } }],
		base: { url: "https://mcp.tavily.com/mcp/" },
	},
	{
		id: "figma",
		defaultName: "figma",
		titleKey: "config.mcp.catalog.figma",
		hintKey: "config.mcp.catalog.figmaHint",
		category: "design",
		endpointDisplay: "https://mcp.figma.com/mcp",
		docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation",
		auth: "oauth",
		base: { url: "https://mcp.figma.com/mcp" },
	},
	{
		id: "qcc",
		defaultName: "qcc-company",
		titleKey: "config.mcp.catalog.qcc",
		hintKey: "config.mcp.catalog.qccHint",
		category: "data",
		endpointDisplay: "https://agent.qcc.com/mcp/company/stream",
		docsUrl: "https://agent.qcc.com/guide",
		auth: "header-key",
		credentials: [{ labelKey: "config.mcp.catalog.qccKey", credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }],
		base: { url: "https://agent.qcc.com/mcp/company/stream" },
	},
];

/** 目录声明的认证形态 → 表单行为（见 McpServiceTemplateForm）。 */
export function catalogNeedsCredential(entry: McpServiceCatalogEntry): boolean {
	return (entry.credentials ?? []).some((field) => !field.optional);
}

/** URL 追加 query 参数：已有 query 用 &，否则用 ?（值 encodeURIComponent）。 */
function appendUrlParam(url: string, param: string, value: string): string {
	const encoded = `${encodeURIComponent(param)}=${encodeURIComponent(value)}`;
	return url.includes("?") ? `${url}&${encoded}` : `${url}?${encoded}`;
}

/**
 * 目录条目 + 各凭据输入框的值（与 credentials 同序）→ Pi 原生 McpServerDefinition。
 * 凭据只写入各字段声明的位置（header / env / URL query / args），其余字段原样来自 base。
 * header 默认写 `Bearer <key>`；声明 scheme 缺省的服务（腾讯文档、Exa）写裸值。
 */
export function buildCatalogDefinition(entry: McpServiceCatalogEntry, values: readonly string[]): McpServerDefinition {
	let definition = buildCatalogBase(entry);
	(entry.credentials ?? []).forEach((field, index) => {
		const value = (values[index] ?? "").trim();
		if (!value) return;
		const credential = field.credential;
		if (credential.kind === "header") {
			definition = { ...definition, headers: { ...definition.headers, [credential.header]: credential.scheme ? `${credential.scheme} ${value}` : value } };
		} else if (credential.kind === "env") {
			definition = { ...definition, env: { ...definition.env, [credential.envKey]: value } };
		} else if (credential.kind === "url-query") {
			definition = { ...definition, url: appendUrlParam(definition.url ?? "", credential.param, value) };
		} else {
			definition = { ...definition, args: [...(definition.args ?? []), credential.flag, value] };
		}
	});
	return definition;
}
