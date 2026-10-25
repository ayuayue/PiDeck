import type { TranslationKey } from "../i18n";

/**
 * DSH 插件配置命名空间分类（G13 动态插件区）。
 *
 * 依据 dsh-settings 契约：settings namespace 即插件短名（"lowercase kebab-case,
 * as in plugin short names"）——DSH host 是 cordis 插件组合，不存在独立于插件的
 * 「宿主设置」。因此除 PiDeck 独占管理的保留命名空间外，host 注册的其余命名空间
 * 都属于插件配置区：不再硬编码 3 分区，host 新增插件（如未来的 mcp-client）注册
 * 配置命名空间后，「插件」tab 自动出现该分区。
 */
export const RESERVED_DSH_NAMESPACES: ReadonlySet<string> = new Set([
	"llm-deepseek", // 「模型」tab（DeepseekRouteCard 独占）
	"llm-pi-ai", // 「模型」tab（PiAiProvidersCard 独占）
	"permission", // 「安全」tab（SecurityTab 独占）
	"agent-preset-registry", // 「预设设置」tab（PresetsTab 独占）
]);

/** 已知插件命名空间 → 标题文案 key；未收录的新插件回退显示 ns 原名。 */
export const KNOWN_PLUGIN_NAMESPACE_TITLES: Readonly<Record<string, TranslationKey>> = {
	"agent-loop": "config.dsh.pluginAgentLoop",
	shell: "config.dsh.pluginShell",
	"web-search-deepseek": "config.dsh.pluginWebSearch",
};

/** 已知插件命名空间 → 描述文案 key（对齐 dsh-web 插件卡片描述行）；未收录的新插件不显示描述。 */
export const KNOWN_PLUGIN_NAMESPACE_DESCRIPTIONS: Readonly<Record<string, TranslationKey>> = {
	"agent-loop": "config.dsh.pluginAgentLoopDesc",
	shell: "config.dsh.pluginShellDesc",
	"web-search-deepseek": "config.dsh.pluginWebSearchDesc",
};

/** 是否为插件配置命名空间（G13：插件区动态发现）。 */
export function isDshPluginNamespace(ns: string): boolean {
	return !RESERVED_DSH_NAMESPACES.has(ns);
}

/** 插件命名空间的 i18n 标题 key；未收录的新插件返回 undefined（组件回退显示 ns 原名）。 */
export function dshPluginNamespaceTitleKey(ns: string): TranslationKey | undefined {
	return KNOWN_PLUGIN_NAMESPACE_TITLES[ns];
}

/** 插件命名空间的 i18n 描述 key；未收录的新插件返回 undefined（卡片不显示描述行）。 */
export function dshPluginNamespaceDescriptionKey(ns: string): TranslationKey | undefined {
	return KNOWN_PLUGIN_NAMESPACE_DESCRIPTIONS[ns];
}
