/**
 * 用量查询配置（声明式，纯数据，无代码）。
 *
 * 文件位置：~/.pi/agent/usage-probes.json（与 models.json 同目录，AI/用户可直接读写）。
 * 顶层结构：
 * - providers：按 provider 名的用量查询配置（UI 唯一写入方，见 UsageProbeProviderConfig）；
 * - probes：旧全局探针数组（AI/高级用户直接写，运行时按 baseUrl 合并探测，只读兼容）。
 *
 * 为什么是声明式 JSON 而不是脚本：
 * - 用量查询跑在 PiDeck 主进程（net.fetch + 密钥脱敏），不存在任意代码执行风险；
 * - JSON 文件与 pi CLI 完全隔离，不影响用户在终端里用 pi；
 * - 配置入口唯一：模型/认证页的用量查询弹窗（经 config:get/save-usage-probes）。
 *
 * 加载每次读盘：用量查询本身低频，换取「用户/AI 改完立刻生效」。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	UsageProbeBoosterConfig,
	UsageProbeConfig,
	UsageProbeParseConfig,
	UsageProbeProviderConfig,
	UsageProbeWindowConfig,
} from "../../shared/types/providerUsage";
import type { UsageProbeCandidate } from "./providerUsageProbe";
import { USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID } from "./usageProbeTemplates";

/** 旧探针（shared 契约别名）。历史代码以 UserUsageProbe 引用，与跨进程 UsageProbeConfig 同构。 */
export type UserUsageProbe = UsageProbeConfig;

export type UserUsageProbeLoadResult = {
	/** 校验通过的旧探针（转成内部候选结构）。 */
	candidates: UsageProbeCandidate[];
	/** 校验失败条目的人话描述（供日志/配置页，不含 key）。 */
	errors: string[];
};

/** 单 provider 用量查询配置的读取结果。 */
export type UsageProbeSettingsLoadResult = {
	/** 已保存的配置；未配置过 = undefined。 */
	config?: UsageProbeProviderConfig;
	/** provider 映射解析错误（非法条目被跳过）+ 旧 probes 数组错误。 */
	errors: string[];
};

/** 文件名（放在 pi 全局配置目录下）。 */
export const USER_USAGE_PROBES_FILE = "usage-probes.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
};

/** 可选字符串字段：非空字符串则 trim 返回，否则 undefined。 */
const optionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
};

/** 可选字符串路径字段：与 optionalString 同义（保留语义命名，供路径类字段使用）。 */
const optionalPath = optionalString;

// ── 旧 probes 数组（读取兼容） ─────────────────────────────────────────

/** 校验并转换单条 windows 条目。返回 undefined 表示非法（调用方跳过该窗口）。 */
function normalizeWindow(input: unknown): UsageProbeWindowConfig | undefined {
	if (!isRecord(input)) return undefined;
	const key = optionalPath(input.key);
	const totalPath = optionalPath(input.totalPath);
	const usedPath = optionalPath(input.usedPath);
	const remainingPath = optionalPath(input.remainingPath);
	if (!key || !totalPath || !usedPath) return undefined;
	// 数组遍历形态：listPath + where（AND 匹配）。eq 限定 JSON 基本类型——
	// 对象/数组经 JSON.parse 后是不同引用，严格等号永远不成立，放行只会造成「永远匹配不上」的困惑。
	if (typeof input.listPath === "string" && input.listPath.trim() !== "") {
		const where: { path: string; eq: unknown }[] = [];
		if (Array.isArray(input.where)) {
			for (const cond of input.where) {
				if (!isRecord(cond)) continue;
				const path = optionalPath(cond.path);
				const eq = cond.eq;
				if (!path) continue;
				if (eq === null) where.push({ path, eq: null });
				else if (typeof eq === "string" || typeof eq === "number" || typeof eq === "boolean") {
					where.push({ path, eq });
				}
			}
		}
		if (where.length === 0) return undefined;
		return {
			key,
			listPath: input.listPath.trim(),
			where,
			totalPath,
			usedPath,
			...(remainingPath ? { remainingPath } : {}),
		};
	}
	return { key, totalPath, usedPath, ...(remainingPath ? { remainingPath } : {}) };
}

