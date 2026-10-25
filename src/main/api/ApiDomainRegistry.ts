/**
 * 统一接口聚合层 · main 侧域注册表（ApiDomainRegistry）。
 *
 * 注册式装配（SPEC A5，稳定性约束「扩展点」）：域与导入器共用同一注册表与冻结点，
 * 条目契约/错误码/静态清单全部来自 src/shared/api/（T4 落盘），本文件只做运行时
 * 登记与校验，不 import renderer/preload，不逐方法包装域句柄。
 *
 * 错误语义（沉默清单 S1/S4/S6）：
 * - 装配失败同步 throw（fail-fast，不捕获不降级）；错误对象经 PiDeckApiRegistryError
 *   携带 {code, domain?, reason}，无回滚（S6：已注册条目保留，断言面只看
 *   类型/code/domain/message 四件套）。
 * - 域库与导入器库分开存储、共用唯一 id 空间，跨库同 id 同样判 DUPLICATE（S4）。
 */
import { PIDECK_API_ERROR_CODES, type DomainRegistrationEntry, type DomainGroup, type ImporterCapability, type MethodGroupsDescriptor, type PiDeckApiErrorCode, type PiDeckApiRegistryErrorData, type ResolvedDomain } from "../../shared/api/domainTypes";

/** 导入器注册条目（registerImporter 入参；数据源 src/shared/api/importerCatalog.ts）。 */
export interface ImporterRegistrationEntry {
	readonly id: string;
	readonly preloadNamespace: string;
	readonly channelPrefix: string;
	readonly capabilities: readonly ImporterCapability[];
}

/** resolveImporter(id) 的返回：未注册返回 undefined、不 throw（与 resolveDomain 同语义）。 */
export interface ResolvedImporter {
	readonly id: string;
	readonly preloadNamespace: string;
	readonly channelPrefix: string;
	readonly capabilities: readonly ImporterCapability[];
}

/** 注册表错误：message = reason，code/domain 挂实例（跨 IPC 投影 = PiDeckApiRegistryErrorData）。 */
export class PiDeckApiRegistryError extends Error {
	readonly code: PiDeckApiErrorCode;
	readonly domain: string | undefined;
	readonly reason: string;

	constructor(data: PiDeckApiRegistryErrorData) {
		super(data.reason);
		this.name = "PiDeckApiRegistryError";
		this.code = data.code;
		this.domain = data.domain;
		this.reason = data.reason;
	}
}

/** 域分组枚举（domainTypes.DomainGroup 的运行时判定表）。 */
const DOMAIN_GROUPS: readonly DomainGroup[] = ["core", "workspace", "content", "config", "integration", "shell"];
/** 导入器能力枚举（domainTypes.ImporterCapability 的运行时判定表）。 */
const IMPORTER_CAPABILITIES: readonly ImporterCapability[] = ["scan", "import", "describe", "listSources"];
/** 域/导入器共用 id 形态：kebab-case，长度 ≤64（与 DOMAIN_CATALOG 守卫测试同一正则）。 */
const DOMAIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface StoredDomain {
	readonly entry: DomainRegistrationEntry;
	readonly methodGroups: MethodGroupsDescriptor | undefined;
}

interface StoredImporter {
	readonly entry: ImporterRegistrationEntry;
}

/**
 * 域/导入器运行时注册表。registerDomain/registerImporter 只登记工厂引用不调用
 * （懒实例化，PLAN 接口契约）；freeze() 后任何注册一律拒绝（R8 冻结语义的等价机制：
 * frozen 标志 + 注册入口必抛，Map 内容不再可变）。
 */
export class ApiDomainRegistry {
	private readonly domains = new Map<string, StoredDomain>();
	private readonly importers = new Map<string, StoredImporter>();
	private frozen = false;

