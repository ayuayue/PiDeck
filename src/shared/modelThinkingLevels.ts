/**
 * 每模型「思考档位」的统一读写工具：settings.json 的 modelThinkingLevels 默认档位，
 * 以及模型自身的 thinkingLevelMap（可用档位 + 上游 wire 值）。
 *
 * 为什么需要 shared：同一张映射有三个消费方，各自手写键格式/裁剪必然漂移——
 *   1. 主进程 resolveLaunchDefaultOptions / createDraft：解析新会话的预选思考档位；
 *   2. 配置页模型表：读写单个模型的默认档位（与全局 defaultThinkingLevel 共用
 *      settings.json 的保存链路）；
 *   3. 引导页展示：按当前展示的模型反查档位，保证「创建前显示 = 创建时套用」。
 *
 * 键格式与 pi 自己的 settings-manager 完全一致：`${provider}/${modelId}`。
 * 值域是 pi 的规范档位；这里**不**对值做白名单裁剪——档位最终由 pi 裁决
 *（setThinkingLevel 会按该模型 available levels 收敛），PiDeck 只存用户的选择，
 * 不落第二份能力副本。解析函数同样只做「非空字符串」过滤，脏形状逐级降级。
 *
 * 纯函数、除类型外无依赖（shared 层约束）。
 */

import type { ProviderModelIdIndex, ThinkingLevelMap } from "./types/modelSpecs";

/** pi 的规范思考档位（与 ThinkingLevelMap 的键一致），供选择器在能力未知时兜底列全量。 */
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

/**
 * pi 只在 thinkingLevelMap 里显式给出值时才会承认存在的档位（见 pi `getSupportedThinkingLevels`）：
 * 其余档位对推理模型默认开放，这两个必须带 wire 值。
 */
const EXPLICIT_MAPPING_LEVELS: readonly ModelThinkingLevel[] = ["xhigh", "max"];

/** pi settings-manager 使用的映射键（provider/modelId，不做任何转义）。 */
export function modelThinkingLevelsKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/**
 * 把任意档位列表按 pi 的规范档位顺序排列，供配置页下拉与只读展示共用。
 * pi capability 探测返回的顺序不保证稳定；不认识的档位（未来新增）按原序排在后面，不丢项。
 */
export function orderModelThinkingLevels(levels: readonly string[]): string[] {
	const known: string[] = MODEL_THINKING_LEVELS.filter((level) => levels.includes(level));
	const extra = levels.filter((level) => !(MODEL_THINKING_LEVELS as readonly string[]).includes(level));
	return [...known, ...extra];
}

/**
 * 从 pi settings 对象里解析「每模型默认档位」表。
 * 逐项只保留非空字符串值；整表为空/形状不对时返回 undefined（调用方据此走全局默认）。
 */
export function parseModelThinkingLevels(settings: unknown): Record<string, string> | undefined {
	if (!isRecord(settings)) return undefined;
	const raw = settings.modelThinkingLevels;
	if (!isRecord(raw)) return undefined;
	const levels: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		// 值两端空白顺手裁掉：它会一路流到会话记录与 pi 的档位入参，带空白等于无法识别的档位。
		if (key && typeof value === "string" && value.trim()) levels[key] = value.trim();
	}
	return Object.keys(levels).length > 0 ? levels : undefined;
}

/**
 * 按 provider/modelId 从已解析的映射表里取默认档位。
 * provider/modelId 缺失（旧数据、半结构偏好）或值非法时返回 undefined。
 */
