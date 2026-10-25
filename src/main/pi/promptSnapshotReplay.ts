import type { SessionPromptSnapshot } from "../../shared/types/trajectory";
import { MAX_TRAJECTORY_PROMPT_TOOLS, promptSnapshotSummary, truncatePromptText } from "../../shared/trajectoryPrompt";
import { applyPromptMessage, createPromptLoadout, resetPromptLoadoutFromSnapshot, type PromptLoadout } from "./promptLoadout";

/**
 * pi 会话文件「提示词装载」重放 → 轨迹账本的系统提示词快照。
 *
 * pi 把模型当轮看到的提示词持久化成系统消息条目（docs/session-format.md）：
 * 首个请求写入 content + 全部 `sections` + 工具声明，之后的变化写成按节名打补丁的
 * 系统消息（`null` 删节）、工具用 `toolsAdded`/`toolsRemoved` 增量维护；压缩条目的
 * `systemMessage` 是压缩边界处的全量快照。按文件顺序重放这些条目即可还原「提示词何时变成什么」。
 *
 * 与 promptLoadout.ts 的分工：那边只关心**当前**装载（上下文圆环估 token），本模块关心
 * **每一次变化**（轨迹账本要把初始提示词与中途更新点摆到对应回合里），因此额外算 diff、
 * 去重相同快照、并对回传文本设上界。装载的补丁语义（节覆盖/删除、工具增删）复用同一份实现，
 * 避免两处口径漂移。
 *
 * 只说文件事实，不猜：会话文件没写过系统消息（早于 pi 落盘该条目的旧会话）时一条也不产。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 装载 → 渲染文本：content（老格式正文）+ 各节按声明顺序拼接。 */
function promptTextOf(loadout: PromptLoadout): string {
	const parts: string[] = [];
	if (loadout.content.trim()) parts.push(loadout.content);
	for (const text of loadout.sections.values()) {
		if (text.trim()) parts.push(text);
	}
	return parts.join("\n\n");
}

function toolNamesOf(loadout: PromptLoadout): string[] {
	return [...loadout.tools.keys()].sort().slice(0, MAX_TRAJECTORY_PROMPT_TOOLS);
}

function removedNames(before: Iterable<string>, after: ReadonlySet<string>): string[] {
	const removed: string[] = [];
	for (const name of before) {
		if (!after.has(name)) removed.push(name);
	}
	return removed;
}

function addedNames(before: ReadonlySet<string>, after: Iterable<string>): string[] {
	const added: string[] = [];
	for (const name of after) {
		if (!before.has(name)) added.push(name);
	}
	return added;
}

/**
 * 「装载每次变化」的重放器：调用方按会话文件顺序喂 system 消息与压缩快照。
 * 无变化（文本与工具集都相同）返回 undefined —— 账本不为重复装载留空记录。
 */
export class PromptSnapshotReplay {
	private loadout = createPromptLoadout();
	private previousSections = new Map<string, string>();
	private previousTools: string[] = [];
	private previousText = "";
	private emitted = 0;

	/** 喂一条 `message` 条目；非 system 角色与畸形条目忽略。 */
	applySystemMessage(message: unknown): SessionPromptSnapshot | undefined {
		if (!isRecord(message) || message.role !== "system") return undefined;
		applyPromptMessage(this.loadout, message);
		return this.takeSnapshot();
	}

	/** 喂压缩条目的 `systemMessage`（压缩边界全量快照，覆盖此前装载）。 */
	applyCompactionSnapshot(snapshot: unknown): SessionPromptSnapshot | undefined {
		if (!isRecord(snapshot)) return undefined;
		resetPromptLoadoutFromSnapshot(this.loadout, snapshot);
		return this.takeSnapshot("snapshot");
	}

	/** 取一份快照：与上一份相同则丢弃，否则带上 diff（首份不带）。 */
	private takeSnapshot(kind?: "snapshot"): SessionPromptSnapshot | undefined {
		const text = promptTextOf(this.loadout);
		const tools = toolNamesOf(this.loadout);
		const unchanged = text === this.previousText && tools.length === this.previousTools.length && tools.every((name, index) => name === this.previousTools[index]);
		if (this.emitted > 0 && unchanged) return undefined;

		const sections = this.loadout.sections;
		const toolSet = new Set(tools);
		const sectionNames = new Set(sections.keys());
		const clipped = truncatePromptText(text);
		const snapshot: SessionPromptSnapshot = {
			kind: this.emitted === 0 ? "initial" : (kind ?? "update"),
			text: clipped.text,
			tools,
			...(this.emitted === 0
				? {}
				: {
						toolsAdded: addedNames(new Set(this.previousTools), tools),
						toolsRemoved: removedNames(this.previousTools, toolSet),
						sectionsAdded: addedNames(new Set(this.previousSections.keys()), sectionNames),
						sectionsUpdated: [...sections.entries()].filter(([name, value]) => this.previousSections.has(name) && this.previousSections.get(name) !== value).map(([name]) => name),
						sectionsRemoved: removedNames(this.previousSections.keys(), sectionNames),
					}),
			...(clipped.truncated ? { truncated: true } : {}),
		};
		this.emitted += 1;
		this.previousText = text;
		this.previousTools = tools;
		this.previousSections = new Map(sections);
		return snapshot;
	}
}

/** 快照摘要（复用共享口径；用户可见文案由渲染层按 i18n 生成）。 */
export { promptSnapshotSummary };
