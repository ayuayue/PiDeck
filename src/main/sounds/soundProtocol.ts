/**
 * pideck-sound:// 协议：为渲染层 `<audio>` 提供自定义音频文件。
 *
 * 只服务 `pideck-sound://custom/<文件名>` 这一种形态（预设音效由 Vite 打包进
 * renderer assets，走普通 asset URL，不需要协议）；文件名经过
 * isAllowedCustomSoundName + resolveCustomSoundPath 双重白名单校验，
 * 防止 ../ 逃逸与任意文件读取。
 */
import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { resolveCustomSoundPath } from "./SoundFileStore";

function mimeOf(file: string): string {
	const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	switch (ext) {
		case "wav": return "audio/wav";
		case "mp3": return "audio/mpeg";
		case "ogg": return "audio/ogg";
		case "m4a": return "audio/mp4";
		case "flac": return "audio/flac";
		default: return "application/octet-stream";
	}
}

/** 解析 pideck-sound://custom/<name> 中的文件名（URL 编码还原）。 */
function parseCustomSoundName(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "custom") return null;
		const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
		return name || null;
	} catch {
		return null;
	}
}

export function registerSoundProtocol(): void {
	protocol.handle("pideck-sound", async (request) => {
		const name = parseCustomSoundName(request.url);
		if (!name) return new Response("forbidden", { status: 403 });
		const file = resolveCustomSoundPath(name);
		if (!file) return new Response("forbidden", { status: 403 });
		try {
			const data = await readFile(file);
			return new Response(data, { headers: { "Content-Type": mimeOf(file) } });
		} catch {
			return new Response("not found", { status: 404 });
		}
	});
}
