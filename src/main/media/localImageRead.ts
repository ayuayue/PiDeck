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
 * 读不到返回 null（不抛给渲染层）：保存/复制统一降级成「失败提示」。
 */

function safeRealpath(path: string): string | null {
	try {
		return nativeRealpath(path);
	} catch {
		return null;
	}
}

export type LocalImageBytesResult = { bytes: Uint8Array; mimeType: string } | null;

/**
 * 有界读取：先 stat 再按长度读，读完校验长度。
 *
 * 为什么不 `stat` 之后直接 `readFile`：两次系统调用之间文件可能被替换（TOCTOU），
 * 一个被换成超大文件的图片会让主进程整读进内存——体积闸就形同虚设。这里按 stat 的
 * 长度分配缓冲、`handle.read` 定长读取，读不满（文件变短/被改）直接判失败。
 * 协议（`<img>` 展示）与 IPC（保存/复制）共用这一份实现。
 */
export async function readBoundedImageFile(realPath: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const handle = await open(realPath, "r").catch(() => null);
	if (!handle) return null;
	try {
		const info = await handle.stat();
		if (!info.isFile() || !isLocalImageSizeAllowed(info.size) || info.size > maxBytes) return null;
		const buffer = new Uint8Array(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return offset === buffer.length ? buffer : null;
	} catch {
		return null;
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
	if (!shape.ok) return null;
	const realPath = safeRealpath(shape.path);
	if (!realPath) return null;
	const roots = await resolveRoots();
	if (!isInsideAnyRoot(realPath, roots)) return null;
	const mimeType = localImageMimeType(realPath);
	if (!mimeType) return null;
	const bytes = await readBoundedImageFile(realPath, LOCAL_IMAGE_MAX_BYTES);
	return bytes ? { bytes, mimeType } : null;
}
