/**
 * 统一接口聚合层 · main 侧注册装配（registerAllDomains）。
 *
 * 装配语义（PLAN 接口契约 + SPEC 边界 Case）：
 * - registerAllDomains() 在 main/index.ts 的 registerIpc() 之后一行调用（不传参）；
 *   按 DOMAIN_CATALOG 逐条 registerDomain、IMPORTER_CATALOG 逐条 registerImporter，
 *   最后 freeze。装配期只登记工厂引用不调用（懒实例化，不改启动时序）。
 * - 装配失败同步 throw 中断启动（S1 fail-fast：不吞、不降级、无回滚 S6），
 *   appLogger 可用时留痕后原样上抛。
 *
 * FIND-5 裁定落法：DomainAssemblyDeps 形状在本文件定义并导出，main/index.ts 不现场
 * 构造。本仓库无统一服务容器，各 Manager 实例由 main/index.ts 闭包持有、不可静态
 * import，因此缺省 deps（buildDefaultAssemblyDeps）为每行目录数据生成「元数据句柄
 * 工厂」；需要活 Manager 引用的消费方显式传 deps 覆盖（键命中即原样透传注册表校验，
 * 非函数工厂由注册表抛 PIDECK_API_INVALID_DOMAIN_ENTRY）。
 */
import { ApiDomainRegistry } from "./ApiDomainRegistry";
import { getAppLogger } from "../logging/sharedLogger";
import { CONFIG_SUBSTORES, SESSIONS_SUBDOMAINS } from "../../shared/api/consolidations";
import { DOMAIN_CATALOG } from "../../shared/api/domainCatalog";
import { IMPORTER_CATALOG } from "../../shared/api/importerCatalog";
import type { DomainCatalogEntry, DomainFacadeFactory, DomainFacadeHandle, MethodGroupsDescriptor } from "../../shared/api/domainTypes";

/**
 * 装配依赖（FIND-5）：域 id → 域门面工厂。显式提供的键原样透传 registerDomain；
 * 未列出的域回落缺省目录句柄工厂。导入器注册条目只含能力元数据
 * （ImporterRegistrationEntry），不设工厂位，故本接口无 importer 字段。
 */
export interface DomainAssemblyDeps {
	readonly domainHandles: Readonly<Record<string, DomainFacadeFactory>>;
}

/** 装配目标注册表（模块级单例：freeze 后供治理/诊断消费方 resolve，不再变更）。 */
export const unifiedApiRegistry = new ApiDomainRegistry();

/** 收口域（aggregation === "consolidate"）的方法组映射来源（T4 落盘，F4-5 断言 ≡ 此数据）。 */
const CONSOLIDATION_METHOD_GROUPS: Readonly<Record<string, MethodGroupsDescriptor>> = {
	sessions: SESSIONS_SUBDOMAINS,
	config: CONFIG_SUBSTORES,
};

/** 缺省域句柄：该域目录行元数据的冻结快照（Manager 类名 + 认领映射）。 */
function catalogHandleFactory(row: DomainCatalogEntry): DomainFacadeFactory {
	const handle: DomainFacadeHandle = Object.freeze({
		domain: row.id,
		manager: row.manager,
		ipcFile: row.ipcFile,
		preloadNamespaces: row.preloadNamespaces,
		channelPrefix: row.channelPrefix,
	});
	return () => handle;
}

/** 缺省 deps：为 DOMAIN_CATALOG 每行生成目录句柄工厂（不触碰任何 Manager 实例）。 */
export function buildDefaultAssemblyDeps(): DomainAssemblyDeps {
	const domainHandles: Record<string, DomainFacadeFactory> = {};
	for (const row of DOMAIN_CATALOG) {
		domainHandles[row.id] = catalogHandleFactory(row);
	}
	return { domainHandles };
}

/** 收口域必须有方法组映射；清单与映射漂移时 fail-fast（目录守卫测试外的兜底，S1）。 */
function requireConsolidationGroups(domainId: string): MethodGroupsDescriptor {
	const methodGroups = CONSOLIDATION_METHOD_GROUPS[domainId];
	if (methodGroups === undefined) {
		throw new Error(`consolidate 域 "${domainId}" 缺少方法组映射（src/shared/api/consolidations.ts）`);
	}
	return methodGroups;
}

function assembleRegistry(deps: DomainAssemblyDeps): void {
	for (const row of DOMAIN_CATALOG) {
		const factory = deps.domainHandles[row.id] ?? catalogHandleFactory(row);
		const methodGroups = row.aggregation === "consolidate" ? requireConsolidationGroups(row.id) : undefined;
		unifiedApiRegistry.registerDomain({ id: row.id, group: row.group, aggregation: row.aggregation, manager: row.manager, factory }, methodGroups);
	}
	for (const row of IMPORTER_CATALOG) {
		unifiedApiRegistry.registerImporter({
			id: row.id,
			preloadNamespace: row.preloadNamespaces[0],
			channelPrefix: row.channelPrefix[0],
			capabilities: row.capabilities,
		});
	}
	unifiedApiRegistry.freeze();
}

/**
 * 全量注册域与导入器并冻结。main/index.ts 装配段一行调用（不传参，走缺省 deps）；
 * 测试与显式注入活 Manager 引用的消费方传 deps。
 */
export function registerAllDomains(deps: DomainAssemblyDeps = buildDefaultAssemblyDeps()): void {
	try {
		assembleRegistry(deps);
	} catch (error) {
		// S1：不吞不降级；启动早期/测试环境 getAppLogger() 为 null 时静默跳过留痕。
		getAppLogger()?.error("api-domain-registry", "registerAllDomains 装配失败", error);
		throw error;
	}
}
