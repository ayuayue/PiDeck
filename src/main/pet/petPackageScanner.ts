/**
 * 宠物包扫描器（纯逻辑，无 electron 依赖，可单测）。
 *
 * 性能背景：宠物 spritesheet 是 webp（内置 clawd 一张）。旧实现把整图
 * base64 成 data URL 放进 manifest，经 IPC 传输给渲染层——设置页每次打开/进入
 * 宠物 tab、以及切换宠物时推送宠物窗，都要搬运 ~10MB 字符串。
 *
 * 现在 manifest 只携带轻量元数据 + pideck-pet:// 协议 URL（<img> 由主进程协议
 * handler 按需流式读文件），IPC 传输从 MB 级降到 KB 级。
 *
 * 缓存策略（内存，按文件指纹失效）：
 * - 指纹 = 内置雪碧图 + petdex 目录列表 + 每个 pet.json 的 mtimeMs:size（纯元数据）；
 * - 指纹不变 → 直接返回缓存结果，零 IO；指纹变化 → 全量重扫；
 * - 单飞：并发 list() 共享同一次扫描。
 *
 * 已知边界（可接受）：仅替换雪碧图内容而未改动 pet.json/目录（mtime 也回滚）时
 * 指纹不失效，需重启应用生效；pet.json 内容修改会因 mtime 变化而正确失效。
 */
import { readFile, stat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PetManifest } from "../../shared/types";
import { petSpriteUrl } from "./petSpriteUrl.ts";

export type BuiltinPetEntry = {
	id: string;
	displayName: string;
	description: string;
	spritePath: string;
};

type PetDexManifest = { id: string; displayName?: string; description?: string; spritesheetPath: string };

export { petSpriteUrl, spriteMimeOf } from "./petSpriteUrl.ts";

async function fileExists(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isFile();
	} catch {
		return false;
	}
}

/** 文件指纹（mtimeMs + size）；不存在/不可读时标记 missing（出现或恢复会触发失效）。 */
async function fileFingerprint(p: string): Promise<string> {
	try {
		const s = await stat(p);
		return `${p}:${s.mtimeMs}:${s.size}`;
	} catch {
		return `${p}:missing`;
	}
}

export class PetPackageScanner {
	private readonly builtin: BuiltinPetEntry[];
	private readonly petsRoot: string;
	private cachedList: PetManifest[] | null = null;
	private cachedFingerprint = "";
	private pendingList: Promise<PetManifest[]> | null = null;
	/** 最近一次扫描的 petId → 磁盘绝对路径（协议 handler 反查用，随扫描更新） */
	private idToPath = new Map<string, string>();

	constructor(builtin: BuiltinPetEntry[], petsRoot: string) {
		this.builtin = builtin;
		this.petsRoot = petsRoot;
	}

	/** 宠物清单（缓存 + 单飞）：指纹未变时零 IO 返回缓存结果。 */
	list(): Promise<PetManifest[]> {
		if (this.pendingList) return this.pendingList;
		this.pendingList = this.doList().finally(() => {
			this.pendingList = null;
		});
		return this.pendingList;
	}

	/**
	 * petId → 雪碧图磁盘路径（协议 handler 用）。
	 * 未扫描过时先触发一次 list()；未知 id 返回 null。
	 */
	async resolveSpritePath(petId: string): Promise<string | null> {
		if (!this.idToPath.has(petId) && this.cachedList === null) {
			await this.list();
		}
		return this.idToPath.get(petId) ?? null;
	}

	private async doList(): Promise<PetManifest[]> {
		const fingerprint = await this.computeFingerprint();
		if (this.cachedList && fingerprint === this.cachedFingerprint) {
			return this.cachedList;
		}
		const manifests = await this.scan();
		this.cachedList = manifests;
		this.cachedFingerprint = fingerprint;
		return manifests;
	}

	/** 指纹：内置雪碧图 + petdex 目录列表 + 各 pet.json（全元数据，不读文件内容）。 */
	private async computeFingerprint(): Promise<string> {
		const parts: string[] = [];
		for (const m of this.builtin) {
			parts.push(await fileFingerprint(m.spritePath));
		}
		let entries: Dirent[] = [];
		try {
			entries = await readdir(this.petsRoot, { withFileTypes: true });
		} catch {
			/* 目录不存在 */
		}
		const dirs = entries
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
		parts.push(`dirs:${dirs.join(",")}`);
		for (const name of dirs) {
			parts.push(`pet:${await fileFingerprint(join(this.petsRoot, name, "pet.json"))}`);
		}
		return parts.join("|");
	}

	private async scan(): Promise<PetManifest[]> {
		const byId = new Map<string, PetManifest>();
		const idToPath = new Map<string, string>();

		// 内置包
		for (const m of this.builtin) {
			if (!(await fileExists(m.spritePath))) continue;
			byId.set(m.id, { id: m.id, displayName: m.displayName, description: m.description, source: "builtin", spritesheetUrl: petSpriteUrl(m.id) });
			idToPath.set(m.id, m.spritePath);
		}

		// petdex 社区包：<petsRoot>/<name>/pet.json
		const root = resolve(this.petsRoot) + sep;
		let entries: Dirent[] = [];
		try {
			entries = await readdir(this.petsRoot, { withFileTypes: true });
		} catch {
			/* 目录不存在 */
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(this.petsRoot, entry.name);
			try {
				const raw = await readFile(join(dir, "pet.json"), "utf8");
				const json = JSON.parse(raw) as PetDexManifest;
				if (!json.id || !json.spritesheetPath) continue;
				if (byId.has(json.id)) continue; // 内置优先
				// 路径安全：spritesheetPath 来自 pet.json（不可信），resolve 后必须仍在 petsRoot 内，
				// 防 "../" 逃逸读取任意本地文件（协议 handler 依赖此白名单）。
				const spriteAbs = resolve(dir, json.spritesheetPath);
				if (!spriteAbs.startsWith(root)) continue;
				if (!(await fileExists(spriteAbs))) continue;
				byId.set(json.id, { id: json.id, displayName: json.displayName ?? json.id, description: json.description, source: "petdex", spritesheetUrl: petSpriteUrl(json.id) });
				idToPath.set(json.id, spriteAbs);
			} catch {
				/* 单个包失败不影响整体 */
			}
		}

		this.idToPath = idToPath;
		return [...byId.values()];
	}
}
