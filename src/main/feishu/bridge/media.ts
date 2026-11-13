/**
 * bridge/media — 飞书资源下载与群聊查询。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：图片/文件下载（含统一字节上界）、
 * 群信息与成员缓存、@提及判定、图片媒体类型嗅探。
 *
 * 宿主侧的连接句柄、bot open_id 与 locale 都是会变化的运行时状态（start/stop、
 * 配置热更新），所以经窄接口按调用取值，不持有快照。
 */

import type { FeishuGroupInfo, FeishuGroupMember, LarkClient } from "../types";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { logErr, warn } from "./bridgeLog";

const GROUP_CACHE_TTL = 3600_000;

/** 协作者对宿主的最小依赖面：只暴露会变化的运行时状态读取。 */
export type FeishuMediaHost = {
	client: () => LarkClient | null;
	botOpenId: () => string | null;
	locale: () => FeishuLocale;
};

export class FeishuMedia {
	private groupInfoCache = new Map<string, FeishuGroupInfo>();
	private userNameCache = new Map<string, string>();

	constructor(private readonly host: FeishuMediaHost) {}

	/** 断开连接：群/成员缓存按连接作废（与拆分前 stop() 的清空位置一致）。 */
	resetCaches(): void {
		this.groupInfoCache.clear();
		this.userNameCache.clear();
	}

	// ===== 图片/文件下载 =====

	async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
		if (!this.host.client()) throw new Error("飞书 Client 未初始化");
		try {
			return await this.downloadMessageResource(messageId, imageKey, "image");
		} catch {
			warn("[飞书 Bridge] messageResource 失败，回退到 image.get");
		}
		return this.downloadViaImageGet(imageKey);
	}
	private async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
		const resp = await this.host.client()!.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
		return this.streamToBuffer(resp);
	}
	private async downloadViaImageGet(imageKey: string): Promise<Buffer> {
		const resp = await this.host.client()!.request({ method: "GET", url: `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}` });
		return this.streamToBuffer(resp);
	}
	async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
		return this.downloadMessageResource(messageId, fileKey, "file");
	}

	/**
	 * 飞书资源（图片/文件）下载的统一字节上界：超限即中止流并抛错。
	 * 过去 streamToBuffer 无上界整流到内存，文件型 UX 拦截又发生在全量下载之后——
	 * 飞书侧一个超大附件就能把主进程内存打爆（与 filesReadContent 无界读同族）。
	 * 256MiB 覆盖 UX 允许的 200MiB 单文件上限（#427 追加二，与同类产品 100MB 上限对齐并留余量）；
	 * 图片路径过去完全没有检查，同样受此闸保护。
	 */
	private static readonly MAX_RESOURCE_DOWNLOAD_BYTES = 256 * 1024 * 1024;

	private async streamToBuffer(result: unknown): Promise<Buffer> {
		const resp = result as Record<string, unknown>;
		const cap = FeishuMedia.MAX_RESOURCE_DOWNLOAD_BYTES;
		if (typeof resp?.getReadableStream === "function") {
			const chunks: Buffer[] = [];
			let total = 0;
			const readable = (resp.getReadableStream as () => NodeJS.ReadableStream)();
			try {
				for await (const chunk of readable as AsyncIterable<Buffer | string>) {
					const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					total += piece.length;
					if (total > cap) throw new Error(`FEISHU_RESOURCE_TOO_LARGE:${total}`);
					chunks.push(piece);
				}
			} finally {
				// 中止后主动销毁底层流，避免连接与缓冲区泄漏（for-await 的 return() 只关迭代器）。
				const destroyable = readable as { destroy?: (err?: Error) => void };
				if (total > cap) destroyable.destroy?.(new Error("resource exceeds download budget"));
			}
			return Buffer.concat(chunks);
		}
		if (typeof (result as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function") {
			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of result as AsyncIterable<Buffer | string>) {
				const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				total += piece.length;
				if (total > cap) throw new Error(`FEISHU_RESOURCE_TOO_LARGE:${total}`);
				chunks.push(piece);
			}
			return Buffer.concat(chunks);
		}
		if (typeof resp?.writeFile === "function") {
			const { readFileSync, unlinkSync } = await import("node:fs");
			const tmp = `/tmp/feishu-dl-${Date.now()}.tmp`;
			await (resp.writeFile as (p: string) => Promise<void>)(tmp);
			const data = readFileSync(tmp);
			try {
				unlinkSync(tmp);
			} catch {}
			return data;
		}
		logErr("[飞书 Bridge] streamToBuffer 未知格式:", typeof result);
		throw new Error("无法读取飞书文件流");
	}

	// ===== 群聊辅助 =====

	isBotMentioned(mentions: Array<{ name: string; id: string | { open_id: string; union_id: string; user_id: string } }> | undefined): boolean {
		if (!mentions || mentions.length === 0) return false;
		for (const m of mentions) {
			const openId = typeof m.id === "string" ? m.id : m.id.open_id;
			if (openId === "all") continue;
			if (openId === this.host.botOpenId()) return true;
		}
		return false;
	}

	async getGroupInfo(chatId: string): Promise<FeishuGroupInfo | null> {
		const cached = this.groupInfoCache.get(chatId);
		if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL) return cached;
		if (!this.host.client()) return null;
		try {
			const [chatResp, members] = await Promise.all([this.host.client()!.im.chat.get({ path: { chat_id: chatId } }), this.fetchGroupMembers(chatId)]);
			const name = (chatResp as { data?: { name?: string } }).data?.name ?? feishuT(this.host.locale(), "group.unknown");
			const info: FeishuGroupInfo = { chatId, name, members, cachedAt: Date.now() };
			this.groupInfoCache.set(chatId, info);
			return info;
		} catch (e) {
			warn("[飞书 Bridge] 获取群聊信息失败:", e);
			return null;
		}
	}

	private async fetchGroupMembers(chatId: string): Promise<FeishuGroupMember[]> {
		if (!this.host.client()) return [];
		try {
			const resp = await this.host.client()!.im.chat.members.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id", page_size: 100 } });
			return ((resp as { data?: { items?: Array<{ open_id: string; name?: string }> } }).data?.items ?? []).map((m) => ({ openId: m.open_id, name: m.name ?? m.open_id }));
		} catch (e) {
			warn("[飞书 Bridge] 获取群成员失败:", e);
			return [];
		}
	}

	async getUserName(userId: string): Promise<string> {
		const cached = this.userNameCache.get(userId);
		if (cached) return cached;
		this.userNameCache.set(userId, userId);
		return userId;
	}

	inferImageMediaType(data: Buffer): string {
		if (data.length < 4) return "image/png";
		if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
		if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
		if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
		if (data[0] === 0x52 && data[1] === 0x49) return "image/webp";
		return "image/png";
	}
}
