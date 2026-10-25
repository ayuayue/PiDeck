import type { PiExtensionSummary } from "../../../shared/types";

/**
 * 已安装扩展列表的本地搜索（纯渲染层过滤，不经 IPC）。
 *
 * 匹配字段固定为「来源 + 来源短名 + id」三段拼接后的大小写不敏感子串匹配：
 * - source 覆盖 npm:/file:/github: 等完整来源，用户复制来的安装串可直接搜；
 * - 短名仅用于搜索匹配：去掉协议前缀、`.ts` 后缀与首个 `@scope/` 前缀（`npm:@acme/todo-helper` → `todo-helper`）；
 *   与表格展示名（`extensionsTableRows.tsx` 仅去协议、保留 `@scope/`，发现行再剥 `.ts`）刻意不同——
 *   搜索侧比展示侧更宽松是特性而非缺陷：用户未必记得完整 scope，短名命中即可。
 * - id 覆盖 `local:`/`user:`/`project:` 前缀形式，便于按作用域定位条目。
 * 归一化只做 trim + 小写，不做分词与模糊匹配——列表条目量小，
 * 「输入即过滤」的即时性比召回率重要（与商店 tab 的远程搜索语义互不重叠）。
 */

/** 从扩展来源提取简短描述名（原 ExtensionsTab 内联实现的唯一来源，供列表展示与搜索共用）。 */
export function extensionShortName(source: string): string {
	return source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "");
}

/**
 * 参与搜索的最小字段面：已安装扩展行是 `PiExtensionSummary`，
 * 运行时发现行（package/settings 声明）只有 source、没有 id，故 id 设为可选。
 */
type ExtensionSearchEntry = Pick<PiExtensionSummary, "source"> & { id?: PiExtensionSummary["id"] };

/** 单个条目的可搜索文本：三段字段换行拼接，避免跨字段误命中（如 source 尾 + id 头）。 */
export function buildExtensionHaystack(entry: ExtensionSearchEntry): string {
	return [entry.source, extensionShortName(entry.source), entry.id ?? ""].join("\n");
}

/**
 * 按关键字过滤扩展条目。空查询（含纯空白）原样返回入参数组——
 * 调用方据此区分「没有安装任何扩展」与「搜索无匹配」两种空态。
 */
export function filterExtensionsByQuery<T extends ExtensionSearchEntry>(extensions: T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return extensions;
	return extensions.filter((extension) => buildExtensionHaystack(extension).toLowerCase().includes(needle));
}
