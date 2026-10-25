/**
 * 统一接口聚合层 · 契约类型与错误码定义。
 *
 * 本文件是纯契约层（src/shared/api/）：只放类型、常量与错误码，不 import 任何
 * main/preload/renderer 运行时代码（守卫测试 tests/unifiedApiSharedPurity.test.mjs）。
 * 静态数据契约在邻文件：domainCatalog.ts（域清单）、importerCatalog.ts（导入器能力表）、
 * consolidations.ts（sessions/config 收口映射）；运行时组装契约见 facadeTypes.ts。
 */

/** 域分组：统一接口文档（docs/unified-api.md，T8 交付）的章节骨架。 */
export type DomainGroup = "core" | "workspace" | "content" | "config" | "integration" | "shell";

/**
 * 域聚合方式：
 * - aggregate   门面直取：piDeckApi.<domain> === source.<namespace> 恒等（引用透传）。
 * - consolidate 收口映射：门面按方法组分组呈现（sessions 四子域、config 十子库）。
 * - redline     红线：门面不聚合、只透传原命名空间引用，文档标注用途红线
 *                （pi-auth 例外一、模型快照端点/standby 例外二/三宿主 pi 行、enhance 例外四、
 *                DSH 插件体系宿主 dsh 行；AGENTS.md 核心边界四例外 + RESEARCH §4.7）。
 */
export type DomainAggregation = "aggregate" | "consolidate" | "redline";

/** 统一接口成熟度标记：仅类型位，缺省视为 "proposed"（方案确认门开放问题③选 A）。 */
export type DomainApiVersion = "proposed" | "stable";

/** 域清单条目。id 为 kebab-case，域与导入器（importerCatalog.ts）共用同一唯一 id 空间。 */
export interface DomainCatalogEntry {
	readonly id: string;
	readonly group: DomainGroup;
	/** 仅收口域填写：sessions 行固定为 ["catalog","runtime","import","rewind"]。 */
	readonly subdomains?: readonly string[];
	/** 该域核心 Manager 类名（展示用元数据，非运行时引用）。 */
	readonly manager: string;
	/** 注册该域通道的 main 侧文件（src/main/ 内相对路径，多对多）。 */
	readonly ipcFile: readonly string[];
	/** 该域渲染面所在的 preload 命名空间（window.piDesktop.<ns>）；伴生行与宿主行共享命名空间。 */
	readonly preloadNamespaces: readonly string[];
	/** 该域认领的通道域前缀（shared/ipc.ts 通道名 ":" 前缀）；与导入器表并集须覆盖全部 77 前缀。 */
	readonly channelPrefix: readonly string[];
	readonly aggregation: DomainAggregation;
	readonly apiVersion?: DomainApiVersion;
}

/** 导入器能力位（capabilities ⊆ 本枚举；kimi-work 多 describe、directory-sessions 多 listSources）。 */
export type ImporterCapability = "scan" | "import" | "describe" | "listSources";

/** 导入器清单条目：11 个外部会话导入器（scan→选择、import→导入两段式，通道走 sessions:import*）。 */
export interface ImporterCatalogEntry {
	readonly id: string;
	readonly manager: string;
	readonly ipcFile: readonly string[];
	readonly preloadNamespaces: readonly string[];
	readonly channelPrefix: readonly string[];
	readonly capabilities: readonly ImporterCapability[];
}

/** 统一接口注册表错误码（形状 { code, domain?, reason }，见 PiDeckApiRegistryErrorData）。 */
export const PIDECK_API_ERROR_CODES = {
	duplicateDomain: "PIDECK_API_DUPLICATE_DOMAIN",
	registryFrozen: "PIDECK_API_REGISTRY_FROZEN",
	invalidDomainEntry: "PIDECK_API_INVALID_DOMAIN_ENTRY",
} as const;

export type PiDeckApiErrorCode = (typeof PIDECK_API_ERROR_CODES)[keyof typeof PIDECK_API_ERROR_CODES];

/** 注册表错误数据对象（main 侧 PiDeckApiRegistryError 的跨进程投影；不抛裸异常跨 IPC）。 */
export interface PiDeckApiRegistryErrorData {
	readonly code: PiDeckApiErrorCode;
	readonly domain?: string;
	readonly reason: string;
}

/** sessions 域四子域（REVIEW-SPEC：会话是一等公民，按 catalog/runtime/import/rewind 收口）。 */
export type SessionSubdomainId = "catalog" | "runtime" | "import" | "rewind";

/** config 域十子库（ConfigManager 单类无子 Store，按方法语义分组收口，数据在 consolidations.ts）。 */
export type ConfigSubstoreId = "models" | "auth" | "settings" | "mcp" | "trust" | "tokendance" | "usageProbes" | "resources" | "vision" | "maintenance";

/**
 * 域门面句柄：注册进统一接口的 preload 命名空间对象本身（如 source.sessions）。
 * 红线域不进入聚合门面，只在文档层透传该引用。
 */
export type DomainFacadeHandle = Readonly<Record<string, unknown>>;

/** 域门面工厂：注册时只登记不调用；冻结后（registryFrozen）禁止再登记/注销。 */
export type DomainFacadeFactory = () => DomainFacadeHandle;

/** 运行时注册表条目（main 侧 PiDeckApiRegistry 消费；静态清单见 domainCatalog.ts）。 */
export interface DomainRegistrationEntry {
	readonly id: string;
	readonly group: DomainGroup;
	readonly aggregation: DomainAggregation;
	readonly manager: string;
	readonly factory: DomainFacadeFactory;
}

/** resolveDomain(id) 的返回：未注册域返回 undefined、不抛异常（沉默清单 S3 裁决）。 */
export interface ResolvedDomain {
	readonly id: string;
	readonly group: DomainGroup;
	readonly aggregation: DomainAggregation;
	readonly manager: string;
	/** 收口域（consolidate）附方法组描述；聚合域缺省。 */
	readonly methodGroups?: Readonly<Record<string, readonly string[]>>;
}

/** 方法组描述符：sessions 子域 / config 子库共用的「组名 → 方法名列表」形状。 */
export type MethodGroupsDescriptor = Readonly<Record<string, readonly string[]>>;