/** 校验并转换单条 booster 规格。返回 undefined 表示非法（booster 整块省略）。 */
function normalizeBooster(input: unknown): UsageProbeBoosterConfig | undefined {
	if (!isRecord(input)) return undefined;
	const balancePath = optionalPath(input.balancePath);
	if (!balancePath) return undefined;
	const fixedPointRaw = input.fixedPointPerCent;
	const fixedPointPerCent =
		typeof fixedPointRaw === "number" && Number.isFinite(fixedPointRaw) && fixedPointRaw > 0
			? fixedPointRaw
			: undefined;
	return {
		balancePath,
		...(optionalPath(input.totalPath) ? { totalPath: optionalPath(input.totalPath) } : {}),
		...(optionalPath(input.currencyPath) ? { currencyPath: optionalPath(input.currencyPath) } : {}),
		...(optionalPath(input.monthlyUsedCentsPath)
			? { monthlyUsedCentsPath: optionalPath(input.monthlyUsedCentsPath) }
			: {}),
		...(optionalPath(input.monthlyChargeLimitCentsPath)
			? { monthlyChargeLimitCentsPath: optionalPath(input.monthlyChargeLimitCentsPath) }
			: {}),
		...(optionalPath(input.monthlyChargeLimitEnabledPath)
			? { monthlyChargeLimitEnabledPath: optionalPath(input.monthlyChargeLimitEnabledPath) }
			: {}),
		...(fixedPointPerCent !== undefined ? { fixedPointPerCent } : {}),
	};
}

/** 校验并转换单条 parse 配置。返回 undefined 表示非法。缺省视为 periods。 */
function normalizeParse(input: unknown): UsageProbeParseConfig | undefined {
	if (input === undefined || input === null) return { kind: "periods" };
	if (!isRecord(input)) return undefined;
	const kind = input.kind;
	if (kind === "periods") return { kind: "periods" };
	if (kind === "balance") {
		const valuePath = optionalPath(input.valuePath);
		if (!valuePath) return undefined;
		return {
			kind: "balance",
			valuePath,
			...(optionalPath(input.currencyPath) ? { currencyPath: optionalPath(input.currencyPath) } : {}),
		};
	}
	if (kind === "credits") {
		const totalPath = optionalPath(input.totalPath);
		const usedPath = optionalPath(input.usedPath);
		const remainingPath = optionalPath(input.remainingPath);
		// scale（原始积分 → 主单位，如 New API quota / 500000）：正有限数才收，其余视作未填。
		const scaleRaw = input.scale;
		const scale =
			typeof scaleRaw === "number" && Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : undefined;
		const windows: UsageProbeWindowConfig[] = [];
		if (Array.isArray(input.windows)) {
			for (const item of input.windows) {
				const window = normalizeWindow(item);
				if (window) windows.push(window);
			}
		}
		const booster = input.booster !== undefined ? normalizeBooster(input.booster) : undefined;
		// 主值三路径与 windows 至少要有一个可解析的取值来源；booster 是附加项不算。
		if (!totalPath && !usedPath && !remainingPath && windows.length === 0) return undefined;
		return {
			kind: "credits",
			...(totalPath ? { totalPath } : {}),
			...(usedPath ? { usedPath } : {}),
			...(remainingPath ? { remainingPath } : {}),
			...(scale !== undefined ? { scale } : {}),
			...(windows.length > 0 ? { windows } : {}),
			...(booster ? { booster } : {}),
		};
	}
	return undefined;
}

