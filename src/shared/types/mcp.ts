/**
 * mcp.json 配置契约（只描述文件形状，不复刻 pi 的 MCP 运行时）。
 * pi 0.99 起 MCP 由内置扩展提供，读取 `~/.pi/agent/mcp.json`；已信任项目的
 * `<project>/.pi/mcp.json` 同名定义**整体替换**全局定义（不是字段级浅合并）。
 * 仅描述 pi 0.99.2 内置 MCP 认识的字段（dist/core/mcp-servers.js 的
 * validateMcpServerConfig）；pi-mcp-adapter 时代的 legacy 字段（lifecycle/
 * directTools 等）已移除——pi 对未知字段静默忽略，写入无意义。未知字段经
 * index signature 原样 round-trip，保存时不丢。
 */

/** stdio / streamable HTTP 二选一（pi 0.99 不支持 socket，SSE 被拒绝）。 */
export type McpServerTransport = "stdio" | "http";

/**
 * pi 0.99.2 内置 MCP 的工具暴露方式（exposure 取值）：
 * - codemode：仅 codemode 脚本可调用（默认）；0.99.2 起不进工具描述，
 *   由系统的 mcp_servers 提示词段告知存在，脚本用 searchTools/describeNamespace 发现
 * - deferred：模型经 tool_search 加载后直接调用
 * - direct：像普通工具一样直接声明给模型（首轮会等待这类服务器连接）
 * - hidden：注册但模型不可见（仅手动/调试用途）
 * `codemode-deferred` 是 pi 在 0.99.2 保留的兼容别名，归一后等于 `codemode`；
 * 旧文件可读，但新建表单只提供四个 canonical 值。
 */
export type McpExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

/** HTTP server 的 OAuth 预注册客户端（不写时 pi 用动态客户端注册）。 */
export type McpOAuth = {
	clientId?: string;
	/** 支持 ${ENV} 与 !command 形式（整值替换），与 headers 同规则。 */
	clientSecret?: string;
	/** 固定环回回调端口（1-65535）；缺省 pi 监听空闲端口。 */
	callbackPort?: number;
	/** 自定义环回回调地址（http://localhost|127.0.0.1|[::1]，无 query/fragment）。 */
	callbackUrl?: string;
	/** 空格分隔的 scope 列表；缺省用服务器宣告的 scopes。 */
	scope?: string;
	/** 动态客户端注册时发送的 client_name（默认 "pi"）；改名需先登出再注册。 */
	clientName?: string;
	/**
	 * 授权服务器元数据文档地址（pi 1.0）：服务器的 OAuth 发现宣告错误或缺失时，
	 * 用它替代自动发现。必须是 https（或环回 http）。
	 */
	authServerMetadataUrl?: string;
	/**
	 * 客户端注册方式（pi 1.0.1）：`dcr` 动态注册（默认）/ `cimd` 用 pi.dev 的
	 * Client ID Metadata Document 标识客户端。cimd 不能与 clientId/clientName 组合，
	 * 且回调地址必须是 localhost/127.0.0.1 上的 /callback。
	 */
	clientRegistration?: "dcr" | "cimd";
	[key: string]: unknown;
};

/**
 * 单条 MCP server 定义：pi 0.99.2 内置 MCP schema
 * （command+args+env+cwd 或 url+headers+oauth+auth，加 exposure/toolExposure/enabled/timeout/description）。
 * `auth.provider` 是 0.99.2 新增的“用供应商 /login token 作 bearer”模式，
 * 仅允许写在全局 mcp.json（项目层含它会被 pi 跳过），且要求 https（环回允许 http）。
 */
export type McpServerDefinition = {
	/** 整个 server 的默认工具暴露方式（默认 codemode）。 */
	exposure?: McpExposure;
	/** 按工具名/`*` 模式覆盖暴露方式；精确名优先于模式，对象顺序取首个匹配。键是 server 原始工具名。 */
	toolExposure?: Record<string, McpExposure>;
	/** false = 保留条目但不连接（默认 true；pi 语义：启用时应删除该键，这里允许 true 仅作 round-trip）。 */
	enabled?: boolean;
	/** 单次工具调用超时（秒），默认 60；进度通知会重置计时。 */
	timeout?: number;
	/** 服务一句话描述：出现在系统提示词 mcp_servers 段，并参与 tool_search 排序。 */
	description?: string;
	// ---- 传输定义 ----
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: McpOAuth;
	/** 仅全局：用 pi 供应商的当前 /login token 做 bearer（逐请求读取）。 */
	auth?: { provider?: string; [key: string]: unknown };
	[key: string]: unknown;
};

