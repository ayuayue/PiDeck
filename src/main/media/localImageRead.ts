import { open } from "node:fs/promises";
import { LOCAL_IMAGE_MAX_BYTES, localImageMimeType } from "../../shared/localImage";
import { classifyLocalImagePath, isInsideAnyRoot, isLocalImageSizeAllowed } from "./localImageAccess";
import type { CanonicalRootsProvider } from "./localImageRoots";
import { nativeRealpath } from "./nativeRealpath";

/**
 * 本地图片字节读取（保存/复制用）。
 *
 * 为什么存在：展示走 `pideck-file://` 协议（`<img>` 直接加载）；但「保存/复制」要在渲染层拿到
 * **字节**，而 `fetch("pideck-file://…")` 在该 scheme 上不可用——`corsEnabled: false` 的
 * 自定义 scheme 会让渲染层 fetch 直接 `TypeError: Failed to fetch`（2026-10-20 e2e 实测：
 * 保存按钮只会弹失败提示）。所以这条读取走 IPC，判定逻辑与协议**完全复用**：
 * 形态闸 → native realpath → 白名单根 → 体积闸。
 *
 * 读不到返回 `{ ok: false, reason }`（不抛给渲染层）：保存/复制统一降级成「失败提示」，
 * 原因只进主进程 debug 日志（issue #535）。
 */

function safeRealpath(path: string): string | null {
	try {
		return nativeRealpath(path);
	} catch {
		return null;
	}
}

/**
 * 读不到的具体来由（issue #535 第二段）。
 *
 * 为什么不再统一返回 null：五种失败在界面上的表现完全一样（「图片加载失败」），
 * 日志里也没有一条，用户报「相对图片不显示」时无法区分「路径拼错」与「被白名单拒绝」。
 * 判定本身仍在这里做，渲染层拿到的还是 null；可读的原因只进主进程 debug 日志。
 */
export type LocalImageReadFailure =
	/** 形态闸拒绝：非绝对路径、控制字符、UNC 共享路径（`classifyLocalImagePath` 的 400/403）。 */
	| "shape"
	/** 扩展名不是图片。 */
	| "unsupported-type"
	/** `realpath` 失败：文件/目录不存在、权限不足、符号链接断链。 */
	| "unresolvable"
	/** 真实路径不在白名单根内（项目目录 / userData / 专属临时图片目录）。 */
	| "outside-roots"
	/** 打不开、不是普通文件，或读取中途失败。 */
	| "unreadable"
	/** 超过体积闸（32MiB）。 */
	| "too-large"
	/** stat 的长度与定长读取的结果不一致（读取期间被截断或改写）。 */
	| "length-mismatch";

export type LocalImageBytesResult = { ok: true; bytes: Uint8Array; mimeType: string } | { ok: false; reason: LocalImageReadFailure };

export type LocalImageByteFileResult = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: LocalImageReadFailure };

/**
 * 有界读取：先 stat 再按长度读，读完校验长度。
 *
 * 为什么不 `stat` 之后直接 `readFile`：两次系统调用之间文件可能被替换（TOCTOU），
 * 一个被换成超大文件的图片会让主进程整读进内存——体积闸就形同虚设。这里按 stat 的
 * 长度分配缓冲、`handle.read` 定长读取，读不满（文件变短/被改）直接判失败。
 * 协议（`<img>` 展示）与 IPC（保存/复制）共用这一份实现。
 */
export async function readBoundedImageFile(realPath: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const outcome = await readBoundedImageFileOutcome(realPath, maxBytes);
	return outcome.ok ? outcome.bytes : null;
}

/** `readBoundedImageFile` 的可诊断版本：同一次读取，失败时带回原因（协议侧仍只用上面的 null 口径）。 */
export async function readBoundedImageFileOutcome(realPath: string, maxBytes: number): Promise<LocalImageByteFileResult> {
	const handle = await open(realPath, "r").catch(() => null);
	if (!handle) return { ok: false, reason: "unreadable" };
	try {
		const info = await handle.stat();
		if (!info.isFile()) return { ok: false, reason: "unreadable" };
		if (!isLocalImageSizeAllowed(info.size) || info.size > maxBytes) return { ok: false, reason: "too-large" };
		const buffer = new Uint8Array(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return offset === buffer.length ? { ok: true, bytes: buffer } : { ok: false, reason: "length-mismatch" };
	} catch {
		return { ok: false, reason: "unreadable" };
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * 读一张白名单内的本地图片。
 * @param rawPath 渲染层给的绝对路径（不可信输入：所有闸门在这里重判一遍，不信任渲染层）。
 * @param resolveRoots 已规范化的白名单根（与 `pideck-file://` 协议共用一个提供者，见 `localImageRoots.ts`）。
 */
export async function readLocalImageBytes(rawPath: string, resolveRoots: CanonicalRootsProvider): Promise<LocalImageBytesResult> {
	const shape = classifyLocalImagePath(rawPath);
	// 403 只来自 UNC 共享路径与非图片扩展名；后者是「图片加载失败」最常见的成因，单独给一个原因。
	if (!shape.ok) return { ok: false, reason: shape.status === 403 ? "unsupported-type" : "shape" };
	const realPath = safeRealpath(shape.path);
	if (!realPath) return { ok: false, reason: "unresolvable" };
	const roots = await resolveRoots();
	if (!isInsideAnyRoot(realPath, roots)) return { ok: false, reason: "outside-roots" };
	const mimeType = localImageMimeType(realPath);
	if (!mimeType) return { ok: false, reason: "unsupported-type" };
	const file = await readBoundedImageFileOutcome(realPath, LOCAL_IMAGE_MAX_BYTES);
	if (!file.ok) return file;
	return { ok: true, bytes: file.bytes, mimeType };
}