/** 校验并转换单条旧探针。返回 null 表示非法（调用方记录错误）。 */
function normalizeProbe(
	probe: unknown,
	index: number,
): { candidate: UsageProbeCandidate; probe: UserUsageProbe } | { error: string } {
	if (!isRecord(probe)) return { error: `第 ${index + 1} 条探针不是对象` };

	// kind:"custom" 是专用解析器（xAI/Codex 等代码内置），不接受用户配置——
	// 声明式边界必须守住：用户输入永远只是路径取值，不存在代码执行面。
	if (isRecord(probe.parse) && probe.parse.kind === "custom") {
		return { error: `第 ${index + 1} 条探针使用了 kind:"custom" 专用解析器（仅限内置，不支持用户配置）` };
	}

	const match = isRecord(probe.match) ? probe.match : {};
	const baseUrlContains = asStringArray(match.baseUrlContains);
	if (!baseUrlContains || baseUrlContains.length === 0) {
		return { error: `第 ${index + 1} 条探针缺少 match.baseUrlContains（至少一个 baseUrl 关键字）` };
	}

	const request = isRecord(probe.request) ? probe.request : {};
	const path = optionalPath(request.path);
	if (!path || !path.startsWith("/")) {
		return { error: `第 ${index + 1} 条探针缺少 request.path（必须以 / 开头的路径）` };
	}
	const method = request.method === "POST" ? "POST" : "GET";
	// 手动构建 Record<string, string>：Object.fromEntries 无法把「已过滤为字符串」的类型收窄透出。
	let headers: Record<string, string> | undefined;
	if (isRecord(request.headers)) {
		headers = {};
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === "string") headers[key] = value;
		}
	}
	// host 根端点（如智谱监控 API /api/monitor/…，与 OpenAI 兼容端点不同 base）：显式声明。
	const rootPath = request.rootPath === true;
	// 接口自带 Bearer 之外的鉴权（Cookie 登录态）且与 apiKey 双凭证冲突时，禁止自动补
	// Authorization（服务端可能以「凭证不一致」拒绝，见 Token Rhythm AMBIGUOUS_CREDENTIALS）。
	const skipBearer = request.skipBearer === true;

	const parse = normalizeParse(probe.parse);
	if (parse === undefined) {
		return { error: `第 ${index + 1} 条探针的 parse 配置非法（balance 需 valuePath；credits 至少一个路径或窗口）` };
	}

	const normalizedProbe: UserUsageProbe = {
		...(optionalPath(probe.name) ? { name: optionalPath(probe.name) } : {}),
		match: {
			baseUrlContains,
			...(match.apiTypes ? { apiTypes: asStringArray(match.apiTypes) } : {}),
		},
		request: {
			path,
			method,
			...(request.body !== undefined ? { body: request.body } : {}),
			...(headers ? { headers } : {}),
			...(rootPath ? { rootPath: true } : {}),
		},
		parse,
	};

	return {
		probe: normalizedProbe,
		candidate: {
			path,
			method,
			...(request.body !== undefined ? { body: request.body } : {}),
			...(headers ? { headers } : {}),
			baseUrlContains,
			...(match.apiTypes ? { apiTypes: asStringArray(match.apiTypes) } : {}),
			...(rootPath ? { rootPath: true } : {}),
			...(skipBearer ? { noBearer: true } : {}),
			parse,
		},
	};
}

/**
 * 校验并规范化一批旧探针（IPC 历史载荷与 usage-probes.json 文件共用同一套规则）。
 * 入参接受 `{ probes: [...] }` 或裸数组；输出同时带跨进程形态（probes，回显用）
 * 与内部候选（candidates，合并探测用），两者按下标一一对应。
 */
export function normalizeUserUsageProbes(input: unknown): {
	probes: UserUsageProbe[];
	candidates: UsageProbeCandidate[];
	errors: string[];
} {
	const list = Array.isArray(input)
		? input
		: isRecord(input) && Array.isArray(input.probes)
			? input.probes
			: null;
	if (!list) {
		return { probes: [], candidates: [], errors: ["缺少 probes 数组"] };
	}
	const probes: UserUsageProbe[] = [];
	const candidates: UsageProbeCandidate[] = [];
	const errors: string[] = [];
	for (let index = 0; index < list.length; index += 1) {
		const result = normalizeProbe(list[index], index);
		if ("error" in result) {
			errors.push(result.error);
		} else {
			probes.push(result.probe);
			candidates.push(result.candidate);
		}
	}
	return { probes, candidates, errors };
}

/**
 * 读取并校验旧探针（运行时合并探测用）。文件不存在/损坏/为空都安全返回空列表 + 对应错误。
 * 每次调用都重新读盘：用量查询本身低频（渲染层 TTL 去抖），换取「用户/AI 改完立刻生效」。
 */
export async function loadUserUsageProbes(configDir: string): Promise<UserUsageProbeLoadResult> {
	const { candidates, errors } = await readUserUsageProbesNormalized(configDir);
	return { candidates, errors };
}

/**
 * 读盘 + 规范化的共用实现（旧 probes 数组；文件缺失静默空，JSON 损坏返回可读错误）。
 * 导出供弹窗回显：candidates 与 probes 按下标一一对应，按 provider 命中后取回
 * 原始探测形态（含 Cookie 等用户自有字段），映射到声明式 Cookie 模板字段迁移。
 */