export type McpConfigFile = {
	mcpServers?: Record<string, McpServerDefinition>;
	/** 顶层开关（默认 true）：MCP 以默认 exposure 连接时是否自动激活 codemode 工具。 */
	autoEnableCodemode?: boolean;
	[key: string]: unknown;
};

export type McpConfigLayerKind = "pi-agent" | "project-pi";

/**
 * MCP 配置读写作用域：全局页写 agentDir/mcp.json；项目页写所选项目 .pi/mcp.json。
 * 渲染层只传注册过的 projectId，不传路径；主进程侧还有信任门禁。
 */
export type McpConfigScope = { scope: "global" } | { scope: "project"; projectId: string };

export type McpConfigLayer = {
	kind: McpConfigLayerKind;
	path: string;
	exists: boolean;
	writable: boolean;
};

/** 服务器名归一后的命名空间冲突（pi 会拒绝第二个）。 */
export function mcpNamespaceKey(name: string): string {
	return name.replace(/-/g, "_");
}

export type McpServerListItem = {
	name: string;
	definition: McpServerDefinition;
	/** 实际提供该有效定义的层路径（项目同名定义整体替换全局）。 */
	originPath: string;
	/** originPath 所在层的作用域。 */
	originScope: McpConfigLayerKind;
	/** 定义层是否为 PiDeck 可写层（当前作用域）。 */
	ownedByWritable: boolean;
	/** 草稿已从本层删除、保存后才生效（磁盘上仍在）。 */
	pendingDelete?: boolean;
	/** 草稿删除的是本层覆盖，且下层（如全局）还有同名定义：保存后回退为继承而不是消失。 */
	revertsToInherited?: boolean;
};

export type McpConfigSnapshot = {
	/** 当前作用域可写文件路径（全局 agentDir/mcp.json 或项目 .pi/mcp.json）。 */
	writablePath: string;
	writableFile: McpConfigFile;
	/** 可写层原文，源文件页编辑 mcp.json 用；文件不存在时为空对象格式化文本。 */
	writableRaw: string;
	/** 可写层 JSON 损坏时给出诊断；此时禁止可视化保存，避免空对象覆盖原文件。 */
	writableError?: string;
	/** 可写层内容哈希（revisionOf）：保存时回传作乐观锁，不匹配 = 文件被外部改过，拒绝覆盖。 */
	revision: string;
	layers: McpConfigLayer[];
	servers: McpServerListItem[];
	/** 未通过校验的条目（不参与有效列表，但必须展示给用户修复）。 */
	invalidServers: Array<{ name: string; path: string; error: string; raw: unknown }>;
	/** 可写层以下各层（如全局）定义过的 server 名：删除本层覆盖时用于判断「回退为继承」还是「消失」。 */
	lowerLayerNames: string[];
	/** mcp-auth.json 里已存 OAuth 凭据的 server 名（只读键名，凭据值永不进内存/日志）。 */
	oauthCredentialNames: string[];
};

export type McpProbeOk = {
	ok: true;
	transport: McpServerTransport;
	detail: string;
};

export type McpProbeFail = {
	ok: false;
	transport?: McpServerTransport;
	error: string;
};

export type McpProbeResult = McpProbeOk | McpProbeFail;

// ── `pi mcp list --json` 报告（真实连接检测，见 piMcpCli.ts）──

/** 单台 server 的连接状态报告（pi 0.99 mcp list 输出形状的收窄）。 */
export type McpCliServerReport = {
	name: string;
	scope: string;
	source: string;
	enabled: boolean;
	exposure: string;
	transport: string;
	/** connected | needs-auth | disconnected | disabled（未识别状态原样透出）。 */
	state: string;
	tools: string[];
	toolExposure?: Record<string, string>;
	/** pi 1.1 输出资源数量（number）；pi 1.2 起只输出「是否提供资源」（`true`）。 */
	resources?: number | boolean;
	/** pi 1.1 的资源模板数量；pi 1.2 起不再输出该字段。 */
	resourceTemplates?: number;
	error?: string;
};

export type McpCliListResult = {
	servers: McpCliServerReport[];
	/** 配置层错误（非法条目被 pi 跳过时在此报告）。 */
	errors: string[];
	/** 项目未信任时的提示（pi note 字段）。 */
	note?: string;
};