export function modelThinkingLevelOfMap(map: unknown, provider: string | undefined, modelId: string | undefined): string | undefined {
	if (!provider || !modelId) return undefined;
	if (!isRecord(map)) return undefined;
	const value = map[modelThinkingLevelsKey(provider, modelId)];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 直接从 pi settings 对象里取某模型的默认档位（内部读 modelThinkingLevels 子表）。 */
export function modelThinkingLevelOf(settings: unknown, provider: string | undefined, modelId: string | undefined): string | undefined {
	return modelThinkingLevelOfMap(isRecord(settings) ? settings.modelThinkingLevels : undefined, provider, modelId);
}

/**
 * 替换某 provider 的「每模型默认档位」（供应商页确认时用）：先清旧名字前缀，再按最终名字写入。
 *
 * 为什么是替换而不是增删：供应商页把「这个供应商当前有哪些模型的档位」整份读进页内草稿，
 * 确认时交回来的就是绝对快照——模型被删掉后它的档位自然一起消失（设置跟着模型走），
 * 页内改名（savedProvider ≠ finalProvider）也不会把键留在旧名字下。
 * 无实质变化时原样返回入参（调用方据此决定是否记脏标记）。
 * 重建表时逐项收窄（只留非空字符串值），手写进去的脏条目顺手丢掉——pi 也不认它们。
 */
export function replaceModelThinkingLevels(settings: Record<string, unknown>, savedProvider: string, finalProvider: string, defaults: Record<string, string>): Record<string, unknown> {
	const table = parseModelThinkingLevels(settings) ?? {};
	const savedPrefix = savedProvider ? `${savedProvider}/` : "";
	const next: Record<string, string> = {};
	for (const [key, level] of Object.entries(table)) {
		// 旧名字前缀整段清掉；savedProvider 为空（新增供应商）时没有可清的
		if (savedProvider && key.startsWith(savedPrefix)) continue;
		next[key] = level;
	}
	if (finalProvider) {
		for (const [modelId, level] of Object.entries(defaults)) {
			const trimmed = typeof level === "string" ? level.trim() : "";
			if (modelId && trimmed) next[modelThinkingLevelsKey(finalProvider, modelId)] = trimmed;
		}
	}
	if (sameTable(table, next)) return settings;
	const updated: Record<string, unknown> = { ...settings };
	if (Object.keys(next).length > 0) updated.modelThinkingLevels = next;
	else delete updated.modelThinkingLevels;
	return updated;
}

/**
 * 清掉「provider 在 models.json 里、但模型 id 不在它的模型列表里」的孤儿档位键。
 * 配置保存前调用：改过模型 ID / 删过模型之后，旧 ID 名下的设置不再留下（设置跟着模型走）。
 * 不在 modelIdsByProvider 表里的 provider 一律不碰——pi 内置 provider 的档位是合法的。
 * 命中孤儿重建表时同样只留非空字符串值（脏条目一并丢掉）。
 */
export function pruneModelThinkingLevelOrphans(settings: Record<string, unknown>, modelIdsByProvider: ProviderModelIdIndex): Record<string, unknown> {
	const table = parseModelThinkingLevels(settings);
	if (!table) return settings;
	const next: Record<string, string> = {};
	let dropped = false;
	for (const [key, level] of Object.entries(table)) {
		const slash = key.indexOf("/");
		const modelId = slash > 0 ? key.slice(slash + 1) : "";
		const known = slash > 0 ? modelIdsByProvider.get(key.slice(0, slash)) : undefined;
		if (known && !known.has(modelId)) {
			dropped = true;
			continue;
		}
		next[key] = level;
	}
	if (!dropped) return settings;
	const updated: Record<string, unknown> = { ...settings };
	if (Object.keys(next).length > 0) updated.modelThinkingLevels = next;
	else delete updated.modelThinkingLevels;
	return updated;
}

/** 两张 `provider/modelId → 档位` 表是否逐项相同（替换写入用它判断「无实质变化」）。 */
function sameTable(left: Record<string, string>, right: Record<string, string>): boolean {
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => right[key] === left[key]);
}

/**
 * 写入/清除某模型的默认档位，返回新的 settings 对象（不可变更新，供 React setState 使用）。
 * level 为空/空白 = 删除该键；表被清空时连 modelThinkingLevels 一起删（不留空对象）。
 * 表内其它键原样保留（含用户手写的自定义键），不整表重建。
 */
export function withModelThinkingLevelDefault(settings: Record<string, unknown>, provider: string, modelId: string, level: string | undefined): Record<string, unknown> {
	const current = isRecord(settings.modelThinkingLevels) ? settings.modelThinkingLevels : {};
	const next = { ...current };
	const trimmed = typeof level === "string" ? level.trim() : "";
	if (trimmed) next[modelThinkingLevelsKey(provider, modelId)] = trimmed;
	else delete next[modelThinkingLevelsKey(provider, modelId)];
	const updated: Record<string, unknown> = { ...settings };
	if (Object.keys(next).length > 0) updated.modelThinkingLevels = next;
	else delete updated.modelThinkingLevels;
	return updated;
}

/**
 * 单个思考档位在配置页的展示态：是否可用（勾选态）+ 需要提示的上游 wire 值。
 * wireValue 只在「显式映射 ≠ 档位名」时给出（恒等映射与 pi 默认行为一致，不必展示）。
 */