export async function loadUserUsageProbesDetailed(configDir: string): Promise<{
	probes: UserUsageProbe[];
	candidates: UsageProbeCandidate[];
	errors: string[];
}> {
	return readUserUsageProbesNormalized(configDir);
}

/** 读盘 + 规范化的共用实现（旧 probes 数组；文件缺失静默空，JSON 损坏返回可读错误）。 */
async function readUserUsageProbesNormalized(configDir: string): Promise<{
	probes: UserUsageProbe[];
	candidates: UsageProbeCandidate[];
	errors: string[];
}> {
	const filePath = join(configDir, USER_USAGE_PROBES_FILE);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { probes: [], candidates: [], errors: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			probes: [],
			candidates: [],
			errors: [
				`${USER_USAGE_PROBES_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}

	// 顶层是文档形态（对象）：probes 是旧版 AI 兜底数组，providers 映射由弹窗维护。
	// 「文档里没有 probes 数组」是合法常态（新格式 { providers: [...] } 或空文档），
	// 不能报「缺少 probes 数组」——DSH/pi 用量查询弹窗会把该错误当黄条显示（截图里的真实 bug）。
	// 只有 probes 键存在且不是数组时才是真正的结构错误。
	if (!Array.isArray(parsed)) {
		if (isRecord(parsed) && Array.isArray(parsed.probes)) {
			return normalizeUserUsageProbes(parsed);
		}
		if (isRecord(parsed) && Object.hasOwn(parsed, "probes")) {
			return { probes: [], candidates: [], errors: ["probes 必须是数组"] };
		}
		return { probes: [], candidates: [], errors: [] };
	}
	return normalizeUserUsageProbes(parsed);
}

// ── providers 映射（per-provider 用量查询配置，UI 唯一写入方） ──────────

/**
 * 校验并规范化单条 provider 配置。返回 { config } 或 { error }（人话描述，不含密钥）。
 * 规则：
 * - enabled：布尔（缺省 = 自动判定）；
 * - template：声明式 id（general/newapi）或内置候选 templateId；未知 id 非法；
 * - baseUrl：必须 http(s):// 开头（可选覆盖）；
 * - apiKey/accessToken/userId：非空字符串（可选/模板强制项在模板构建时校验）；
 * - timeoutSecs：1-300；intervalMinutes：0-1440。
 */
export function normalizeProviderConfig(input: unknown): { config: UsageProbeProviderConfig } | { error: string } {
	if (!isRecord(input)) return { error: "providers 条目必须是对象" };

	const config: UsageProbeProviderConfig = {};
	if (input.enabled !== undefined) {
		if (typeof input.enabled !== "boolean") return { error: "enabled 必须是布尔值" };
		config.enabled = input.enabled;
	}

	if (input.template !== undefined) {
		if (typeof input.template !== "string") return { error: "template 必须是字符串" };
		const id = input.template.trim();
		const isBuiltin = Object.prototype.hasOwnProperty.call(USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID, id);
		if (!isBuiltin && id !== "general" && id !== "newapi" && id !== "cookie") {
			return { error: `未知模板：${id}` };
		}
		config.template = id;
	}

	const apiKey = optionalString(input.apiKey);
	if (apiKey) config.apiKey = apiKey;

	if (input.baseUrl !== undefined) {
		const baseUrl = optionalString(input.baseUrl);
		if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
			return { error: "baseUrl 必须以 http:// 或 https:// 开头" };
		}
		config.baseUrl = baseUrl;
	}

	const accessToken = optionalString(input.accessToken);
	if (accessToken) config.accessToken = accessToken;
	const userId = optionalString(input.userId);
	if (userId) config.userId = userId;

	// Cookie 模板字段：cookie 值任意字符串；cookiePath 必须以 / 开头（与旧探针同规则）。
	const cookie = optionalString(input.cookie);
	if (cookie) config.cookie = cookie;
	if (input.cookiePath !== undefined) {
		const cookiePath = optionalString(input.cookiePath);
		if (!cookiePath || !cookiePath.startsWith("/")) {
			return { error: "cookiePath 必须以 / 开头的路径" };
		}
		config.cookiePath = cookiePath;
	}
	const valuePath = optionalString(input.valuePath);
	if (valuePath) config.valuePath = valuePath;
	const currencyPath = optionalString(input.currencyPath);
	if (currencyPath) config.currencyPath = currencyPath;

	if (input.timeoutSecs !== undefined) {
		if (typeof input.timeoutSecs !== "number" || !Number.isInteger(input.timeoutSecs) || input.timeoutSecs < 1 || input.timeoutSecs > 300) {
			return { error: "timeoutSecs 必须是 1-300 的整数" };
		}
		config.timeoutSecs = input.timeoutSecs;
	}

	if (input.intervalMinutes !== undefined) {
		if (
			typeof input.intervalMinutes !== "number" ||
			!Number.isInteger(input.intervalMinutes) ||
			input.intervalMinutes < 0 ||
			input.intervalMinutes > 1440
		) {
			return { error: "intervalMinutes 必须是 0-1440 的整数（0 = 不自动查询）" };
		}
		config.intervalMinutes = input.intervalMinutes;
	}

	return { config };
}

/** 读盘 providers 映射：逐条校验，非法条目跳过并记录错误（不抛异常）。 */
async function readUsageProbeProviders(configDir: string): Promise<{
	providers: Record<string, UsageProbeProviderConfig>;
	errors: string[];
}> {
	const filePath = join(configDir, USER_USAGE_PROBES_FILE);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { providers: {}, errors: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			providers: {},
			errors: [
				`${USER_USAGE_PROBES_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}

	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		// 旧格式（只有 probes 数组）或空文件：无 provider 配置。
		return { providers: {}, errors: [] };
	}

	const providers: Record<string, UsageProbeProviderConfig> = {};
	const errors: string[] = [];
	for (const [name, entry] of Object.entries(parsed.providers)) {
		const result = normalizeProviderConfig(entry);
		if ("error" in result) {
			errors.push(`providers.${name}：${result.error}`);
		} else {
			providers[name] = result.config;
		}
	}
	return { providers, errors };
}

/**
 * 读取单个 provider 的用量查询配置（弹窗打开时拉取）。
 * 合并两类错误：provider 条目校验错误 + 旧 probes 数组校验错误（后者仅提示用）。
 */
export async function loadUsageProbeSettings(
	configDir: string,
	provider: string,
): Promise<UsageProbeSettingsLoadResult> {
	const providers = await readUsageProbeProviders(configDir);
	const legacy = await readUserUsageProbesNormalized(configDir);
	return {
		...(!providers.providers[provider] ? {} : { config: providers.providers[provider] }),
		errors: [...providers.errors, ...legacy.errors],
	};
}

/**
 * 按 provider 合并保存用量查询配置：保留文件里其它 providers 与旧 probes 数组，
 * 写入前重新校验（渲染层数据不可信），零错误才落盘。
 * 保存 enabled=false 的条目同样落盘——「用户显式关闭」必须持久化。
 */
export async function saveUsageProbeForProvider(
	configDir: string,
	provider: string,
	config: UsageProbeProviderConfig,
): Promise<{ ok: boolean; error?: string }> {
	if (!provider || provider.length > 128) {
		return { ok: false, error: "Invalid provider name" };
	}
	const normalized = normalizeProviderConfig(config);
	if ("error" in normalized) {
		return { ok: false, error: normalized.error };
	}

	// 重新读盘合并（保留并行写入的其它字段），不做缓存——低频写盘换取「文件即真相」。
	const existing = await readUsageProbeRawFile(configDir);
	const nextProviders: Record<string, unknown> = {
		...existing.providers,
		[provider]: normalized.config,
	};
	const nextFile: Record<string, unknown> = { providers: nextProviders };
	// 旧 probes 数组原样保留（AI 直接写的探针不能被 UI 保存动作清掉）。
	if (Object.keys(existing.probes).length > 0) {
		nextFile.probes = existing.probes;
	}

	try {
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, USER_USAGE_PROBES_FILE),
			JSON.stringify(nextFile, null, 2),
			"utf8",
		);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 读原始文件的两部分（providers/probes）供合并写；文件缺失或损坏按空处理（写盘会重建）。 */
async function readUsageProbeRawFile(configDir: string): Promise<{
	providers: Record<string, unknown>;
	probes: unknown[];
}> {
	const filePath = join(configDir, USER_USAGE_PROBES_FILE);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { providers: {}, probes: [] };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return { providers: {}, probes: [] };
		return {
			providers: isRecord(parsed.providers) ? parsed.providers : {},
			probes: Array.isArray(parsed.probes) ? parsed.probes : [],
		};
	} catch {
		return { providers: {}, probes: [] };
	}
}