	registerDomain(entry: DomainRegistrationEntry, methodGroups?: MethodGroupsDescriptor): void {
		this.assertNotFrozen();
		this.assertIdShape(entry.id);
		if (typeof entry.factory !== "function") {
			throw this.invalidEntry(`factory 必须是 () => DomainFacadeHandle 的函数，收到 ${typeof entry.factory}`);
		}
		if (!DOMAIN_GROUPS.includes(entry.group)) {
			throw this.invalidEntry(`group 必须是 DomainGroup 六枚举之一，收到 ${String(entry.group)}`);
		}
		this.assertIdAvailable(entry.id);
		this.domains.set(entry.id, Object.freeze({ entry, methodGroups }));
	}

	registerImporter(entry: ImporterRegistrationEntry): void {
		this.assertNotFrozen();
		this.assertIdShape(entry.id);
		if (typeof entry.preloadNamespace !== "string" || entry.preloadNamespace.length === 0) {
			throw this.invalidEntry(`preloadNamespace 必须是非空 string，收到 ${typeof entry.preloadNamespace}`);
		}
		if (typeof entry.channelPrefix !== "string" || entry.channelPrefix.length === 0) {
			throw this.invalidEntry(`channelPrefix 必须是非空 string，收到 ${typeof entry.channelPrefix}`);
		}
		if (!Array.isArray(entry.capabilities) || entry.capabilities.some((capability) => !IMPORTER_CAPABILITIES.includes(capability))) {
			throw this.invalidEntry(`capabilities 每项必须是 ImporterCapability 枚举值（scan/import/describe/listSources）`);
		}
		this.assertIdAvailable(entry.id);
		this.importers.set(entry.id, Object.freeze({ entry }));
	}

	/** 解析已注册域；未注册 id 返回 undefined、不 throw（S3 裁决，A5 消费面）。 */
	resolveDomain(id: string): ResolvedDomain | undefined {
		const stored = this.domains.get(id);
		if (!stored) {
			return undefined;
		}
		const resolved: ResolvedDomain =
			stored.methodGroups === undefined
				? { id: stored.entry.id, group: stored.entry.group, aggregation: stored.entry.aggregation, manager: stored.entry.manager }
				: {
						id: stored.entry.id,
						group: stored.entry.group,
						aggregation: stored.entry.aggregation,
						manager: stored.entry.manager,
						methodGroups: stored.methodGroups,
					};
		return Object.freeze(resolved);
	}

	/** 解析已注册导入器；未注册 id 返回 undefined、不 throw。 */
	resolveImporter(id: string): ResolvedImporter | undefined {
		const stored = this.importers.get(id);
		if (!stored) {
			return undefined;
		}
		return Object.freeze({ ...stored.entry });
	}

	isFrozen(): boolean {
		return this.frozen;
	}

	/** 冻结注册表：此后任何 registerDomain/registerImporter 一律抛 PIDECK_API_REGISTRY_FROZEN。 */
	freeze(): void {
		this.frozen = true;
	}

	private assertNotFrozen(): void {
		if (this.frozen) {
			throw new PiDeckApiRegistryError({
				code: PIDECK_API_ERROR_CODES.registryFrozen,
				reason: "注册表已冻结，禁止再注册（freeze 之后的 registerDomain/registerImporter 调用）",
			});
		}
	}

	private assertIdShape(id: string): void {
		if (typeof id !== "string" || id.length === 0) {
			throw this.invalidEntry(`id 必须是非空 string，收到 ${typeof id}`);
		}
		if (!DOMAIN_ID_PATTERN.test(id)) {
			throw this.invalidEntry(`id 必须是 kebab-case（小写字母/数字/连字符，长度 ≤64），收到 "${id}"`);
		}
	}

	private assertIdAvailable(id: string): void {
		if (this.domains.has(id) || this.importers.has(id)) {
			throw new PiDeckApiRegistryError({
				code: PIDECK_API_ERROR_CODES.duplicateDomain,
				domain: id,
				reason: `id "${id}" 已被注册（域与导入器共用唯一 id 空间）`,
			});
		}
	}

	private invalidEntry(reason: string): PiDeckApiRegistryError {
		return new PiDeckApiRegistryError({ code: PIDECK_API_ERROR_CODES.invalidDomainEntry, reason });
	}
}
