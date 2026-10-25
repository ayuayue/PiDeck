/**
 * 估算「一轮消息下发到渲染进程」的 payload 体积（字节）。
 *
 * 为什么需要（2026-08 #213）：崩溃报告里只能看到 `Agent messages loaded
 * {rawMessages: 2162}` 这种条数，看不出实际体量；而把渲染进程打爆的正是体量
 * （同一条数的会话可以是 2MB 也可以是 60MB）。有了 payloadBytes，日志时间线上
 * 「加载 N 条 / X MB」→「Main window renderer process gone {exitCode: 5}」的因果
 * 一眼可判，不必让用户复现完再猜。
 *
 * 为什么不直接 `JSON.stringify(payload).length`：序列化会再分配一份等大的字符串
 * （20MB 会话就是再 40MB 内存 + GC 压力），而崩溃现场恰好最缺内存。这里只在已有对象
 * 图上走一遍累加字符串长度，不产生大对象；代价是 O(payload) 的遍历，量级与一次
 * JSON 序列化相同但常量更小。
 *
 * 精度：字符串按 UTF-8 字节计（与 IPC 序列化后的真实字节最接近），数字/布尔/null
 * 按 8 字节近似，对象键名与分隔符按固定开销近似——用途是判断量级（几 MB 还是几十 MB），
 * 不追求字节级相等。
 */

/** 递归深度上限：IPC 载荷必然是 JSON 可序列化的树，这里纯粹是防意外自引用把日志自己打挂。 */
const MAX_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 估算任意 JSON 形状值的序列化字节数。 */
function estimateValueBytes(value: unknown, depth: number): number {
	if (depth > MAX_DEPTH) return 0;
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (typeof value === "number" || typeof value === "boolean") return 8;
	if (value === null) return 8;
	if (Array.isArray(value)) {
		let total = 2; // [ ]
		for (const item of value) total += estimateValueBytes(item, depth + 1) + 1;
		return total;
	}
	if (isRecord(value)) {
		let total = 2; // { }
		for (const [key, item] of Object.entries(value)) {
			total += Buffer.byteLength(key, "utf8") + 4 + estimateValueBytes(item, depth + 1);
		}
		return total;
	}
	// undefined / function / symbol 不会出现在 IPC 载荷里，忽略
	return 0;
}

/**
 * 估算消息数组下发到渲染进程的字节数。
 * 入参是「已投影、即将下发」的消息对象数组（含工具结果大载荷）。
 */
export function estimateMessagesPayloadBytes(messages: ReadonlyArray<unknown>): number {
	let total = 2;
	for (const message of messages) total += estimateValueBytes(message, 0) + 1;
	return total;
}
