import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SESSION_SHARE_OPTIONS, type SessionShareOptions, type SessionSharePrepareInput, type SessionSharePreview, type SessionShareResult } from "../../shared/types/sessionExport";
import { buildSessionShareHtml, type SessionShareCopy, type SessionShareSource } from "./sessionShareExport";

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEWS = 4;
const PREVIEW_TTL_MS = 15 * 60_000;

type PreviewArtifact = { owner: number; html: string; createdAt: number };
type Deps = {
	load: (sessionId: string, options: SessionShareOptions) => Promise<SessionShareSource>;
	resolveExportDir: () => string;
	home: () => string;
	copy: () => SessionShareCopy;
	now?: () => number;
};

/** IPC 边界的精确选项校验：不能把 truthy 字符串或未知字段当成已选择的安全策略。 */
function validInput(value: unknown): value is SessionSharePrepareInput {
	if (!value || typeof value !== "object" || !("sessionId" in value) || typeof value.sessionId !== "string" || !value.sessionId.trim() || value.sessionId.length > 256 || !("options" in value)) return false;
	const options = value.options;
	if (!options || typeof options !== "object" || Array.isArray(options)) return false;
	const keys = Object.keys(DEFAULT_SESSION_SHARE_OPTIONS);
	return Object.keys(options).length === keys.length && keys.every((key) => key in options && typeof Reflect.get(options, key) === "boolean");
}

/** 主进程短期保存的只有已处理产物；确认保存消费同一字节串，不重读会话也不信任 renderer HTML。 */
export class SessionShareExportService {
	private readonly previews = new Map<string, PreviewArtifact>();
	private readonly preparing = new Set<number>();
	private readonly now: () => number;

	constructor(private readonly deps: Deps) {
		this.now = deps.now ?? Date.now;
	}

	async prepare(owner: number, input: unknown): Promise<SessionShareResult<SessionSharePreview>> {
		if (!Number.isSafeInteger(owner) || owner < 1 || !validInput(input)) return { ok: false, error: "SESSION_SHARE_INVALID_INPUT" };
		this.prune();
		if (this.preparing.has(owner) || this.preparing.size >= MAX_PREVIEWS) return { ok: false, error: "SESSION_SHARE_BUSY" };
		this.preparing.add(owner);
		this.releaseOwner(owner);
		try {
			const source = await this.deps.load(input.sessionId, input.options);
			if (source.backend !== "pi" && source.backend !== "dsh") throw new Error("SESSION_SHARE_UNSUPPORTED");
			const rendered = buildSessionShareHtml(source, input.options, { home: this.deps.home(), exportedAt: this.now(), copy: this.deps.copy() });
			if (Buffer.byteLength(rendered.html, "utf8") > MAX_HTML_BYTES) return { ok: false, error: "SESSION_SHARE_TOO_LARGE" };
			while (this.previews.size >= MAX_PREVIEWS) {
				const oldest = this.previews.keys().next().value;
				if (oldest !== undefined) this.previews.delete(oldest);
			}
			const previewId = randomUUID();
			this.previews.set(previewId, { owner, html: rendered.html, createdAt: this.now() });
			return { ok: true, value: { previewId, backend: source.backend, ...rendered, truncated: source.truncated } };
		} catch (error) {
			const code = error instanceof Error && /^SESSION_SHARE_[A-Z_]+$/.test(error.message) ? error.message : "SESSION_SHARE_READ_FAILED";
			return { ok: false, error: code };
		} finally {
			this.preparing.delete(owner);
		}
	}

	async save(owner: number, previewId: unknown): Promise<SessionShareResult<{ path: string }>> {
		this.prune();
		if (typeof previewId !== "string") return { ok: false, error: "SESSION_SHARE_PREVIEW_EXPIRED" };
		const artifact = this.previews.get(previewId);
		if (!artifact || artifact.owner !== owner) return { ok: false, error: "SESSION_SHARE_PREVIEW_EXPIRED" };
		// 在第一个异步写盘之前消费令牌，双击/并发 invoke 不能保存两份。
		this.previews.delete(previewId);
		try {
			const dir = this.deps.resolveExportDir();
			await mkdir(dir, { recursive: true });
			// 固定前缀 + main 生成的 UUID，排他新建，既不含会话标题/路径，也不覆盖已有导出。
			const path = join(dir, `shared-session-${randomUUID()}.html`);
			await writeFile(path, artifact.html, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return { ok: true, value: { path } };
		} catch {
			// 写失败仍允许用户重试同一份已审阅字节，不重读来源。
			this.previews.set(previewId, artifact);
			return { ok: false, error: "SESSION_SHARE_WRITE_FAILED" };
		}
	}

	release(owner: number, previewId: unknown): void {
		if (typeof previewId === "string" && this.previews.get(previewId)?.owner === owner) this.previews.delete(previewId);
	}

	releaseOwner(owner: number): void {
		for (const [id, artifact] of this.previews) if (artifact.owner === owner) this.previews.delete(id);
	}

	private prune(): void {
		for (const [id, artifact] of this.previews) if (this.now() - artifact.createdAt >= PREVIEW_TTL_MS) this.previews.delete(id);
	}
}
