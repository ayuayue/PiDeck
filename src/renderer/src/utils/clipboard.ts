/**
 * 读取剪贴板纯文本。
 * 优先走 preload 暴露的主进程 clipboard 同步 API（不依赖 document focus）；
 * preview/降级环境返回空串。
 */
export function readClipboardText(): string {
	// window.piDesktop 类型来自 preload 的 typeof api；此处仅做能力探测，走 unknown 中转
	const pd = (window as unknown as { piDesktop?: { clipboard?: { readText?: () => string } } }).piDesktop;
	if (pd?.clipboard?.readText) {
		try {
			return pd.clipboard.readText();
		} catch {
			return "";
		}
	}
	return "";
}

/**
 * 读取剪贴板富文本 HTML；剪贴板无 HTML 内容时返回 null，调用方应降级纯文本。
 */
export function readClipboardHtml(): string | null {
	// 同上：能力探测走 unknown 中转，避免与 PiDesktopApi 精确类型冲突
	const pd = (window as unknown as { piDesktop?: { clipboard?: { readHtml?: () => string } } }).piDesktop;
	if (pd?.clipboard?.readHtml) {
		try {
			const html = pd.clipboard.readHtml();
			return html && html.trim() ? html : null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * 归一化空白后比较剪贴板 HTML 的纯文本形态与纯文本槽是否同源（纯函数，供单测）。
 * 允许富文本/纯文本复制源的细微空白差异（如 &nbsp;、行尾空格、多空格）。
 */
export function isClipboardHtmlConsistent(htmlPlain: string, text: string): boolean {
	return htmlPlain.replace(/\s+/g, " ") === text.replace(/\s+/g, " ");
}

/**
 * 一致性读取剪贴板 HTML：仅当 HTML 的纯文本形态与当前剪贴板纯文本同源时返回，否则返回 null。
 *
 * 背景：Windows 剪贴板按格式分槽存储——复制富文本（网页/Word）会同时写入 text 与 HTML 槽；
 * 之后再复制纯文本（记事本/终端只更新 text 槽）时 HTML 槽残留上一次富文本内容，
 * 直接 readClipboardHtml() 会粘出“旧内容”。调用方拿到 null 应降级为纯文本粘贴。
 */
export function readClipboardHtmlConsistent(): string | null {
	const html = readClipboardHtml();
	if (!html) return null;
	const text = readClipboardText();
	// 无纯文本槽时无从校验，信任 HTML（保持原行为，如剪贴板仅有 HTML 格式的场景）
	if (!text) return html;
	return isClipboardHtmlConsistent(htmlToPlainText(html), text) ? html : null;
}

/**
 * 将富文本 HTML 转为纯文本：块级标签/换行标签转 \n、剥除其余标签、还原常用实体。
 * 用于 textarea 的“原样粘贴”——保留复制源的段落/换行结构。
 */
export function htmlToPlainText(html: string): string {
	return (
		html
			.replace(/<br\s*\/?>/gi, "\n")
			// 标题开标签也产生换行（块级语义：标题前后都应断开）
			.replace(/<h[1-6]\s*>/gi, "\n")
			.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/**
 * 剪贴板写入工具函数。
 *
 * 优先使用 Electron 主进程 clipboard API（通过 preload 暴露），
 * 不依赖 document focus，避免 navigator.clipboard.writeText()
 * 在窗口失焦时抛 "Document is not focused" 异常。
 *
 * 在非 Electron 环境（preview / web）下回退到 Web Clipboard API。
 *
 * 返回是否写入成功：多数调用方 `void writeClipboard(x)` 忽略即可，但需要「已复制」反馈的
 * 调用方（toast 复制按钮 / MarkdownLink 复制路径 / DOM 降级 toast）必须按返回值决定要不要
 * 切勾号——写入失败还弹成功反馈比不弹更糟。
 */

export async function writeClipboard(text: string): Promise<boolean> {
	// 1. Electron 环境：通过 preload bridge 直接调用主进程 clipboard
	// （能力探测走 unknown 中转；preload 未暴露 writeText 时自然落到 Web API）
	const pd = (window as unknown as { piDesktop?: { clipboard?: { writeText: (t: string) => boolean | Promise<boolean> } } }).piDesktop;
	if (pd?.clipboard?.writeText) {
		try {
			// writeText 自 Electron 38 起是主进程 invoke（Promise<boolean>），旧同步实现可能直接返回 boolean。
			// 必须 await 后判真值：不 await 会把「还在写」当成功，且 invoke 的 rejection 变成未处理拒绝。
			if (await Promise.resolve(pd.clipboard.writeText(text))) return true;
		} catch {
			// preload bridge 写入失败，回退到 Web API
		}
	}

	// 2. Web Clipboard API（需要 document focus，但作为兜底）
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// 某些场景下 document 可能无焦点导致抛异常
	}

	// 3. 最后兜底：textarea + execCommand（已废弃但短期内仍可用）
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		textarea.style.pointerEvents = "none";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(textarea);
		return ok;
	} catch {
		// 所有方式均失败：返回 false，由调用方决定不展示成功反馈（不在此处弹二次错误）
		return false;
	}
}

function desktopClipboard() {
	// window.piDesktop 类型来自 preload；能力探测走 unknown 中转，避免与 PiDesktopApi 精确类型冲突。
	// writeImage 在 Electron 38 起是主进程 invoke，必须按 Promise 处理；旧同步实现仍可能返回 boolean。
	return (
		window as unknown as {
			piDesktop?: {
				clipboard?: { writeImage?: (dataUrl: string) => boolean | Promise<boolean> };
				app?: {
					rendererLog?: (level: "info" | "warn" | "error", scope: string, message: string, detail?: unknown) => Promise<void>;
				};
			};
		}
	).piDesktop;
}

function logClipboardImageFailure(message: string, detail?: unknown) {
	// 复制图片失败原先既不 toast 原因也不写 log，排查只能靠猜；这里至少落 renderer 日志。
	void desktopClipboard()
		?.app?.rendererLog?.("warn", "clipboard", message, detail)
		.catch(() => undefined);
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
	return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * 把 PNG/JPEG data URL 或截图 Blob 写入系统剪贴板。
 * Electron 下优先走 preload writeImage（不依赖 document focus / ClipboardItem 权限）；
 * 失败才回退 Web ClipboardItem。任一路径失败都返回 false 并写 renderer log。
 */
export async function writeClipboardImage(source: string | Blob): Promise<boolean> {
	let dataUrl = "";
	try {
		dataUrl = typeof source === "string" ? source : await blobToDataUrl(source);
	} catch (error) {
		logClipboardImageFailure("encode clipboard image failed", error);
		return false;
	}
	if (!dataUrl.startsWith("data:image/")) {
		logClipboardImageFailure("clipboard image payload is empty or not an image");
		return false;
	}

	const writeImage = desktopClipboard()?.clipboard?.writeImage;
	if (writeImage) {
		try {
			// Promise.resolve：兼容主进程异步 IPC 与单测里的同步 stub。
			// 不能把 Promise 当 boolean，否则会把“还在写”误判成成功。
			if (await Promise.resolve(writeImage(dataUrl))) return true;
			logClipboardImageFailure("native writeImage returned false");
		} catch (error) {
			logClipboardImageFailure("native writeImage threw", error);
		}
	}

	if (!navigator.clipboard?.write) {
		logClipboardImageFailure("ClipboardItem write is unavailable");
		return false;
	}
	try {
		const blob =
			typeof source !== "string"
				? source
				: new Blob([Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) => char.charCodeAt(0))], {
						type: dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png",
					});
		await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
		return true;
	} catch (error) {
		logClipboardImageFailure("ClipboardItem write failed", error);
		return false;
	}
}
