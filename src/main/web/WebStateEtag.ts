/**
 * /api/state 的实体标签（ETag）计算。
 *
 * 为什么需要：Web 端每 10s 轮询一次 /api/state，而该载荷包含全部会话投影
 * （545 条约 228KB）。绝大多数轮询窗口里目录根本没变，全量重传纯属浪费——
 * 移动端按流量计费、局域网也白占带宽。给响应加 ETag，客户端带 If-None-Match，
 * 未变化时只回 304（几十字节）。
 *
 * 设计取舍：
 * - 只哈希「会影响 Web 端渲染」的字段（会话 id/标题/更新时间/后端/状态、项目
 *   id/名称/路径、runtime 身份与状态、挂起提问 id），不哈希整个对象——避免
 *   内部字段（filePath 等）抖动造成无谓失效；
 * - 用 sha1 截断 16 字节：这是缓存校验不是安全边界，碰撞概率与探测成本都无关紧要；
 * - 纯函数、不碰 I/O，便于用假状态直接单测。
 */
import { createHash } from "node:crypto";

/**
 * 只要求「有这几个数组」，元素按字段惰性读取：装配层传进来的具体类型
 * （Project[] / PublicSession[] / runtime 快照）都满足，调用方不必强转。
 */
export type EtagState = {
	projects?: ReadonlyArray<unknown>;
	sessions?: ReadonlyArray<unknown>;
	runtimes?: ReadonlyArray<unknown>;
	pendingUiRequests?: ReadonlyArray<unknown>;
};

/** 从任意元素安全取字段（非对象按 undefined 处理，不抛）。 */
function field(item: unknown, key: string): unknown {
	return typeof item === "object" && item !== null && key in item ? (item as Record<string, unknown>)[key] : undefined;
}

/** 把状态压成稳定字符串（字段顺序固定，避免同内容不同键序导致 ETag 抖动）。 */
export function canonicalStateString(state: EtagState): string {
	const sessions = (state.sessions ?? []).map((s) => [field(s, "id"), field(s, "title"), field(s, "updatedAt"), field(s, "backend"), field(s, "status")].join("\u0001"));
	const projects = (state.projects ?? []).map((p) => [field(p, "id"), field(p, "name"), field(p, "path")].join("\u0001"));
	const runtimes = (state.runtimes ?? []).map((r) => [field(r, "sessionId"), field(r, "agentId"), field(r, "status"), field(r, "runtimeGeneration")].join("\u0001"));
	const pending = (state.pendingUiRequests ?? []).map((p) => [field(p, "sessionId"), field(p, "requestId")].join("\u0001"));
	return [projects.join("\u0002"), sessions.join("\u0002"), runtimes.join("\u0002"), pending.join("\u0002")].join("\u0003");
}

/** 强 ETag 形态（含引号）：`"<16 hex>"`。 */
export function stateEtag(state: EtagState): string {
	const digest = createHash("sha1").update(canonicalStateString(state)).digest("hex").slice(0, 32);
	return `"${digest}"`;
}

/** If-None-Match 匹配：支持单值、逗号列表与 *（弱标签前缀 W/ 一并容忍）。 */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
	if (!header) return false;
	const raw = Array.isArray(header) ? header.join(",") : header;
	const target = etag.replace(/^W\//, "");
	return raw.split(",").some((candidate) => {
		const value = candidate.trim().replace(/^W\//, "");
		return value === "*" || value === target;
	});
}
