/** 主进程保留最近的终端输出，切回 tab 时用各段重建 scrollback。 */
export const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
const REPLAY_BLOCK_CHARS = 4096;

export type TerminalReplayBuffer = {
	chunks: string[];
	/** 各分段长度之和。除最后一段外，每段都有 REPLAY_BLOCK_CHARS 个字符。 */
	length: number;
};

export function createTerminalReplayBuffer(): TerminalReplayBuffer {
	return { chunks: [], length: 0 };
}

export function appendTerminalReplay(buffer: TerminalReplayBuffer, data: string): void {
	if (!data.length) return;
	let offset = 0;
	if (data.length >= MAX_TERMINAL_REPLAY_BUFFER) {
		// 新片段本身就覆盖整个窗口，旧段和新数据的前缀都不用再处理。
		buffer.chunks.length = 0;
		buffer.length = 0;
		offset = data.length - MAX_TERMINAL_REPLAY_BUFFER;
	}
	buffer.length += data.length - offset;

	// 只填充尾块，不把首块反复并入更大的字符串；这样旧块总能整块淘汰。
	const last = buffer.chunks.length - 1;
	if (last >= 0 && buffer.chunks[last].length < REPLAY_BLOCK_CHARS) {
		const count = Math.min(REPLAY_BLOCK_CHARS - buffer.chunks[last].length, data.length - offset);
		buffer.chunks[last] += data.slice(offset, offset + count);
		offset += count;
	}
	for (; offset < data.length; offset += REPLAY_BLOCK_CHARS) {
		buffer.chunks.push(data.slice(offset, offset + REPLAY_BLOCK_CHARS));
	}

	// 为保留完整的最近 200K 字符，首块可额外保留至多一个块减一个字符。
	const discardBlocks = Math.floor((buffer.length - MAX_TERMINAL_REPLAY_BUFFER) / REPLAY_BLOCK_CHARS);
	if (discardBlocks > 0) {
		buffer.chunks.splice(0, discardBlocks);
		buffer.length -= discardBlocks * REPLAY_BLOCK_CHARS;
	}
}

export function terminalReplayText(buffer: TerminalReplayBuffer): string {
	return buffer.chunks.join("");
}
