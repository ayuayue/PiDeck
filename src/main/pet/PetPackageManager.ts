import { app } from "electron";
import { readFile, stat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, extname } from "node:path";
import type { PetManifest } from "../../shared/types";
import arthurSprite from "../../../build/pets/arthur-mergeon/spritesheet.webp?asset";
import clawdSprite from "../../../build/pets/clawd-3/spritesheet.webp?asset";

/**
 * PetPackageManager —— 内置 + petdex 双轨宠物包管理。
 * spritesheet 转 data: URL（避免 http→file:// 跨域）。
 */

function mimeOf(p: string): string {
	const ext = extname(p).toLowerCase();
	const map: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif" };
	return map[ext] ?? "application/octet-stream";
}

async function toDataUrl(p: string): Promise<string | null> {
	try {
		const buf = await readFile(p);
		return `data:${mimeOf(p)};base64,${buf.toString("base64")}`;
	} catch { return null; }
}

async function fileExists(p: string): Promise<boolean> {
	try { return (await stat(p)).isFile(); } catch { return false; }
}

type PetDexManifest = { id: string; displayName?: string; description?: string; spritesheetPath: string };

export class PetPackageManager {
	private readonly builtin = [
		{ id: "arthur-mergeon", displayName: "Arthur Mergeon", description: "A campfire code gunslinger, carrying old commits, open pull requests, and one hand always near the merge button.", spritePath: arthurSprite },
		{ id: "clawd", displayName: "Clawd", description: "A tiny pixel Clawd companion made from your sticker GIFs.", spritePath: clawdSprite },
	];

	async list(): Promise<PetManifest[]> {
		const byId = new Map<string, PetManifest>();

		// 内置包
		for (const m of this.builtin) {
			const url = await toDataUrl(m.spritePath);
			if (url) byId.set(m.id, { id: m.id, displayName: m.displayName, description: m.description, source: "builtin", spritesheetUrl: url });
		}

		// petdex 社区包：~/.codex/pets/<name>/pet.json
		const petsRoot = join(app.getPath("home"), ".codex", "pets");
		let entries: Dirent[] = [];
		try { entries = await readdir(petsRoot, { withFileTypes: true }); } catch { /* 目录不存在 */ }

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(petsRoot, entry.name);
			try {
				const raw = await readFile(join(dir, "pet.json"), "utf8");
				const json = JSON.parse(raw) as PetDexManifest;
				if (!json.id || !json.spritesheetPath) continue;
				const spriteAbs = join(dir, json.spritesheetPath);
				if (!(await fileExists(spriteAbs))) continue;
				if (byId.has(json.id)) continue; // 内置优先
				const url = await toDataUrl(spriteAbs);
				if (url) byId.set(json.id, { id: json.id, displayName: json.displayName ?? json.id, description: json.description, source: "petdex", spritesheetUrl: url });
			} catch { /* 单个包失败不影响整体 */ }
		}

		return [...byId.values()];
	}

	async get(id: string): Promise<PetManifest | null> {
		return (await this.list()).find(m => m.id === id) ?? null;
	}
}
