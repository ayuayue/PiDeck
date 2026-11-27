import { randomUUID } from "node:crypto";
import { browserHtmlPreviewUrl, MAX_BROWSER_HTML_PREVIEW_BYTES } from "../../shared/htmlPreview";

const MAX_CACHED_BYTES = 4 * MAX_BROWSER_HTML_PREVIEW_BYTES;
const MAX_SNAPSHOTS = 32;
const snapshots = new Map<string, { html: string; bytes: number }>();
let cachedBytes = 0;

/** 存储已由工作台显式读取的 HTML 快照，向浏览器返回短地址。 */
export function stageBrowserHtmlSnapshot(fileName: string, html: string): string | null {
	const bytes = Buffer.byteLength(html, "utf8");
	if (bytes > MAX_BROWSER_HTML_PREVIEW_BYTES) return null;
	const url = browserHtmlPreviewUrl(fileName, randomUUID());
	if (!url) return null;
	while (snapshots.size >= MAX_SNAPSHOTS || cachedBytes + bytes > MAX_CACHED_BYTES) {
		const oldest = snapshots.entries().next().value;
		if (!oldest) break;
		snapshots.delete(oldest[0]);
		cachedBytes -= oldest[1].bytes;
	}
	snapshots.set(url, { html, bytes });
	cachedBytes += bytes;
	return url;
}

/** 读取并续存浏览器用过的快照，支持刷新及切回标签页。 */
export function readBrowserHtmlSnapshot(url: string): string | null {
	const key = url.split("#", 1)[0];
	const snapshot = snapshots.get(key);
	if (!snapshot) return null;
	snapshots.delete(key);
	snapshots.set(key, snapshot);
	return snapshot.html;
}
