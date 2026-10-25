import { app } from "electron";
import { join } from "node:path";
import type { PetManifest } from "../../shared/types";
import { is } from "@electron-toolkit/utils";
import { PetPackageScanner, type BuiltinPetEntry } from "./petPackageScanner.ts";

/**
 * 宠物 sprite 资源路径：开发模式从项目 build/pets 目录读取（与 extraResources 的 from 一致），
 * 打包后从 process.resourcesPath/pets（extraResources 的 to）读取，
 * 避免将 6.2MB 的 webp 精灵图打包进 app.asar。
 */
function petResourcesDir(): string {
	const base = is.dev ? join(app.getAppPath(), "build") : process.resourcesPath;
	return join(base, "pets");
}

/** 内置宠物清单，spritePath 为运行时路径，构建时通过 extraResources 分发出 asar */
const BUILTIN_PETS = [{ id: "clawd", displayName: "Clawd", description: "A tiny pixel Clawd companion made from your sticker GIFs.", dir: "clawd-3", file: "spritesheet.webp" }];

/**
 * PetPackageManager —— 内置 + petdex 双轨宠物包管理。
 * 扫描/缓存逻辑在 PetPackageScanner（无 electron 依赖）：spritesheet 指纹未变时
 * 复用缓存；manifest 只带 pideck-pet:// 协议 URL（图片由协议 handler 按需读文件），
 * 不再经 IPC 搬运 base64 大字符串。
 */
export class PetPackageManager {
	private readonly resourcesRoot = petResourcesDir();
	private readonly petdexRoot = join(app.getPath("home"), ".codex", "pets");

	private readonly builtin: BuiltinPetEntry[] = BUILTIN_PETS.map((p) => ({
		id: p.id,
		displayName: p.displayName,
		description: p.description,
		spritePath: join(this.resourcesRoot, p.dir, p.file),
	}));

	private readonly scanner = new PetPackageScanner(this.builtin, this.petdexRoot);

	list(): Promise<PetManifest[]> {
		return this.scanner.list();
	}

	async get(id: string): Promise<PetManifest | null> {
		return (await this.scanner.list()).find((m) => m.id === id) ?? null;
	}

	/** petId → 雪碧图磁盘路径（pideck-pet:// 协议 handler 用）。 */
	resolveSpritePath(petId: string): Promise<string | null> {
		return this.scanner.resolveSpritePath(petId);
	}

	/** 协议允许读取的根目录（内置资源目录 + petdex 根）。 */
	spriteRoots(): string[] {
		return [this.resourcesRoot, this.petdexRoot];
	}
}
