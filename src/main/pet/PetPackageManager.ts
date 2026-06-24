import { app } from "electron";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { Dirent } from "node:fs";
import type { PetManifest } from "../../shared/types";
// 内置宠物素材经 ?asset 导入：electron-vite 构建时复制到输出目录并返回运行时绝对路径，
// 打包后也能正确定位（与 index.ts:19 的 icon 导入同一机制）。
import builtinOtterSprite from "../../../build/pets/builtin-otter/spritesheet.webp?asset";

/**
 * PetPackageManager —— 宠物包管理（设计文档第 7 节）。
 *
 * 双轨来源：
 *  - builtin：随应用打包，经 ?asset 导入，离线可用、开箱即用；
 *  - petdex ：扫描 ~/.codex/pets/各包目录/pet.json，复用 Codex/petdex 社区生态（3000+）。
 *
 * 合并后按 id 去重，内置优先（社区包不得覆盖同 id 内置包）。
 *
 * spritesheetUrl 用 data: URL 传递（主进程读文件后 base64 内联），而非 file://。
 * 原因：dev 模式宠物窗从 http dev server 加载，Electron webSecurity 禁止 http 页面加载
 * file:// 本地资源；data: URL 无跨域限制，dev/prod 通用，且无需为 file:// 配置 CSP。
 */

/** 按扩展名推断 MIME */
function mimeOf(p: string): string {
	switch (extname(p).toLowerCase()) {
		case ".webp":
			return "image/webp";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".svg":
			return "image/svg+xml";
		case ".gif":
			return "image/gif";
		default:
			return "application/octet-stream";
	}
}

/** 读取图片文件并转成 data: URL；失败返回 null */
async function toDataUrl(p: string): Promise<string | null> {
	try {
		const buf = await readFile(p);
		return `data:${mimeOf(p)};base64,${buf.toString("base64")}`;
	} catch {
		return null;
	}
}

/** petdex pet.json 的最小结构 */
type PetDexManifest = {
	id: string;
	displayName?: string;
	description?: string;
	spritesheetPath: string;
};

/** 校验 spritesheet 文件存在且为常规文件，避免引用损坏包导致渲染层报错 */
async function fileExists(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isFile();
	} catch {
		return false;
	}
}

export class PetPackageManager {
	/** 内置包清单（元数据固定，spritesheet 走 ?asset 路径，list 时转 data URL） */
	private readonly builtinMeta: Array<Omit<PetManifest, "spritesheetUrl"> & { spritePath: string }> = [
		{
			id: "builtin-otter",
			displayName: "Boba Otter",
			description: "Pideck 内置水獭 · 随 Agent 状态变换",
			source: "builtin",
			spritePath: builtinOtterSprite,
		},
	];

	/** 列出所有可用宠物包：内置 + petdex 扫描，按 id 去重（内置优先） */
	async list(): Promise<PetManifest[]> {
		const byId = new Map<string, PetManifest>();

		// 内置包：读 sprite 文件转 data URL
		for (const m of this.builtinMeta) {
			const url = await toDataUrl(m.spritePath);
			if (!url) continue; // sprite 文件缺失则跳过该内置包
			byId.set(m.id, {
				id: m.id,
				displayName: m.displayName,
				description: m.description,
				source: m.source,
				spritesheetUrl: url,
			});
		}

		// 扫描 petdex 社区包：~/.codex/pets/各包目录/pet.json（三端统一用 app.getPath("home")）
		const petsRoot = join(app.getPath("home"), ".codex", "pets");
		let entries: Dirent[] = [];
		try {
			const { readdir } = await import("node:fs/promises");
			entries = await readdir(petsRoot, { withFileTypes: true });
		} catch {
			// 目录不存在视为无社区包，静默
			entries = [];
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(petsRoot, entry.name);
			const manifestPath = join(dir, "pet.json");
			try {
				const raw = await readFile(manifestPath, "utf8");
				const json = JSON.parse(raw) as PetDexManifest;
				if (!json.id || !json.spritesheetPath) continue;
				const spriteAbs = join(dir, json.spritesheetPath);
				if (!(await fileExists(spriteAbs))) continue;
				// 同 id 内置包优先，跳过社区包
				if (byId.has(json.id)) continue;
				const url = await toDataUrl(spriteAbs);
				if (!url) continue;
				byId.set(json.id, {
					id: json.id,
					displayName: json.displayName ?? json.id,
					description: json.description,
					source: "petdex",
					spritesheetUrl: url,
				});
			} catch {
				// 单个包解析失败不影响整体列表
			}
		}

		return [...byId.values()];
	}

	/** 按 id 查找单个 manifest */
	async get(id: string): Promise<PetManifest | null> {
		const all = await this.list();
		return all.find((m) => m.id === id) ?? null;
	}
}