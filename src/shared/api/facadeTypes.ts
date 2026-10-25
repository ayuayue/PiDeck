/**
 * 统一接口聚合层 · 门面类型契约（facadeTypes）。
 *
 * 定义「统一 API 视图」的形状：给定 preload 源对象类型 TSource（window.piDesktop 的类型），
 * 推导 piDeckApi 的各域视图。规则：
 * - 聚合域（aggregate）：视图键直取源命名空间（piDeckApi.git === source.git 恒等）；
 *   源上缺失该命名空间时视图类型为 undefined（S3：缺席不 throw）。
 * - 收口域（consolidate）：sessions 按四子域 Pick 视图、config 按十子库 Pick 视图；
 *   组内缺失的方法静默缺席（SubPick 只保留源上真实存在的键）。
 * - 红线域（redline）：不进视图（pi/pi-auth/dsh/enhance 只透传原命名空间引用，见 domainCatalog）。
 * - 导入器：统一挂 importers 键，键名用 IMPORTER_CATALOG 的 id，值取各自命名空间的 scan/import 面。
 *
 * 运行时组装（composeFacade）属 T5/T7 交付，本文件只落类型。
 */
import type { CONFIG_SUBSTORES, SESSIONS_SUBDOMAINS } from "./consolidations";
import type { IMPORTER_FACADE_METHODS, IMPORTER_NAMESPACES } from "./importerCatalog";

/** 从 TSource 中挑出方法名列表 TMethods 里真实存在的键（缺失键静默缺席，S3）。 */
type SubPick<TSource, TMethods extends readonly string[]> = TSource extends object ? Pick<TSource, Extract<TMethods[number], keyof TSource>> : Record<string, never>;

/** 取 TSource 上的命名空间键类型；缺失或非对象时为 undefined（S3：缺席不 throw）。 */
type NamespaceOf<TSource, TKey extends string> = TSource extends { [K in TKey]: infer TNamespace } ? (TNamespace extends object ? TNamespace : undefined) : undefined;

/** sessions 域收口视图：四子域各自 Pick（方法全集见 consolidations.ts，107 方法四组分桶）。 */
export type SessionsDomainView<TSessions> = {
	catalog: SubPick<TSessions, typeof SESSIONS_SUBDOMAINS.catalog>;
	runtime: SubPick<TSessions, typeof SESSIONS_SUBDOMAINS.runtime>;
	import: SubPick<TSessions, typeof SESSIONS_SUBDOMAINS.import>;
	rewind: SubPick<TSessions, typeof SESSIONS_SUBDOMAINS.rewind>;
};

/** config 域收口视图：十子库各自 Pick（47 方法十组分桶，configBackups 7 方法在独立行不在本视图）。 */
export type ConfigDomainView<TConfig> = {
	models: SubPick<TConfig, typeof CONFIG_SUBSTORES.models>;
	auth: SubPick<TConfig, typeof CONFIG_SUBSTORES.auth>;
	settings: SubPick<TConfig, typeof CONFIG_SUBSTORES.settings>;
	mcp: SubPick<TConfig, typeof CONFIG_SUBSTORES.mcp>;
	trust: SubPick<TConfig, typeof CONFIG_SUBSTORES.trust>;
	tokendance: SubPick<TConfig, typeof CONFIG_SUBSTORES.tokendance>;
	usageProbes: SubPick<TConfig, typeof CONFIG_SUBSTORES.usageProbes>;
	resources: SubPick<TConfig, typeof CONFIG_SUBSTORES.resources>;
	vision: SubPick<TConfig, typeof CONFIG_SUBSTORES.vision>;
	maintenance: SubPick<TConfig, typeof CONFIG_SUBSTORES.maintenance>;
};

/** 导入器视图：键 = IMPORTER_CATALOG id，值 = 各命名空间按 IMPORTER_FACADE_METHODS 的 Pick。 */
export type ImporterViews<TSource> = {
	readonly [TImporter in keyof typeof IMPORTER_FACADE_METHODS]: SubPick<NamespaceOf<TSource, (typeof IMPORTER_NAMESPACES)[TImporter]>, (typeof IMPORTER_FACADE_METHODS)[TImporter]>;
};

/**
 * 统一 API 视图（SPEC A2 门面覆盖 20+ 域 + 两个收口域 + 导入器组）。
 * 分组缺失方法 → 视图键缺席/undefined，不 throw；恒等直取域由 composeFacade 保证引用相等。
 */
export type UnifiedApiView<TSource> = {
	projects: NamespaceOf<TSource, "projects">;
	git: NamespaceOf<TSource, "git">;
	terminal: NamespaceOf<TSource, "terminal">;
	prompts: NamespaceOf<TSource, "prompts">;
	skills: NamespaceOf<TSource, "skills">;
	extensions: NamespaceOf<TSource, "extensions">;
	settings: NamespaceOf<TSource, "settings">;
	feishu: NamespaceOf<TSource, "feishu">;
	pet: NamespaceOf<TSource, "pet">;
	sounds: NamespaceOf<TSource, "sounds">;
	announcements: NamespaceOf<TSource, "announcements">;
	automation: NamespaceOf<TSource, "automation">;
	usageStats: NamespaceOf<TSource, "usageStats">;
	imagegen: NamespaceOf<TSource, "imagegen">;
	voiceTranscription: NamespaceOf<TSource, "voiceTranscription">;
	scratchPad: NamespaceOf<TSource, "scratchPad">;
	cua: NamespaceOf<TSource, "cua">;
	security: NamespaceOf<TSource, "security">;
	web: NamespaceOf<TSource, "settings">;
	dataEnv: NamespaceOf<TSource, "dataEnv">;
	sessions: SessionsDomainView<NamespaceOf<TSource, "sessions">>;
	config: ConfigDomainView<NamespaceOf<TSource, "config">>;
	importers: TSource extends object ? ImporterViews<TSource> : undefined;
};
