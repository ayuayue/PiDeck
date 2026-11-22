import { createHash, randomBytes } from "node:crypto";
import type { RemoteTextDocument } from "../../shared/types/remoteFiles";
import { buildRemoteProjectFileCommand, REMOTE_PROJECT_TEXT_MAX_BYTES, validateRemoteProjectTextPath } from "./RemoteProjectFileCommands";
import type { RemoteProjectTextTransfer } from "./RemoteProjectTextTransfer";
import type { RemoteProjectUploadSession } from "./RemoteProjectUploadTransaction";
import { readRemoteSessionFileRevision, type RemoteSessionFileRevision } from "./RemoteSessionWriteGuard";

export type RemoteProjectFileTarget = { hostId: string; remotePath: string };
/** 文本命令 + SFTP 两条通道都要的那部分会话：命令只签发 revision，正文永远走 transfer。 */
export type RemoteProjectFileSession = RemoteProjectUploadSession & { nodePath: string; runCommand: (command: string) => Promise<{ exitCode: number; stdout: string }> };
type FileVersion = { sender: number; projectId: string; relative: string; target: RemoteProjectFileTarget; hostRevision: number; revision: RemoteSessionFileRevision; expires: number };
const VERSION_TTL_MS = 30 * 60 * 1000;
const MAX_VERSIONS = 128;
const CODES = new Set([
	"REMOTE_FILE_PATH_INVALID",
	"REMOTE_FILE_CHANGED",
	"REMOTE_FILE_NOT_FOUND",
	"REMOTE_FILE_TOO_LARGE",
	"REMOTE_FILE_PLATFORM_UNSUPPORTED",
	"REMOTE_FILE_INPUT_INVALID",
	"REMOTE_FILE_PERMISSION_DENIED",
	"REMOTE_FILE_COMMAND_FAILED",
	"REMOTE_FILE_TRANSFER_INVALID",
	"REMOTE_FILE_COMMIT_UNCONFIRMED",
	"SSH_HOST_NOT_READY",
	"SSH_HOST_DISCONNECTED",
]);
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 主进程持有版本快照；UI只拿不透明令牌，不可自报摘要/路径/归属。所有I/O走项目受控的pinned SSH。 */
export function createRemoteProjectFileService(ports: {
	locator: (projectId: string) => RemoteProjectFileTarget | undefined;
	withProject: <T>(target: RemoteProjectFileTarget, work: (session: RemoteProjectFileSession, capabilities: readonly string[] | undefined) => Promise<T>) => Promise<T>;
	transfer: RemoteProjectTextTransfer;
	now?: () => number;
}) {
	const versions = new Map<string, FileVersion>();
	const now = ports.now ?? Date.now;
	function prune() {
		for (const [token, entry] of versions) if (entry.expires <= now()) versions.delete(token);
	}
	function version(entry: Omit<FileVersion, "expires">): string {
		prune();
		if (versions.size >= MAX_VERSIONS) versions.delete(versions.keys().next().value ?? "");
		const token = randomBytes(16).toString("hex");
		versions.set(token, { ...entry, expires: now() + VERSION_TTL_MS });
		return token;
	}
	function target(sender: number, projectId: string, relative: string): RemoteProjectFileTarget {
		if (!Number.isSafeInteger(sender) || sender < 1 || typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("REMOTE_FILE_INPUT_INVALID");
		validateRemoteProjectTextPath(relative);
		const locator = ports.locator(projectId);
		if (!locator) throw new Error("REMOTE_PROJECT_NOT_FOUND");
		// ProjectStore可能原地重绑locator；令牌必须保存值快照，不能跟随那个对象漂移。
		return { hostId: locator.hostId, remotePath: locator.remotePath };
	}
	async function run(session: RemoteProjectFileSession, locator: RemoteProjectFileTarget, relative: string, command: Parameters<typeof buildRemoteProjectFileCommand>[0]["command"]) {
		const invocation = buildRemoteProjectFileCommand({ nodePath: session.nodePath, root: locator.remotePath, relative, nonce: randomBytes(16).toString("hex"), command });
		let value: unknown;
		try {
			const result = await session.runCommand(invocation.command);
			if (result.exitCode !== 0) throw new Error("REMOTE_FILE_COMMAND_FAILED");
			const start = result.stdout.indexOf(invocation.marker);
			if (start < 0) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
			value = JSON.parse(result.stdout.slice(start + invocation.marker.length));
		} catch (error) {
			if (error instanceof Error && CODES.has(error.message)) throw error;
			throw new Error("REMOTE_FILE_COMMAND_FAILED");
		}
		if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("REMOTE_FILE_TRANSFER_INVALID");
		if (!value.ok) throw new Error(typeof value.code === "string" && CODES.has(value.code) ? value.code : "REMOTE_FILE_COMMAND_FAILED");
		return value;
	}
	function readRevision(value: unknown): RemoteSessionFileRevision {
		try {
			return readRemoteSessionFileRevision(value, REMOTE_PROJECT_TEXT_MAX_BYTES);
		} catch {
			throw new Error("REMOTE_FILE_TRANSFER_INVALID");
		}
	}
	/**
	 * 一次完整的文本/二进制读：命令只取 revision 快照，正文由 SFTP 下载**一次**到本地私有临时文件。
	 *
	 * `maxBytes` 在**传输之前**拦截（快照已带 size）——先下载再判断等于把「文件多大」变成一次无界传输。
	 * 下载完成后在本地算摘要并与快照比对：两者不符说明远端在快照与传输之间变了，那是冲突（拒绝覆盖），
	 * 而不是「读坏了」。
	 */
	async function readBytes(session: RemoteProjectFileSession, locator: RemoteProjectFileTarget, relative: string, maxBytes?: number): Promise<{ bytes: Buffer; revision: RemoteSessionFileRevision }> {
		const revision = readRevision((await run(session, locator, relative, { operation: "snapshot" })).revision);
		if (maxBytes !== undefined && revision.size > maxBytes) throw new Error(`FILE_TOO_LARGE:${revision.size}:${Math.floor(maxBytes)}`);
		return { bytes: await ports.transfer.download({ session, canonicalRoot: locator.remotePath, relative, revision }), revision };
	}
	function text(bytes: Buffer): string {
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			if (content.includes("\0")) throw new Error();
		} catch {
			throw new Error("REMOTE_FILE_NOT_TEXT");
		}
		// CodeMirror需要一种明确换行模式；拒绝混合/裸CR，不能把原文件静默规整为LF。
		if (/\r(?!\n)/.test(content) || (content.includes("\r\n") && /(?<!\r)\n/.test(content))) throw new Error("REMOTE_FILE_LINE_ENDING_UNSUPPORTED");
		return content;
	}
	return {
		async open(sender: number, projectId: string, relative: string): Promise<RemoteTextDocument> {
			const locator = target(sender, projectId, relative);
			return ports.withProject(locator, async (session) => {
				const { bytes, revision } = await readBytes(session, locator, relative);
				return { content: text(bytes), version: version({ sender, projectId, relative, target: locator, hostRevision: session.hostRevision, revision }) };
			});
		},
		/**
		 * 远端二进制读（图片/PDF/Office/压缩包预览）：同一条通道，**不做 UTF-8 解码**，
		 * 直接回裸 base64（与 `files:read-base64` 本机分支同形，渲染层据此转 Blob URL）。
		 */
		async readBase64(sender: number, projectId: string, relative: string, maxBytes: number): Promise<string> {
			const locator = target(sender, projectId, relative);
			if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("REMOTE_FILE_INPUT_INVALID");
			return ports.withProject(locator, async (session) => (await readBytes(session, locator, relative, maxBytes)).bytes.toString("base64"));
		},
		async save(sender: number, projectId: string, relative: string, content: string, token: string): Promise<{ version: string }> {
			const locator = target(sender, projectId, relative);
			if (typeof content !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			if (content.length > REMOTE_PROJECT_TEXT_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
			const bytes = Buffer.from(content, "utf8");
			if (bytes.length > REMOTE_PROJECT_TEXT_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
			if (text(bytes) !== content) throw new Error("REMOTE_FILE_NOT_TEXT");
			prune();
			const entry = typeof token === "string" ? versions.get(token) : undefined;
			if (!entry || entry.sender !== sender || entry.projectId !== projectId || entry.relative !== relative || entry.target.hostId !== locator.hostId || entry.target.remotePath !== locator.remotePath) throw new Error("REMOTE_FILE_VERSION_INVALID");
			// 消耗令牌必须在任何await前：同一窗口重复保存/另一请求重用令牌都不能并行写。
			versions.delete(token);
			return ports.withProject(locator, async (session, capabilities) => {
				if (session.hostRevision !== entry.hostRevision) throw new Error("REMOTE_FILE_VERSION_INVALID");
				let observed: RemoteSessionFileRevision;
				try {
					observed = readRevision((await run(session, locator, relative, { operation: "snapshot" })).revision);
				} catch (error) {
					if (error instanceof Error && error.message === "REMOTE_FILE_NOT_FOUND") throw new Error("REMOTE_FILE_CHANGED");
					throw error;
				}
				if (JSON.stringify(observed) !== JSON.stringify(entry.revision)) throw new Error("REMOTE_FILE_CHANGED");
				// 整份正文经 SFTP 原子替换：helper 复核 expected，目标已变时明确拒绝，绝不重放。
				const { revision } = await ports.transfer.replace({ session, capabilities, canonicalRoot: locator.remotePath, relative, bytes, expected: entry.revision });
				if (revision.digest !== createHash("sha256").update(bytes).digest("hex") || revision.size !== bytes.length) throw new Error("REMOTE_FILE_TRANSFER_INVALID");
				return { version: version({ ...entry, revision }) };
			});
		},
		/** 窗口销毁撤销版本，快照不含正文；TTL和容量上限兜住未正常关闭的窗口。 */
		releaseSender(sender: number) {
			for (const [token, entry] of versions) if (entry.sender === sender) versions.delete(token);
		},
	};
}
export type RemoteProjectFileService = ReturnType<typeof createRemoteProjectFileService>;
