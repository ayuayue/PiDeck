/**
 * 第三方「MCP 接管型」扩展识别规则（计划 M5/M5b，主进程与渲染层共用）。
 * 命中的扩展会注册 /mcp 命令、整体顶掉 pi 0.99 内置 MCP：pi 不再读 mcp.json、不连服务器。
 * 规则必须窄（按已知包名），不要用宽泛的 /mcp/ 正则误伤普通扩展；发现新接管型扩展时在此追加。
 * 纯函数、零依赖（node 单测直接加载）。
 */

/** 渲染层 PiExtensionSummary 的最小结构切片（主进程注入时同样满足）。 */
export type ThirdPartyMcpExtensionInput = {
	source?: string;
	id?: string;
	scope?: string;
	enabled?: boolean;
	builtIn?: boolean;
};

export const MCP_PROXY_EXTENSION_RULES: Array<{ id: string; matchSource: RegExp }> = [{ id: "pi-mcp-adapter", matchSource: /pi-mcp-adapter/i }];

/** 单个第三方 MCP 扩展的识别结果（MCP 页横幅 + 会话启动提醒共用）。 */
export type ThirdPartyMcpExtension = {
	/** 扩展 source 原样（如 npm:pi-mcp-adapter）。 */
	source: string;
	scope: string;
	enabled: boolean;
	/** 精确卸载命令：项目作用域补 -l；本地文件扩展为空串（走扩展页删除，UI 给引导文案）。 */
	uninstallCommand: string;
	isLocalFile: boolean;
};

/**
 * 从扩展列表提取接管型 MCP 扩展并生成卸载命令。
 * 不做网络/CLI 调用；列表查询失败时调用方整组降级（不阻塞配置区/启动链路）。
 */
export function detectThirdPartyMcpExtensions(extensions: readonly ThirdPartyMcpExtensionInput[]): ThirdPartyMcpExtension[] {
	const hits: ThirdPartyMcpExtension[] = [];
	for (const ext of extensions) {
		if (ext.builtIn) continue;
		const source = ext.source ?? "";
		if (!source) continue;
		const matched = MCP_PROXY_EXTENSION_RULES.some((rule) => (ext.id ? rule.id === ext.id : false) || rule.matchSource.test(source));
		if (!matched) continue;
		const isLocalFile = !/^(?:npm|file|github|git|https?):/i.test(source);
		hits.push({
			source,
			scope: ext.scope ?? "unknown",
			enabled: ext.enabled !== false,
			isLocalFile,
			uninstallCommand: isLocalFile ? "" : `pi remove ${source}${ext.scope === "project" ? " -l" : ""}`,
		});
	}
	return hits;
}
