import type { McpServerDefinition } from "../../../shared/types/mcp";

/**
 * 内置 MCP 服务目录（第一版 11 个，接入方式逐项按服务官方文档核实，见 docs/mcp-config-form-redesign.md）。
 * 数据层只声明「认证形态 + 凭据写入位置」，不含密钥值；表单渲染与落盘字段映射都由这里的声明驱动。
 */
export type McpCatalogAuthKind = "none" | "oauth" | "header-key" | "env-key";

export type McpCatalogCategory = "dev" | "work" | "search" | "design";

/** 目录文案 key 窄联合：让 t() 拿到字面量类型，文案缺失时 typecheck 直接报错（双语 key 漏加会红灯）。 */
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
	| "config.mcp.catalog.context7Key"
	| "config.mcp.catalog.githubKey"
	| "config.mcp.catalog.braveSearchKey"
	| "config.mcp.catalog.firecrawlKey";

/** 凭据写入位置：HTTP 头（Authorization: Bearer <key> 或自定义头）或 stdio 环境变量。 */
export type McpCatalogCredential = { kind: "header"; header: string; scheme: "Bearer" } | { kind: "env"; envKey: string };

export type McpServiceCatalogEntry = {
	id: string;
	defaultName: string;
	titleKey: McpCatalogTextKey;
	hintKey: McpCatalogTextKey;
	category: McpCatalogCategory;
	/** 纯展示用（命令行或 URL）；真实定义看 base/credential。 */
	endpointDisplay: string;
	docsUrl: string;
	auth: McpCatalogAuthKind;
	/** header-key/env-key 但 keyless 也可用的服务（Context7 提额、Firecrawl 每日限额）：密钥框可留空。 */
	credentialOptional?: boolean;
	credentialLabelKey?: McpCatalogTextKey;
	/** 无凭据时的完整定义（凭据由 credential 声明在保存时注入）。 */
	base: McpServerDefinition;
	credential?: McpCatalogCredential;
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
		credentialOptional: true,
		credentialLabelKey: "config.mcp.catalog.context7Key",
		base: { url: "https://mcp.context7.com/mcp" },
		credential: { kind: "header", header: "Authorization", scheme: "Bearer" },
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
		credentialLabelKey: "config.mcp.catalog.githubKey",
		base: { url: "https://api.githubcopilot.com/mcp/" },
		credential: { kind: "header", header: "Authorization", scheme: "Bearer" },
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
		id: "brave-search",
		defaultName: "brave-search",
		titleKey: "config.mcp.catalog.braveSearch",
		hintKey: "config.mcp.catalog.braveSearchHint",
		category: "search",
		endpointDisplay: "npx -y @brave/brave-search-mcp-server --transport stdio",
		docsUrl: "https://github.com/brave/brave-search-mcp-server",
		auth: "env-key",
		credentialLabelKey: "config.mcp.catalog.braveSearchKey",
		base: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"] },
		credential: { kind: "env", envKey: "BRAVE_API_KEY" },
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
		credentialOptional: true,
		credentialLabelKey: "config.mcp.catalog.firecrawlKey",
		base: { url: "https://mcp.firecrawl.dev/mcp" },
		credential: { kind: "header", header: "Authorization", scheme: "Bearer" },
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
	return (entry.auth === "header-key" || entry.auth === "env-key") && !entry.credentialOptional;
}

/**
 * 目录条目 + 可选凭据 → Pi 原生 McpServerDefinition。
 * 凭据只写入 entry.credential 声明的位置（header 或 env），其余字段原样来自 base。
 */
export function buildCatalogDefinition(entry: McpServiceCatalogEntry, credential: string): McpServerDefinition {
	const trimmed = credential.trim();
	if (!entry.credential || !trimmed) return entry.base;
	if (entry.credential.kind === "header") {
		return { ...entry.base, headers: { ...entry.base.headers, [entry.credential.header]: `${entry.credential.scheme} ${trimmed}` } };
	}
	return { ...entry.base, env: { ...entry.base.env, [entry.credential.envKey]: trimmed } };
}
