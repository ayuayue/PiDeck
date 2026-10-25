/**
 * 收藏入参的纯解析层（不依赖 Electron，node:test 可直接加载）。
 *
 * 渲染层数据一律不可信：只接受白名单字段，枚举走白名单，字符串按上限截断/丢弃，
 * 返回新对象（多余字段不进入 store）。正文不做 trim 之外的内容改写——Markdown 源码
 * 要按原样保存，否则收藏出来的回复会丢层级与代码块。
 */
import { FAVORITE_META_MAX_CHARS, FAVORITE_SESSION_TITLE_MAX_CHARS, FAVORITE_TEXT_INPUT_MAX_CHARS, type FavoriteKind, type FavoriteRole } from "../../shared/types";

export type NormalizedFavoriteInput = {
	kind: FavoriteKind;
	text: string;
	role: FavoriteRole | null;
	sessionId: string | null;
	sessionTitle: string | null;
	projectId: string | null;
	messageId: string | null;
	model: string | null;
	partial: boolean;
};

const FAVORITE_KINDS: readonly FavoriteKind[] = ["message", "selection"];
const FAVORITE_ROLES: readonly FavoriteRole[] = ["user", "assistant", "system"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxChars) : null;
}

function readRole(value: unknown): FavoriteRole | null {
	return typeof value === "string" && (FAVORITE_ROLES as readonly string[]).includes(value) ? (value as FavoriteRole) : null;
}

/**
 * 解析并收窄一条收藏入参。
 * 只拒绝「形状不对 / 正文明文为空 / 正文超长」三类错误；其余字段非法一律降级为 null，
 * 避免因为一个可选元信息（如会话标题）缺字段就把整次收藏打回。
 */
export function parseAddFavoriteInput(value: unknown): NormalizedFavoriteInput {
	if (!isRecord(value)) throw new Error("Invalid favorite input: not an object");
	if (typeof value.kind !== "string" || !(FAVORITE_KINDS as readonly string[]).includes(value.kind)) throw new Error("Invalid favorite input: kind");
	if (typeof value.text !== "string") throw new Error("Invalid favorite input: text");
	const text = value.text.trim();
	if (!text) throw new Error("Invalid favorite input: text is empty");
	if (text.length > FAVORITE_TEXT_INPUT_MAX_CHARS) throw new Error("Invalid favorite input: text too long");
	return {
		kind: value.kind as FavoriteKind,
		text,
		role: readRole(value.role),
		sessionId: readOptionalString(value.sessionId, FAVORITE_META_MAX_CHARS),
		sessionTitle: readOptionalString(value.sessionTitle, FAVORITE_SESSION_TITLE_MAX_CHARS),
		projectId: readOptionalString(value.projectId, FAVORITE_META_MAX_CHARS),
		messageId: readOptionalString(value.messageId, FAVORITE_META_MAX_CHARS),
		model: readOptionalString(value.model, FAVORITE_META_MAX_CHARS),
		partial: value.partial === true,
	};
}