export type ModelThinkingLevelState = {
	enabled: boolean;
	wireValue: string;
};

/**
 * 判定某档位对该模型是否可用（配置页勾选态），与 pi `getSupportedThinkingLevels`
 *（packages/ai/src/models.ts）同一套判定：
 *   - reasoning 未声明 / false → 只有 off；
 *   - reasoning: true → off/minimal/low/medium/high 默认开放；
 *   - xhigh / max 必须显式出现在 thinkingLevelMap 里；
 *   - 任何档位写 null 都表示「该模型不支持」。
 *
 * 只依赖模型自身字段，不读 Pi 的能力探测结果：探测回答的是「已保存配置」，
 * 而勾选态必须能实时预演草稿里的改动（含尚未保存的新行）。
 */
export function modelThinkingLevelState(model: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap }, level: ModelThinkingLevel): ModelThinkingLevelState {
	const mapped = model.thinkingLevelMap?.[level];
	if (mapped === null) return { enabled: false, wireValue: "" };
	if (typeof mapped === "string") return { enabled: true, wireValue: mapped === level ? "" : mapped };
	// 没有显式条目：走 pi 的默认规则（xhigh/max 没有值就不存在）
	if (EXPLICIT_MAPPING_LEVELS.includes(level)) return { enabled: false, wireValue: "" };
	return { enabled: model.reasoning === true || level === "off", wireValue: "" };
}

/** 按 pi 规范顺序列出该模型可用的思考档位（= 配置页勾选态集合）。 */
export function enabledModelThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap }): ModelThinkingLevel[] {
	return MODEL_THINKING_LEVELS.filter((level) => modelThinkingLevelState(model, level).enabled);
}

/**
 * 勾选 / 取消某档位后的新 thinkingLevelMap（不可变；返回 undefined = 该字段整体不写）。
 *
 * 写回规则（与 pi 的判定配套，保证勾选态往返后不留多余条目）：
 *   - 勾选 off..high：删掉显式条目（pi 的默认就是恒等映射）；已有自定义 wire 值时原样保留；
 *   - 勾选 xhigh / max：写入同名 wire 值（pi 要求显式值，缺条目等于不存在）；
 *   - 取消 off..high：写 null——这是 pi 表达「该档位不可用」的唯一方式；
 *   - 取消 xhigh / max：删条目（对这两个档位缺条目与 null 等价，少写不污染配置）。
 */
export function withModelThinkingLevelEnabled(map: ThinkingLevelMap | undefined, level: ModelThinkingLevel, enabled: boolean): ThinkingLevelMap | undefined {
	const next: ThinkingLevelMap = { ...(map ?? {}) };
	const explicitMapping = EXPLICIT_MAPPING_LEVELS.includes(level);
	if (enabled) {
		if (typeof next[level] !== "string") {
			if (explicitMapping) next[level] = level;
			else delete next[level];
		}
	} else if (explicitMapping) {
		delete next[level];
	} else {
		next[level] = null;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 档位摘要（表格单元格 / Pi 探测行共用）：只写首尾两档，够短也够用。
 *   - 首尾之间没有缺档 → `off → max`（实线箭头 = 连续覆盖）
 *   - 中间有跳档 → `off…max`（省略号 = 中间还有别的，但不保证连续）
 *   - 单档 → 只写自己
 * 完整清单在单元格悬停提示与弹层勾选列表里，摘要不必背这个包袱（表格列只有 96px，
 * 逐个列出来会被截断成省略号，反而看不出首尾）。顺序不合法（非规范顺序或含未知档位）
 * 时退化成逗号列表，不猜测用户意图。
 */
export function formatModelThinkingLevelsSummary(levels: readonly string[]): string {
	const canonical: readonly string[] = MODEL_THINKING_LEVELS;
	const positions = levels.map((level) => canonical.indexOf(level));
	const ordered = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
	if (!ordered) return levels.join(", ");
	if (levels.length <= 1) return levels[0] ?? "";
	// 位置连续 = 首尾之间每一档都在列表里（列表本身已按规范顺序排好）
	const contiguous = positions[positions.length - 1] - positions[0] === levels.length - 1;
	// 箭头两侧留空格（`off → max` 更好读），省略号紧贴（`off…max` 更省地方）
	return contiguous ? `${levels[0]} → ${levels[levels.length - 1]}` : `${levels[0]}…${levels[levels.length - 1]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
