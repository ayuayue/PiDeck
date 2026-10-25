/**
 * 终端回放缓冲（分段存储，纯函数模块，可单测）。
 *
 * 为什么分段：旧实现是单字符串 `buffer = buffer + data`，超过 200K 上限后**每个**
 * chunk 都触发一次 `slice(-200_000)`——V8 对 rope 做尾部截断要整段扁平化 + 拷贝，
 * 高吞吐场景（cat 大文件 / 编译输出，合批器单帧可推 64K）等于每秒几十 MB 的
 * 无谓拷贝，全部发生在主进程事件循环上。分段后追加是 O(1) 的 push，只有丢整段
 * 头部时才付一次 O(段长)，摊还后与吞吐无关。
 *
 * 上限语义：字符总量始终 <= MAX + 单段长度（丢头部的前提是丢完后仍有 >= MAX 的
 * 内容），比旧的「恒等于 MAX」略宽但同量级，目的（封顶常驻内存）不变；单段本身
 * 超过上限的罕见场景退化为一次尾部截断，与旧行为一致。
 */
export const MAX_TERMINAL_REPLAY_BUFFER = 200_000;

export type TerminalReplayBuffer = {
	/** 从旧到新的分段序列；join 即完整回放文本。 */
	chunks: string[];
	/** 各分段长度之和（避免每次 append 都重算）。 */
	length: number;
};

export function createTerminalReplayBuffer(): TerminalReplayBuffer {
	return { chunks: [], length: 0 };
}

/**
 * 追加一段输出并维持上限。
 *
 * 丢头部的前提是「丢掉这一段后总长仍 >= MAX」：这保证缓冲永不超过 MAX + 最老一段，
 * 同时不会为了严格贴线而丢掉还有效的近期内容。只剩一段且仍超限时（单 chunk 大于
 * 上限）退化为一次尾部截断，行为与旧的单字符串实现一致。
 */
/** 分段数上限：超过后把较旧的一半合并成一段（摊还 O(总长/次数)，见 compactTerminalReplay）。 */
const MAX_REPLAY_CHUNK_COUNT = 512;

/**
 * 分段数压实：交互式输入（每键 1-2 字符）也会让分段数随会话寿命线性增长，
 * 每段一个字符串对象的开销（头 ~几十字节）会绕过字符上限的封顶意图。
 * 超过上限时把较旧的一半 join 成一段：每 ~256 次追加付一次 O(当时总长)，
 * 摊还后仍是 O(1)，分段数收敛到上限以内。
 */
function compactTerminalReplay(buffer: TerminalReplayBuffer): void {
	if (buffer.chunks.length <= MAX_REPLAY_CHUNK_COUNT) return;
	const mergeCount = Math.floor(buffer.chunks.length / 2);
	const merged = buffer.chunks.slice(0, mergeCount).join("");
	buffer.chunks.splice(0, mergeCount, merged);
}

export function appendTerminalReplay(buffer: TerminalReplayBuffer, data: string): void {
	if (data.length === 0) return;
	buffer.chunks.push(data);
	buffer.length += data.length;
	while (buffer.chunks.length > 1) {
		const headLength = buffer.chunks[0]?.length ?? 0;
		if (buffer.length - headLength < MAX_TERMINAL_REPLAY_BUFFER) break;
		buffer.chunks.shift();
		buffer.length -= headLength;
	}
	if (buffer.chunks.length === 1 && buffer.length > MAX_TERMINAL_REPLAY_BUFFER) {
		const head = buffer.chunks[0] ?? "";
		buffer.chunks[0] = head.slice(head.length - MAX_TERMINAL_REPLAY_BUFFER);
		buffer.length = MAX_TERMINAL_REPLAY_BUFFER;
	}
	compactTerminalReplay(buffer);
}

/** 当前回放文本（切回 tab / 列表快照时一次性 join，不在追加热路径上）。 */
export function terminalReplayText(buffer: TerminalReplayBuffer): string {
	return buffer.chunks.join("");
}
