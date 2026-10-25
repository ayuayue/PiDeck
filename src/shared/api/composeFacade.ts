/**
 * 统一接口聚合层 · 门面组合函数（composeFacade，模块边界行数预算 ≤150）。
 *
 * composeUnifiedApi 是纯契约层组合函数：按 DOMAIN_CATALOG / SESSIONS_SUBDOMAINS /
 * CONFIG_SUBSTORES / IMPORTER_CATALOG 四张数据表把 preload 源对象重组成统一 API 视图——
 * 聚合域与红线域恒等透传命名空间引用（无包装、无缓存、无重试、无去重，A11），
 * sessions/config 收口域按方法分组表重组，导入器统一挂 importers 键。
 * 数据流（PLAN）：只按目录表映射，绝不枚举源对象键；组合按 preloadNamespaces
 * 映射、不按通道前缀反推；红线域（pi/dsh/pi-auth/enhance）只透传引用不聚合扩展。
 *
 * S3：源上缺失/未知命名空间或分组缺失方法名 → 对应键 undefined 或静默缺席，不 throw；
 * 运行时漂移由数据层测试（F1/F5/F6/F8）拦截。S7：渲染层薄入口在 preload 缺席时经
 * desktopApi 的 unavailable Proxy 抛错，属文档化消费前提（renderer/src/unifiedApi.ts 注释）。
 *
 * 类型说明：视图类型由 facadeTypes 的条件类型从 TSource 推导（调用点实例化后精确）；
 * 实现体按表循环构造，TS 无法表达「循环构造满足条件类型视图」的完备性证明，
 * 故全文件仅在函数返回处有一处断言，键集正确性由 F7/F8 测试锁定。
 */
import { CONFIG_SUBSTORES, SESSIONS_SUBDOMAINS } from "./consolidations";
import { DOMAIN_CATALOG } from "./domainCatalog";
import type { UnifiedApiView } from "./facadeTypes";
import { IMPORTER_CATALOG, IMPORTER_FACADE_METHODS, IMPORTER_NAMESPACES } from "./importerCatalog";

/** 结构化入参形态：preload 源（渲染层传 desktopApi，测试传 fixture）。desktopApi 的
 *  精确类型（PiDesktopApi，preload 侧 typeof api）结构兼容 Record<string, unknown>；
 *  本层不 import preload/main/renderer，各命名空间形状只经 UnifiedApiView 从 TSource 推导。 */
export type UnifiedApiSource = Record<string, unknown>;

/** 源命名空间视图（镜像 facadeTypes 私有 NamespaceOf 语义：缺失/非对象 → undefined）。 */
type SourceNamespace<TSource extends UnifiedApiSource, TKey extends string> = TSource extends {
	[K in TKey]: infer TNamespace;
}
	? TNamespace extends object
		? TNamespace
		: undefined
	: undefined;

/** 目录表透传命名空间：DOMAIN_CATALOG 中 aggregate/redline 行认领的命名空间，减去
 *  收口视图占用的 sessions/config（伴生行 dsh→sessions、web→settings 由视图键承载），
 *  再减去 UnifiedApiView 已含的 23 个视图键。 */
type CatalogPassthroughNamespace = Exclude<Extract<(typeof DOMAIN_CATALOG)[number], { aggregation: "aggregate" | "redline" }>["preloadNamespaces"][number], keyof UnifiedApiView<UnifiedApiSource> | "sessions" | "config">;

/** 组合产物：23 键统一视图（facadeTypes 契约）+ 目录表透传命名空间（红线 pi/piAuth/enhance 等）。 */
export type ComposedUnifiedApi<TSource extends UnifiedApiSource> = UnifiedApiView<TSource> & {
	readonly [TNamespace in CatalogPassthroughNamespace]: SourceNamespace<TSource, TNamespace>;
};

/** unknown 收窄为可读命名空间记录（AGENTS.md：unknown + 收窄，不引入 as）。 */
function isNamespaceRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 按方法名分组表挑方法，引用透传；缺失方法静默缺席（SubPick 运行时形态，S3）。 */
function pickPresentMethods(namespace: Record<string, unknown> | undefined, methods: readonly string[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	if (namespace === undefined) return picked;
	for (const method of methods) {
		if (method in namespace) picked[method] = namespace[method];
	}
	return picked;
}

/** 收口域重组：对源命名空间按分组描述（SESSIONS_SUBDOMAINS/CONFIG_SUBSTORES）逐组建视图。 */
function consolidateGroups(source: UnifiedApiSource, namespaceKey: string, groups: Readonly<Record<string, readonly string[]>>): Record<string, Record<string, unknown>> {
	const rawNamespace: unknown = source[namespaceKey];
	const namespace = isNamespaceRecord(rawNamespace) ? rawNamespace : undefined;
	const view: Record<string, Record<string, unknown>> = {};
	for (const groupId of Object.keys(groups)) {
		view[groupId] = pickPresentMethods(namespace, groups[groupId]);
	}
	return view;
}

/** 导入器重组：IMPORTER_CATALOG 逐行，按 IMPORTER_FACADE_METHODS 从各自命名空间挑方法挂 <id> 键。 */
function consolidateImporters(source: UnifiedApiSource): Record<string, Record<string, unknown>> {
	const view: Record<string, Record<string, unknown>> = {};
	for (const row of IMPORTER_CATALOG) {
		const rawNamespace: unknown = source[IMPORTER_NAMESPACES[row.id]];
		view[row.id] = pickPresentMethods(isNamespaceRecord(rawNamespace) ? rawNamespace : undefined, IMPORTER_FACADE_METHODS[row.id]);
	}
	return view;
}

/**
 * 组合统一 API 视图（纯函数：无缓存/无重试/无去重/无逐方法包装，A11）。
 * 三层装配，数据全部来自目录表：恒等透传层（aggregate/redline 行命名空间引用直取）、
 * 收口层（sessions 四子域/config 十子库分组视图）、导入器层（importers.<catalog id>）。
 */
export function composeUnifiedApi<TSource extends UnifiedApiSource>(source: TSource): ComposedUnifiedApi<TSource> {
	const api: Record<string, unknown> = {};
	for (const row of DOMAIN_CATALOG) {
		if (row.aggregation === "consolidate") continue; // sessions/config 由收口层承载
		for (const namespace of row.preloadNamespaces) {
			api[namespace] = source[namespace];
		}
	}
	api.web = source.settings; // 伴生行：web 视图键 = settings 命名空间（domainCatalog web 行裁决）
	api.sessions = consolidateGroups(source, "sessions", SESSIONS_SUBDOMAINS);
	api.config = consolidateGroups(source, "config", CONFIG_SUBSTORES);
	api.importers = consolidateImporters(source);
	return api as ComposedUnifiedApi<TSource>;
}
