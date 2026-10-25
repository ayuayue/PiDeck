import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { WALLPAPER_ENGINE_ID_RE, parseByteRange, parseWallpaperEngineProject, wallpaperEngineDirCandidates, wallpaperEngineVideoMime, type WallpaperEngineItem, type WallpaperEngineListResult } from "../../shared/wallpaperEngine";

/** 单个工坊目录最多扫描的条目数：防止误选巨大目录时卡住主进程。 */
const MAX_SCAN_ENTRIES = 2000;
/** project.json 体积上界（正常只有几 KB） */
const MAX_PROJECT_BYTES = 256 * 1024;
/** 预览图体积上界 */
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const PREVIEW_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

/** 读取并解析某个条目的 project.json；不存在/过大/非 video 均为 null。 */
export async function readWallpaperEngineItem(dir: string, id: string): Promise<WallpaperEngineItem | null> {
	if (!dir || !WALLPAPER_ENGINE_ID_RE.test(id)) return null;
	try {
		const file = join(dir, id, "project.json");
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_PROJECT_BYTES) return null;
		return parseWallpaperEngineProject(id, await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

/** 列出工坊目录下全部可用的视频壁纸（只返回元数据，不含绝对路径）。 */
export async function listWallpaperEngineItems(dir: string): Promise<WallpaperEngineListResult> {
	if (!dir) return { dir: "", items: [], error: "no-dir" };
	let names: string[];
	try {
		names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && WALLPAPER_ENGINE_ID_RE.test(d.name)).map((d) => d.name);
	} catch {
		return { dir, items: [], error: "unreadable" };
	}
	const items: WallpaperEngineItem[] = [];
	for (const id of names.slice(0, MAX_SCAN_ENTRIES)) {
		const item = await readWallpaperEngineItem(dir, id);
		if (item) items.push(item);
	}
	items.sort((a, b) => a.title.localeCompare(b.title));
	return { dir, items };
}

/**
 * 把条目内相对文件解析成真实路径，并确认（含符号链接解析后）仍位于 <dir>/<id>/ 内。
 * 任何逃逸都返回 null。
 */
/**
 * 把用户手选的目录归一化到工坊内容目录（.../steamapps/workshop/content/431960）：
 * 选 Steam 根、steamapps、workshop、workshop/content 都能命中；都不命中时原样返回（可能是自建的条目目录）。
 */
export async function resolveWorkshopContentDir(picked: string): Promise<string> {
	for (const candidate of wallpaperEngineDirCandidates(picked, join)) {
		try {
			if ((await stat(candidate)).isDirectory()) return candidate;
		} catch {
			// 候选不存在：继续下一个
		}
	}
	return picked;
}

export async function resolveInsideItem(dir: string, id: string, rel: string): Promise<string | null> {
	try {
		const root = await realpath(resolve(dir, id));
		const target = await realpath(resolve(root, rel));
		return target.startsWith(root + sep) ? target : null;
	} catch {
		return null;
	}
}

function parseRequest(url: string): { kind: "video" | "preview"; id: string } | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "video" && parsed.hostname !== "preview") return null;
		const id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
		return WALLPAPER_ENGINE_ID_RE.test(id) ? { kind: parsed.hostname, id } : null;
	} catch {
		return null;
	}
}

/**
 * pideck-we:// 处理器（不依赖 electron，便于单测）：
 * - pideck-we://video/<id>：按 project.json 的 file 流式输出，支持单区间 Range（206）；
 * - pideck-we://preview/<id>：输出 preview 图。
 * 只服务当前设置里的工坊目录，且只服务「当前选中」的 id 或列表预览，ID 走白名单。
 */
export function createWallpaperEngineHandler(getDir: () => string): (request: Request) => Promise<Response> {
	return async (request) => {
		const req = parseRequest(request.url);
		if (!req) return new Response("forbidden", { status: 403 });
		const dir = getDir();
		const item = await readWallpaperEngineItem(dir, req.id);
		if (!item) return new Response("not found", { status: 404 });
		const rel = req.kind === "video" ? item.file : item.preview;
		if (!rel) return new Response("not found", { status: 404 });
		const file = await resolveInsideItem(dir, req.id, rel);
		if (!file) return new Response("forbidden", { status: 403 });
		let size: number;
		try {
			const info = await stat(file);
			if (!info.isFile()) return new Response("not found", { status: 404 });
			size = info.size;
		} catch {
			return new Response("not found", { status: 404 });
		}
		if (req.kind === "preview") {
			const mime = PREVIEW_MIME[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()];
			if (!mime || size > MAX_PREVIEW_BYTES) return new Response("unsupported", { status: 415 });
			return new Response(await readFile(file), { headers: { "Content-Type": mime } });
		}
		const mime = wallpaperEngineVideoMime(rel) ?? "application/octet-stream";
		const range = parseByteRange(request.headers.get("range"), size);
		if (range) {
			const stream = createReadStream(file, { start: range.start, end: range.end });
			return new Response(Readable.toWeb(stream) as ReadableStream, {
				status: 206,
				headers: { "Content-Type": mime, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Accept-Ranges": "bytes" },
			});
		}
		const stream = createReadStream(file);
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			status: 200,
			headers: { "Content-Type": mime, "Content-Length": String(size), "Accept-Ranges": "bytes" },
		});
	};
}
