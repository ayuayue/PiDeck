/**
 * 模型 API 响应正文的字节上界读取（主进程）。
 *
 * 为什么集中：生图、语音转写、用量探针原先各自写了一份「边读边数、超限怎么办」，
 * 语义还分两派——
 *   - truncate：超限保留前 maxBytes（用量探针，仍要尽量解析出余额/诊断信息）
 *   - reject：超限整体作废（生图 base64、语音 JSON，半截数据无法使用）
 * 这里把泵体留一份，两种语义作为参数，调用点各自声明。
 *
 * ⚠️ 故意用 `getReader().read()` 循环而非 `for await`：本模块会被 vm 沙箱加载
 * （tests/imageGenService.test.mjs），沙箱与宿主的 `Symbol.asyncIterator` 分属
 * 不同 realm，for-await 跨 realm 不可靠。
 */

/** 最小响应形状：生产是 fetch Response；测试替身可能只有 arrayBuffer。 */
export type BoundedResponseLike = {
	headers?: { get?(name: string): string | null } | null;
	body?: { getReader?(): BoundedBodyReader } | null;
	arrayBuffer?(): Promise<ArrayBuffer>;
};

type BoundedBodyReader = {
	read(): Promise<{ done: boolean; value?: unknown }>;
	cancel?(): Promise<void>;
};

/** 超限语义：truncate = 保留前 maxBytes；reject = 整体作废（返回 null）。 */
export type BoundedOverflow = "truncate" | "reject";

export type BoundedBody = {
	bytes: Buffer;
	/** 因超限被截断（只有 truncate 语义可能为 true）。 */
	truncated: boolean;
};

/** 读完整正文（最多 maxBytes）。reject 语义超限返回 null。 */
export async function readBoundedBody(response: BoundedResponseLike | null | undefined, maxBytes: number, overflow: BoundedOverflow): Promise<BoundedBody | null> {
	if (!response) return null;
	// declare-length 只在 reject 语义下能提前判定：truncate 仍要读满前 maxBytes 才有内容可解析。
	if (overflow === "reject") {
		const declaredLength = Number(response.headers?.get?.("content-length") ?? "0");
		if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
	}
	const body = response.body;
	if (body && typeof body.getReader === "function") {
		return readStreamBody(body.getReader(), maxBytes, overflow);
	}
	// 无流式 body 的替身/受限运行时：整体读取后校验（生产 fetch 必有 body）
	if (typeof response.arrayBuffer !== "function") return null;
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength <= maxBytes) return { bytes: buffer, truncated: false };
	if (overflow === "truncate") return { bytes: buffer.subarray(0, maxBytes), truncated: true };
	return null;
}

async function readStreamBody(reader: BoundedBodyReader, maxBytes: number, overflow: BoundedOverflow): Promise<BoundedBody | null> {
	const chunks: Buffer[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value || typeof (value as { byteLength?: unknown }).byteLength !== "number") continue;
		const chunk = value as Uint8Array;
		if (chunk.byteLength === 0) continue;
		const remaining = maxBytes - total;
		if (chunk.byteLength > remaining) {
			if (overflow === "truncate" && remaining > 0) chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, remaining));
			try {
				await reader.cancel?.();
			} catch {
				// 连接已随取消关闭
			}
			return overflow === "truncate" ? { bytes: Buffer.concat(chunks), truncated: true } : null;
		}
		chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		total += chunk.byteLength;
	}
	return { bytes: Buffer.concat(chunks), truncated: false };
}

/** 读成 UTF-8 文本：truncate 语义（超限保留前 maxBytes）。 */
export async function readBoundedText(response: BoundedResponseLike | null | undefined, maxBytes: number): Promise<string> {
	const body = await readBoundedBody(response, maxBytes, "truncate");
	return body ? body.bytes.toString("utf8") : "";
}

/** 读成 UTF-8 文本：reject 语义（超限返回 null）。 */
export async function readBoundedTextOrNull(response: BoundedResponseLike | null | undefined, maxBytes: number): Promise<string | null> {
	const body = await readBoundedBody(response, maxBytes, "reject");
	return body ? body.bytes.toString("utf8") : null;
}

/** 读成字节：reject 语义（超限返回 null）。 */
export async function readBoundedBytesOrNull(response: BoundedResponseLike | null | undefined, maxBytes: number): Promise<Buffer | null> {
	const body = await readBoundedBody(response, maxBytes, "reject");
	return body ? body.bytes : null;
}

/**
 * 增量字节累加器：给事件流通道（Electron ClientRequest）用。
 * 语义与 `readBoundedBody(..., "truncate")` 一致：超限后停止累计、标记 truncated。
 */
export function createBoundedAccumulator(maxBytes: number) {
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	return {
		push(chunk: Buffer): void {
			if (truncated) return;
			const remaining = maxBytes - total;
			if (chunk.length > remaining) {
				if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
		},
		get truncated(): boolean {
			return truncated;
		},
		finish(): BoundedBody {
			return { bytes: Buffer.concat(chunks), truncated };
		},
	};
}
