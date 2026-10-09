import type { McpServerDefinition } from "../../../shared/types/mcp";

/**
 * 内置 MCP 服务目录（国产服务批次接入方式逐项按官方文档核实，见 docs/mcp-config-form-redesign.md）。
 * 数据层只声明「凭据字段 + 写入位置」，不含密钥值；表单渲染与落盘字段映射都由这里的声明驱动。
 */
export type McpCatalogAuthKind = "none" | "oauth" | "header-key" | "env-key" | "url-key" | "multi-key";

export type McpCatalogCategory = "dev" | "work" | "maps" | "search" | "design";

/** 单个凭据字段的写入位置：HTTP 头 / stdio 环境变量 / URL query 参数 / 命令行参数。 */
export type McpCatalogCredential = { kind: "header"; header: string; scheme: "Bearer" } | { kind: "env"; envKey: string } | { kind: "url-query"; param: string } | { kind: "args"; flag: string };

/** 一个凭据输入框的声明：标签 + 写入位置 + 是否可留空。 */
export type McpCatalogCredentialField = {
	labelKey: McpCatalogTextKey;
	credential: McpCatalogCredential;
	/** 可选凭据（keyless 也可用）：不拦空值，提示语不同。 */
	optional?: boolean;
};

/** 文案 key 窄联合：t() 拿到字面量类型，双语漏加直接 typecheck 红灯。 */
export type McpCatalogTextKey =
	| "config.mcp.catalog.context7"
	| "config.mcp.catalog.playwright"
	| "config.mcp.catalog.chromeDevtools"
	| "config.mcp.catalog.github"
	| "config.mcp.catalog.sentry"
	| "config.mcp.catalog.supabase"
	| "config.mcp.catalog.linear"
	| "config.mcp.catalog.notion"
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
	| "config.mcp.catalog.alipayPubKey";

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

export const MCP_SERVICE_CATALOG: readonly McpServiceCatalogEntry[] = [
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
 */
export function buildCatalogDefinition(entry: McpServiceCatalogEntry, values: readonly string[]): McpServerDefinition {
	let definition = entry.base;
	(entry.credentials ?? []).forEach((field, index) => {
		const value = (values[index] ?? "").trim();
		if (!value) return;
		const credential = field.credential;
		if (credential.kind === "header") {
			definition = { ...definition, headers: { ...definition.headers, [credential.header]: `${credential.scheme} ${value}` } };
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
