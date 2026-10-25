import { estimateTokensFromJsonValue, estimateTokensFromText } from "../tokenEstimate";

/**
 * 会话「提示词装载」重放：从 pi 会话文件的系统消息条目还原当前系统提示词与工具清单。
 *
 * pi 把「模型当前看到的提示词」持久化在系统消息条目里（pi docs/session-format.md）：
 * 首个请求写入全部 `sections` 与工具声明；之后的变化写成按节名打补丁的系统消息
 * （`null` 删除该节），工具用 `toolsAdded` / `toolsRemoved` 增量维护；compaction 条目
 * 上的 `systemMessage` 是压缩边界处的完整快照（老会话可能没有这个字段）。
 * 按文件顺序重放这些条目即可还原装载，无需运行 pi 进程。
 *
 * 为什么需要它：圆环面板的「系统 / 工具」两段过去是 `总占用 − 对话估算` 的反推值，
 * 估算误差与各供应商 usage 口径差异会把反推值打到 0（用户看到「系统 + 工具 ~0」），
 * 或反向放大到几十万。直接测量这两段常驻开销后，「对话」作为差值才有意义。
 *
 * 估算口径与对话段一致（见 tokenEstimate：CJK 加权），三段可直接相加比较。
 */

/** 当前装载：系统提示词各节 + 系统消息 content + 工具声明（工具名 → 声明对象）。 */
export type PromptLoadout = {
	/** 节名 → 节文本（pi 的补丁单位） */
	sections: Map<string, string>;
	/** 系统消息的 `content` 字段正文（新格式为空串，老格式可能承载提示词） */
	content: string;
	/** 工具名 → 工具声明（description / parameters 等完整定义） */
	tools: Map<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function toolNameOf(value: unknown): string | undefined {
	return isRecord(value) && typeof value.name === "string" && value.name ? value.name : undefined;
}

export function createPromptLoadout(): PromptLoadout {
	return { sections: new Map(), content: "", tools: new Map() };
}

/** 把 `sections` 补丁应用到装载：字符串覆盖、`null` 删除（其它形状忽略，不动已有内容）。 */
function applySections(loadout: PromptLoadout, sections: unknown): void {
	if (!isRecord(sections)) return;
	for (const [name, text] of Object.entries(sections)) {
		if (text === null) loadout.sections.delete(name);
		else if (typeof text === "string") loadout.sections.set(name, text);
	}
}

/** 工具增量：`toolsAdded` 覆盖同名、`toolsRemoved` 删除。 */
function applyTools(loadout: PromptLoadout, message: Record<string, unknown>): void {
	if (Array.isArray(message.toolsAdded)) {
		for (const tool of message.toolsAdded) {
			const name = toolNameOf(tool);
			if (name) loadout.tools.set(name, tool);
		}
	}
	if (Array.isArray(message.toolsRemoved)) {
		for (const tool of message.toolsRemoved) {
			const name = toolNameOf(tool) ?? (typeof tool === "string" ? tool : undefined);
			if (name) loadout.tools.delete(name);
		}
	}
}

/**
 * 应用一条消息条目的补丁（非 system 角色与畸形条目直接忽略，不抛错）。
 * 调用方按文件顺序喂入即可得到当前装载。
 */
export function applyPromptMessage(loadout: PromptLoadout, message: unknown): void {
	if (!isRecord(message) || message.role !== "system") return;
	if (typeof message.content === "string" && message.content) loadout.content = message.content;
	applySections(loadout, message.sections);
	applyTools(loadout, message);
}

/**
 * 用 compaction 快照重置装载（pi：压缩边界处的完整提示词与工具声明；
 * 压缩后 `systemMessage` 之前的历史系统消息不再生效）。
 *
 * 快照缺失字段时保留当前值：老会话没有 `systemMessage`，此时原样返回，
 * 由调用方决定是否保留上一份装载（保留比清空更接近事实——压缩不改变提示词装载）。
 */
export function resetPromptLoadoutFromSnapshot(loadout: PromptLoadout, snapshot: unknown): void {
	if (!isRecord(snapshot)) return;
	if (typeof snapshot.content === "string") loadout.content = snapshot.content;
	if (isRecord(snapshot.sections)) {
		loadout.sections.clear();
		applySections(loadout, snapshot.sections);
	}
	if (Array.isArray(snapshot.toolsAdded)) {
		loadout.tools.clear();
		applyTools(loadout, snapshot);
	}
}

/** 装载 → 两段 token 估算：系统提示词（content + 全部节）与工具声明。 */
export function estimatePromptLoadoutTokens(loadout: PromptLoadout): { systemTokens: number; toolsTokens: number } {
	let systemTokens = loadout.content ? estimateTokensFromText(loadout.content) : 0;
	for (const section of loadout.sections.values()) systemTokens += estimateTokensFromText(section);
	let toolsTokens = 0;
	for (const tool of loadout.tools.values()) toolsTokens += estimateTokensFromJsonValue(tool);
	return { systemTokens, toolsTokens };
}

/**
 * 装载是否含有可测量的内容。空装载（文件里没写过提示词，或系统消息只是删除补丁）
 * 不能当成「系统/工具为 0」：调用方应改为不下发这两段测量值，由 UI 退回旧的两段反推口径。
 */
export function hasMeasuredPromptLoadout(loadout: PromptLoadout): boolean {
	return loadout.sections.size > 0 || loadout.tools.size > 0 || loadout.content.length > 0;
}
