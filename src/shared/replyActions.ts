/**
 * 回复快捷操作规则的解析与清洗（主进程与测试共用，无运行时依赖）。
 *
 * 结构与 shared/quickMessages.ts 同一套思路：
 * - 裸数组 / {items} 都接受（用户手写文件时少一层包裹）；
 * - 清空后的文件（items: []）必须能被识别，否则重启会「复活」出厂规则；
 * - 结构不可识别返回 null，由调用方备份后按出厂规则重建。
 */
import type { ReplyActionRule, ReplyActionTrigger, ReplyActionTriggerKind } from "./types/replyActions";

/** 当前规则文件版本；后续结构演进时递增并做读取兼容 */
export const REPLY_ACTIONS_FILE_VERSION = 1;

/** 单文件规则条数上限：建议条一次最多展示几条，超配只会稀释注意力 */
export const MAX_REPLY_ACTION_RULES = 64;

const TRIGGER_KINDS: readonly ReplyActionTriggerKind[] = ["onFailure", "onStop", "always", "textMatch"];

// v1 出厂规则曾把这些关键词压成一个组合正则；读取旧的 userData 时拆回普通关键词，
// 这样升级后设置页不会继续显示一整串用户无法理解的正则。其它自定义正则保持原样。
const LEGACY_COMPLETION_PATTERN = "(?:完成|搞定|已?实现|已?修复|已?支持|改完|写完|测试通过|全部通过|验证通过)";
const LEGACY_COMPLETION_PATTERNS = ["完成", "搞定", "实现", "已实现", "修复", "已修复", "支持", "已支持", "改完", "写完", "测试通过", "全部通过", "验证通过"];

function isReplyActionTriggerKind(value: unknown): value is ReplyActionTriggerKind {
	return typeof value === "string" && (TRIGGER_KINDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松清洗一个 trigger：kind 不认识、textMatch 缺 patterns 都按无效丢弃 */
export function sanitizeReplyActionTrigger(value: unknown): ReplyActionTrigger | null {
	if (!isPlainObject(value)) return null;
	const kind = value.kind;
	if (!isReplyActionTriggerKind(kind)) return null;
	if (kind === "textMatch") {
		const rawPatterns = value.patterns;
		if (!Array.isArray(rawPatterns)) return null;
		const patterns = rawPatterns
			.filter((pattern): pattern is string => typeof pattern === "string")
			.flatMap((pattern) => (pattern.trim() === LEGACY_COMPLETION_PATTERN ? LEGACY_COMPLETION_PATTERNS : pattern.split(/[,，]/)))
			.map((pattern) => pattern.trim())
			.filter((pattern) => pattern.length > 0);
		if (patterns.length === 0) return null;
		return { kind, patterns };
	}
	return { kind };
}

/** 宽松清洗单条规则：text 必填非空，triggers 至少一条有效 */
export function sanitizeReplyActionRule(value: unknown): ReplyActionRule | null {
	if (!isPlainObject(value)) return null;
	const text = value.text;
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	const rawTriggers = value.triggers;
	if (!Array.isArray(rawTriggers)) return null;
	const triggers: ReplyActionTrigger[] = [];
	for (const rawTrigger of rawTriggers) {
		const trigger = sanitizeReplyActionTrigger(rawTrigger);
		// 同 kind 的 textMatch 合并 patterns，减少用户手写文件时的重复条目
		if (!trigger) continue;
		const existing = triggers.find((candidate) => candidate.kind === trigger.kind);
		if (existing && trigger.patterns) {
			existing.patterns = [...(existing.patterns ?? []), ...trigger.patterns];
			continue;
		}
		if (existing) continue;
		triggers.push(trigger);
	}
	if (triggers.length === 0) return null;
	return { text: trimmed, triggers };
}

/** 清洗整个规则数组：去空白、去重（按 text）、截断到上限 */
export function sanitizeReplyActionRuleList(value: unknown): ReplyActionRule[] {
	if (!Array.isArray(value)) return [];
	const rules: ReplyActionRule[] = [];
	const seenText = new Set<string>();
	for (const rawRule of value) {
		const rule = sanitizeReplyActionRule(rawRule);
		if (!rule) continue;
		if (seenText.has(rule.text)) continue;
		seenText.add(rule.text);
		rules.push(rule);
		if (rules.length >= MAX_REPLY_ACTION_RULES) break;
	}
	return rules;
}

/**
 * 清洗规则文件内容。返回 null 表示「结构不可识别」（调用方应备份后用出厂规则重建）；
 * 裸数组与 {items} 都接受，items: [] 是合法的「用户清空」。
 */
export type ReplyActionsFilePayload = { version: number; items: ReplyActionRule[] };

export function sanitizeReplyActionsFile(raw: unknown): ReplyActionsFilePayload | null {
	if (Array.isArray(raw)) return { version: REPLY_ACTIONS_FILE_VERSION, items: sanitizeReplyActionRuleList(raw) };
	if (!isPlainObject(raw)) return null;
	if (!("items" in raw)) return null;
	if (!Array.isArray(raw.items)) return null;
	const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : REPLY_ACTIONS_FILE_VERSION;
	return { version, items: sanitizeReplyActionRuleList(raw.items) };
}
