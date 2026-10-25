/**
 * stdio NDJSON 行泵（Buffer 分段版，PiRpcClient / AcpConnection 共用）。
 *
 * 为什么分段（2027-02 性能审计）：字符串实现 `buffer += chunk` 后立即
 * `indexOf("\n")`——V8 对 cons-string 的 indexOf 要先整段扁平化，每个 data
 * 事件都对已累积全长做一次拷贝+分配，单行响应成本 O(B²/chunkSize)；pi 的大
 * tool_result / get_entries 帧（上限 8MiB）与失控输出都会命中。
 *
 * 分段语义：LF（0x0A）按字节查找，绝不出现在 UTF-8 多字节序列内部，跨 chunk
 * 的多字节字符随完整行一次性 toString，不丢字节；已扫过无 LF 的头块不重扫
 * （headSearchedBytes 只对头块生效——其余块要么整块消费、要么是刚到达当轮
 * 已扫过的尾块）。行尾单个 \r 剥离（NDJSON 对 CRLF 的标准容忍）。
 *
 * 溢出/关闭策略不在泵内：调用方按各自协议语义处理（pi 丢缓冲报协议错误、
 * ACP 先切行再看剩余再关连接），泵只提供 bufferedBytes / reset / end。
 */
export type NdjsonLinePump = {
	/** 喂入一个 stdout data chunk（Buffer 或 string），内部完成切行分发。 */
	push(chunk: Buffer | string): void;
	/** 流结束：剩余字节（即使无 LF）作为最后一行吐出后清空。 */
	end(): void;
	/** 清空缓冲，返回丢弃的字节数（协议错误/关闭路径用）。 */
	reset(): number;
	/** 当前未成行缓冲的字节数。 */
	readonly bufferedBytes: number;
};

/**
 * @param onLine 每条完整行（已剥 \r）回调；返回 false 时中止本轮切行
 *   （消费方在回调里关闭连接的场景——对应旧 drainLines 的 while(!closed)）。
 */
export function createNdjsonLinePump(onLine: (line: string) => boolean | void): NdjsonLinePump {
	let chunks: Buffer[] = [];
	let totalBytes = 0;
	let headSearched = 0;

	const dispatch = (line: Buffer): boolean => {
		// 行尾单个 \r 剥离（CRLF 容忍）；空行照常分发，由消费方决定跳过
		const body = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
		return onLine(body.toString("utf8")) !== false;
	};

	const drain = (): void => {
		for (;;) {
			// LF 只可能在头块（从已扫边界起）或刚追加的尾块（见模块头注释的不变式）
			const head = chunks[0];
			const headLf = head ? head.indexOf(0x0a, headSearched) : -1;
			if (headLf !== -1) {
				const line = head.subarray(0, headLf);
				const rest = head.subarray(headLf + 1);
				totalBytes -= headLf + 1;
				if (rest.length > 0) {
					chunks[0] = rest;
					headSearched = 0;
				} else {
					chunks.shift();
					headSearched = 0;
				}
				if (!dispatch(line)) return;
				continue;
			}
			if (chunks.length > 1) {
				const lastIdx = chunks.length - 1;
				const last = chunks[lastIdx];
				const lastLf = last.indexOf(0x0a);
				if (lastLf !== -1) {
					// 行跨多块：中间块按不变式整块 LF-free，concat 一次（每行 O(行长)）
					const parts = chunks.slice();
					parts[lastIdx] = last.subarray(0, lastLf);
					const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
					totalBytes -= line.length + 1;
					const rest = last.subarray(lastLf + 1);
					if (rest.length > 0) chunks = [rest];
					else chunks = [];
					headSearched = 0;
					if (!dispatch(line)) return;
					continue;
				}
			}
			headSearched = head ? head.length : 0;
			return;
		}
	};

	return {
		push(chunk: Buffer | string): void {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			if (bytes.length === 0) return;
			chunks.push(bytes);
			totalBytes += bytes.length;
			drain();
		},
		end(): void {
			if (chunks.length === 0) return;
			const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
			chunks = [];
			totalBytes = 0;
			headSearched = 0;
			// 结束时的残行不剥头部（已是完整字节序列）；\r 照常剥
			dispatch(line);
		},
		reset(): number {
			const dropped = totalBytes;
			chunks = [];
			totalBytes = 0;
			headSearched = 0;
			return dropped;
		},
		get bufferedBytes(): number {
			return totalBytes;
		},
	};
}
