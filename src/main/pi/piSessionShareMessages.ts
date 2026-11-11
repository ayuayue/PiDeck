import type { ChatMessage, SessionMessagePage } from "../../shared/types/session";

const LIMITS = { maxPages: 100, maxMessages: 5000, maxBytes: 4 * 1024 * 1024 };
type Ports = {
	readPage: (before?: number) => Promise<SessionMessagePage>;
	limits?: Partial<typeof LIMITS>;
};

/** 沿现有显示分页只读收集活动分支，保留编辑/删除语义；大会话明确标记为部分历史。 */
export async function collectPiSessionShareMessages(ports: Ports): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
	const limits = { ...LIMITS, ...ports.limits };
	const pages: ChatMessage[][] = [];
	let before: number | undefined;
	let version: string | undefined;
	let count = 0;
	let bytes = 0;
	let truncated = false;
	for (let pageIndex = 0; pageIndex < limits.maxPages; pageIndex += 1) {
		let page: SessionMessagePage;
		try {
			page = await ports.readPage(before);
		} catch {
			throw new Error("SESSION_SHARE_READ_FAILED");
		}
		if (page.unavailable || !Array.isArray(page.messages)) throw new Error("SESSION_SHARE_READ_FAILED");
		if (version !== undefined && page.indexVersion !== version) throw new Error("SESSION_SHARE_CHANGED");
		version = page.indexVersion;
		const retained: ChatMessage[] = [];
		// 保留最近消息；页内仍保持时间正序，超预算的更早消息不以“完整历史”名义交付。
		for (let i = page.messages.length - 1; i >= 0; i -= 1) {
			const message = page.messages[i];
			const size = Buffer.byteLength(JSON.stringify(message), "utf8");
			if (size > limits.maxBytes && count === 0) throw new Error("SESSION_SHARE_TOO_LARGE");
			if (count >= limits.maxMessages || bytes + size > limits.maxBytes) {
				truncated = true;
				break;
			}
			retained.unshift(message);
			count += 1;
			bytes += size;
		}
		pages.push(retained);
		if (truncated || page.nextBefore === null) break;
		const next = page.nextBefore;
		if (!Number.isSafeInteger(next) || next < 0 || (before !== undefined && next >= before)) throw new Error("SESSION_SHARE_READ_FAILED");
		before = next;
		if (pageIndex + 1 >= limits.maxPages || count >= limits.maxMessages || bytes >= limits.maxBytes) truncated = true;
		if (truncated) break;
	}
	const messages = pages.reverse().flat();
	return { messages, truncated };
}
