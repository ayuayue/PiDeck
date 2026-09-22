/**
 * 内置内容包热更新器（提示词商店官方模板 / 内置技能共用）。
 *
 * 背景：提示词模板（resources/prompts/*.md）与内置技能（resources/skills 下各技能目录的 SKILL.md）
 * 都随应用分发在只读的 resources 目录，内容出问题/想迭代只能等下一次发版。
 * 本类提供与内置扩展热更新（src/main/extensions/builtInExtensionsUpdater.ts）同构的机制：
 *
 * 1. 仓库 main 分支提交 <域>-manifest.json（包版本 + 每文件 sha256）；
 * 2. 客户端拉远端清单，与本地「当前生效」逐文件比对 sha，把有差异的文件写进
 *    userData 覆盖层（<userData>/<overlayDirName>/）；
 * 3. 覆盖层是**完整自洽快照**（未变化的文件从当前生效源复制），保证任何一条
 *    manifest 都能独立通过校验——绝不接受半截覆盖层；
 * 4. 查询侧（XuePromptManager / SkillManager）覆盖层优先，写入即见。
 *
 * 安全底线：先下载校验、后原子替换。任一环节失败（网络/sha 不符/写盘异常）都保持
 * 当前生效版本不变；替换前把现有覆盖层整体转为 `.bak`，支持「恢复上一个覆盖版」。
 *
 * 与扩展更新器刻意不共用实现：扩展域有 -e 注入路径、编译期 BUILT_IN_EXTENSIONS
 * 白名单、路径解析缓存等强耦合，硬抽公共基类会同时抬高两边的回归风险。
 * 本类通过选项参数化差异：仓库相对目录、覆盖层目录名、文件名白名单、是否允许
 * 「远端新增文件」（技能是文档不注入代码，允许新增；提示词同为内容也允许）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decodeAtomGitContentsBuffer, repoFileSourceEntries, type RepoFileSourceEntry } from "../update/atomGitContents";
import type { UpdateSourceId } from "../../shared/types/settings";
import type { BuiltinContentCheckResult, BuiltinContentUpdateResult, BuiltinContentUpdateStatus } from "../../shared/types/contentUpdate";

/** 清单所在分支：main（发行分支，与内置扩展更新一致）。 */
export const BUILTIN_CONTENT_UPDATE_DEFAULT_BRANCH = "main";
/** IPC 边界白名单：只接受 main/dev，防 URL 注入。 */
export const BUILTIN_CONTENT_UPDATE_ALLOWED_BRANCHES = ["main", "dev"] as const;

/** 文件名白名单形态：单段或多段相对路径（如 skills 的 `<skill>/SKILL.md`），
 *  不含 `..`（防目录穿越）、不以 `.` 开头（防隐藏文件/点目录）。 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/;

export type BuiltinContentManifestFile = {
	name: string;
	sha256: string;
	bytes: number;
};

export type BuiltinContentManifest = {
	schemaVersion: number;
	version: string;
	bundleSha256: string;
	fileCount: number;
	files: BuiltinContentManifestFile[];
};

export function sha256Of(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** 源候选（atomgit OpenAPI / github raw）；形态与 update/atomGitContents 共用。 */
type SourceEntry = RepoFileSourceEntry;

export type BuiltinContentUpdaterOptions = {
	/** 应用 userData 目录：覆盖层落在它下面（打包态可写）。 */
	userDataDir: string;
	/** 随包分发的内置内容目录（dev 与打包态由调用方解析）。 */
	builtinDir: string;
	/** 覆盖层目录名（userData 下），如 `prompt-overlay`。 */
	overlayDirName: string;
	/** 备份目录名（userData 下），如 `prompt-overlay.bak`。 */
	backupDirName: string;
	/** 清单文件名，如 `prompts-manifest.json`。 */
	manifestFileName: string;
	/** 该内容域在 PiDeck 仓库中的相对目录（远端拉取路径），如 `resources/prompts`。 */
	repoDir: string;
	/** 文件名白名单（默认多段安全名）。 */
	fileNamePattern?: RegExp;
	/** true 时允许「远端清单里本地不认识的新文件名」落盘（内容类资源 OK；扩展注入代码不允许）。 */
	allowNewFiles?: boolean;
	/** 网络实现注入（单测）；默认 globalThis.fetch。 */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxManifestBytes?: number;
	maxFileBytes?: number;
	/** 默认分支，默认 main。 */
	branch?: string;
	/** 更新源：github 时 GitHub raw 直连优先，否则 AtomGit OpenAPI 优先。 */
	source?: () => UpdateSourceId;
	/** 覆盖层写盘成功后回调（如失效查询侧缓存）。 */
	onOverlayWritten?: () => void;
};

export class BuiltinContentUpdater {
	private readonly userDataDir: string;
	private readonly builtinDir: string;
	private readonly overlayDirName: string;
	private readonly backupDirName: string;
	private readonly manifestFileName: string;
	private readonly repoDir: string;
	private readonly fileNamePattern: RegExp;
	private readonly allowNewFiles: boolean;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxManifestBytes: number;
	private readonly maxFileBytes: number;
	private readonly branch: string;
	private readonly source: () => UpdateSourceId;
	private readonly onOverlayWritten?: () => void;

	constructor(options: BuiltinContentUpdaterOptions) {
		this.userDataDir = options.userDataDir;
		this.builtinDir = options.builtinDir;
		this.overlayDirName = options.overlayDirName;
		this.backupDirName = options.backupDirName;
		this.manifestFileName = options.manifestFileName;
		this.repoDir = options.repoDir;
		this.fileNamePattern = options.fileNamePattern ?? SAFE_NAME_PATTERN;
		this.allowNewFiles = options.allowNewFiles ?? false;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.maxManifestBytes = options.maxManifestBytes ?? 256 * 1024;
		this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
		this.branch = options.branch ?? BUILTIN_CONTENT_UPDATE_DEFAULT_BRANCH;
		this.source = options.source ?? (() => "atomgit");
		this.onOverlayWritten = options.onOverlayWritten;
	}

	/** 覆盖层目录绝对路径（无论是否存在）。 */
	resolveOverlayDir(): string {
		return join(this.userDataDir, this.overlayDirName);
	}

	/** 备份目录绝对路径。 */
	private resolveBackupDir(): string {
		return join(this.userDataDir, this.backupDirName);
	}

	/** 覆盖层有效则返回它，否则 null。 */
	resolveEffectiveOverlayDir(): string | null {
		const overlayDir = this.resolveOverlayDir();
		return this.readVerifiedArtifact(overlayDir) ? overlayDir : null;
	}

	/** 当前生效版本号：覆盖层优先，否则内置；都无效为 null。 */
	effectiveVersion(): string | null {
		return this.effectiveManifest()?.version ?? null;
	}

	/** 当前生效目录（覆盖层优先，否则内置）——查询侧用它决定「读哪份内容」。 */
	resolveEffectiveDir(): string {
		const overlayDir = this.resolveOverlayDir();
		return this.readVerifiedArtifact(overlayDir) ? overlayDir : this.builtinDir;
	}

	getStatus(): BuiltinContentUpdateStatus {
		const builtin = this.readVerifiedArtifact(this.builtinDir);
		const overlayDir = this.resolveOverlayDir();
		const overlay = this.readVerifiedArtifact(overlayDir);
		return {
			builtin: builtin ? { version: builtin.version, fileCount: builtin.fileCount } : null,
			overlay: overlay ? { version: overlay.version, fileCount: overlay.fileCount } : null,
			hasOverlayFiles: existsSync(overlayDir),
			hasBackup: existsSync(this.resolveBackupDir()),
			effectiveVersion: overlay?.version ?? builtin?.version ?? null,
			overlayDir: existsSync(overlayDir) ? overlayDir : null,
		};
	}

	/** 检查远端是否有更新：以逐文件 sha256 判定，不依赖版本号是否被 bump。 */
	async checkRemote(branch?: string): Promise<BuiltinContentCheckResult> {
		const manifestText = await this.downloadManifest(branch ?? this.branch);
		if (!manifestText.ok) {
			return { ok: false, code: "network", message: manifestText.message, hasUpdate: false };
		}
		const remote = this.parseManifest(manifestText.text);
		if (!remote) {
			return { ok: false, code: "validation", message: "remote manifest is invalid", hasUpdate: false };
		}
		const changedFiles = this.diffAgainstLocal(remote);
		return {
			ok: true,
			remoteVersion: remote.version,
			localVersion: this.effectiveManifest()?.version ?? null,
			hasUpdate: changedFiles.length > 0,
			changedFiles,
		};
	}

	/** 更新到远端最新：拉清单 → 比对 sha → 下载差异文件（其余从当前生效源复制）→ 校验 → 原子替换。 */
	async update(branch?: string): Promise<BuiltinContentUpdateResult> {
		const resolvedBranch = branch ?? this.branch;
		const manifestText = await this.downloadManifest(resolvedBranch);
		if (!manifestText.ok) {
			return { ok: false, code: "network", message: manifestText.message, updated: false };
		}
		const remote = this.parseManifest(manifestText.text);
		if (!remote) {
			return { ok: false, code: "validation", message: "remote manifest is invalid", updated: false };
		}
		const changedFiles = this.diffAgainstLocal(remote);
		if (changedFiles.length === 0) {
			return { ok: true, updated: false, version: remote.version };
		}
		try {
			const filesWritten = await this.writeOverlay(remote, changedFiles, resolvedBranch);
			this.onOverlayWritten?.();
			return { ok: true, updated: true, version: remote.version, filesWritten };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to write overlay: ${error instanceof Error ? error.message : String(error)}`,
				updated: false,
			};
		}
	}

	/** 一键还原：把覆盖层整体转存 `.bak`，回到随包分发版本。 */
	restoreBuiltin(): BuiltinContentUpdateResult {
		const overlayDir = this.resolveOverlayDir();
		if (!existsSync(overlayDir)) return { ok: true, updated: false };
		try {
			const backupDir = this.resolveBackupDir();
			rmSync(backupDir, { recursive: true, force: true });
			renameSync(overlayDir, backupDir);
			this.onOverlayWritten?.();
			return { ok: true, updated: true, version: this.effectiveVersion() ?? undefined };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to restore builtin: ${error instanceof Error ? error.message : String(error)}`,
				updated: false,
			};
		}
	}

	/** 恢复上一个覆盖版（`.bak` 校验通过才写回）。 */
	restorePrevious(): BuiltinContentUpdateResult {
		const backupDir = this.resolveBackupDir();
		if (!existsSync(backupDir)) {
			return { ok: false, code: "validation", message: "no previous overlay found", updated: false };
		}
		if (!this.readVerifiedArtifact(backupDir)) {
			return { ok: false, code: "validation", message: "backup overlay failed verification", updated: false };
		}
		try {
			const overlayDir = this.resolveOverlayDir();
			rmSync(overlayDir, { recursive: true, force: true });
			renameSync(backupDir, overlayDir);
			this.onOverlayWritten?.();
			return { ok: true, updated: true, version: this.readManifestFromDir(overlayDir)?.version ?? undefined };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to restore previous overlay: ${error instanceof Error ? error.message : String(error)}`,
				updated: false,
			};
		}
	}

	// ── 以下为校验与落盘内部实现（与扩展更新器同构） ──

	/** 解析并严格校验清单文本：任何结构/取值异常返回 null（宁可当作没有更新）。 */
	private parseManifest(raw: string): BuiltinContentManifest | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (record.schemaVersion !== 1) return null;

		const version = record.version;
		if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return null;

		const rawFiles = record.files;
		if (!Array.isArray(rawFiles) || rawFiles.length === 0) return null;

		const files: BuiltinContentManifestFile[] = [];
		const seen = new Set<string>();
		for (const entry of rawFiles) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
			const file = entry as Record<string, unknown>;
			const name = file.name;
			const sha256 = file.sha256;
			const bytes = file.bytes;
			if (typeof name !== "string" || !this.fileNamePattern.test(name)) return null;
			if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
			if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
			if (seen.has(name)) return null;
			seen.add(name);
			files.push({ name, sha256: sha256.toLowerCase(), bytes });
		}

		const bundleSha256 = record.bundleSha256;
		return {
			schemaVersion: 1,
			version,
			bundleSha256: typeof bundleSha256 === "string" && SHA256_PATTERN.test(bundleSha256) ? bundleSha256.toLowerCase() : "",
			fileCount: files.length,
			files,
		};
	}

	/** 读目录下的清单文件并解析；缺失/非法返回 null。 */
	private readManifestFromDir(dir: string): BuiltinContentManifest | null {
		try {
			const manifestPath = join(dir, this.manifestFileName);
			if (!existsSync(manifestPath)) return null;
			return this.parseManifest(readFileSync(manifestPath, "utf8"));
		} catch {
			return null;
		}
	}

	/**
	 * 读取某目录构成的有效 artifact：清单可解析 **且** 每个声明文件存在、
	 * sha256 与 bytes 吻合。任何一项不符返回 null——覆盖层一旦被外部改动/截断，
	 * 就自动退回内置版本而不是带病生效。
	 */
	private readVerifiedArtifact(dir: string): BuiltinContentManifest | null {
		const manifest = this.readManifestFromDir(dir);
		if (!manifest) return null;
		try {
			for (const file of manifest.files) {
				const content = readFileSync(join(dir, file.name));
				if (content.byteLength !== file.bytes) return null;
				if (sha256Of(content) !== file.sha256) return null;
			}
		} catch {
			return null;
		}
		return manifest;
	}

	/** 当前生效的 artifact 清单（覆盖层有效优先，否则内置）。 */
	private effectiveManifest(): BuiltinContentManifest | null {
		const overlay = this.readVerifiedArtifact(this.resolveOverlayDir());
		if (overlay) return overlay;
		return this.readVerifiedArtifact(this.builtinDir);
	}

	/** 本地生效文件 → sha256 映射（清单不可用时退回扫目录现算）。 */
	private localFileShas(): Map<string, string> {
		const manifest = this.effectiveManifest();
		if (manifest) return new Map(manifest.files.map((file) => [file.name, file.sha256]));
		const shas = new Map<string, string>();
		for (const name of this.listKnownFileNames(this.builtinDir)) {
			try {
				shas.set(name, sha256Of(readFileSync(join(this.builtinDir, name))));
			} catch {
				// 读不到就当作不在集合里
			}
		}
		return shas;
	}

	/** 扫描内置目录找出符合白名单的文件（多段路径递归）；仅清单缺失时兜底用。 */
	private listKnownFileNames(dir: string): string[] {
		const out: string[] = [];
		const walk = (base: string, prefix: string) => {
			let entries;
			try {
				entries = readdirSync(base, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					walk(join(base, entry.name), rel);
				} else if (entry.isFile()) {
					if (this.fileNamePattern.test(rel)) out.push(rel);
				}
			}
		};
		walk(dir, "");
		return out.sort((left, right) => left.localeCompare(right));
	}

	/** 远端清单里「内容不同」的文件名；allowNewFiles=false 时本地不认识的新文件名忽略。 */
	private diffAgainstLocal(remote: BuiltinContentManifest): string[] {
		const local = this.localFileShas();
		const changed: string[] = [];
		for (const file of remote.files) {
			if (!local.has(file.name)) {
				if (this.allowNewFiles) changed.push(file.name);
				continue;
			}
			if (local.get(file.name) !== file.sha256) changed.push(file.name);
		}
		return changed;
	}

	/**
	 * 写覆盖层：tmp 目录组装 → 整体校验 → 原子替换。
	 * 覆盖层清单只声明实际落盘的文件，保证 readVerifiedArtifact 能通过。
	 */
	private async writeOverlay(remote: BuiltinContentManifest, changedFiles: string[], branch: string): Promise<number> {
		const overlayDir = this.resolveOverlayDir();
		const tmpDir = `${overlayDir}.tmp`;
		const localShas = this.localFileShas();
		const changed = new Set(changedFiles);
		const sourceDir = this.effectiveSourceDir();
		const written: { name: string; sha256: string; bytes: number }[] = [];

		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
		try {
			for (const file of remote.files) {
				if (!this.allowNewFiles && !localShas.has(file.name)) continue;
				const target = join(tmpDir, file.name);
				mkdirSync(join(target, ".."), { recursive: true });
				if (changed.has(file.name)) {
					const buffer = await this.downloadFileBuffer(file.name, branch);
					const actualSha = sha256Of(buffer);
					if (actualSha !== file.sha256) {
						throw new Error(`downloaded ${file.name} failed sha256 verification`);
					}
					writeFileSync(target, buffer);
				} else {
					// 未变化：从当前生效源复制，保证覆盖层自洽
					copyFileSync(join(sourceDir, file.name), target);
				}
				written.push({ name: file.name, sha256: file.sha256, bytes: file.bytes });
			}
			if (written.length === 0) throw new Error("no updatable file found in remote manifest");

			const overlayManifest: BuiltinContentManifest = {
				schemaVersion: remote.schemaVersion,
				version: remote.version,
				bundleSha256: remote.bundleSha256,
				fileCount: written.length,
				files: written,
			};
			writeFileSync(join(tmpDir, this.manifestFileName), `${JSON.stringify(overlayManifest, null, 2)}\n`, "utf8");
			if (!this.readVerifiedArtifact(tmpDir)) throw new Error("overlay failed verification after write");
			this.swapOverlay(tmpDir);
			return written.length;
		} catch (error) {
			rmSync(tmpDir, { recursive: true, force: true });
			throw error;
		}
	}

	/** 当前生效源目录（覆盖层有效则它，否则内置）。 */
	private effectiveSourceDir(): string {
		return this.resolveEffectiveOverlayDir() ?? this.builtinDir;
	}

	/**
	 * 原子替换：现有覆盖层转 `.bak` → tmp 顶上。
	 * 第二步失败时尝试把 `.bak` 还原为覆盖层，避免「更新失败反而丢掉当前生效版本」。
	 */
	private swapOverlay(tmpDir: string): void {
		const overlayDir = this.resolveOverlayDir();
		const backupDir = this.resolveBackupDir();
		if (existsSync(overlayDir)) {
			rmSync(backupDir, { recursive: true, force: true });
			renameSync(overlayDir, backupDir);
		}
		try {
			renameSync(tmpDir, overlayDir);
		} catch (error) {
			if (existsSync(backupDir) && !existsSync(overlayDir)) {
				try {
					renameSync(backupDir, overlayDir);
				} catch {
					// 回滚也失败：退回内置版本，错误继续上抛
				}
			}
			throw error;
		}
	}

	/**
	 * 源顺序：GitHub 源时 raw 直连优先，否则 AtomGit OpenAPI 优先（国内直连更稳）。
	 * URL 构造与 base64 解码统一在 update/atomGitContents.ts——AtomGit 不能走
	 * `/<owner>/<repo>/raw/<ref>/<path>`（已被 GitCode 前端接管，返回 SPA HTML）。
	 */
	private sourceEntries(relPath: string, branch: string): SourceEntry[] {
		return repoFileSourceEntries(relPath, branch, this.source());
	}

	private async downloadManifest(branch: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
		let lastError: unknown;
		for (const entry of this.sourceEntries(`${this.repoDir}/${this.manifestFileName}`, branch)) {
			try {
				return { ok: true, text: await this.downloadText(entry, this.maxManifestBytes) };
			} catch (error) {
				lastError = error;
			}
		}
		return {
			ok: false,
			message: `manifest download failed from all sources: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		};
	}

	private async downloadFileBuffer(name: string, branch: string): Promise<Buffer> {
		let lastError: unknown;
		for (const entry of this.sourceEntries(`${this.repoDir}/${name}`, branch)) {
			try {
				const buffer = await this.downloadBinary(entry.url, this.maxFileBytes);
				if (entry.id === "atomgit") {
					const decoded = decodeAtomGitContentsBuffer(buffer.toString("utf8"));
					if (!decoded) throw new Error("atomgit contents response has an unexpected shape");
					return decoded;
				}
				return buffer;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error(`no download sources configured for ${name}`);
	}

	private async downloadText(entry: SourceEntry, maxBytes: number): Promise<string> {
		const buffer = await this.downloadBinary(entry.url, maxBytes);
		if (entry.id === "atomgit") {
			const decoded = decodeAtomGitContentsBuffer(buffer.toString("utf8"));
			if (!decoded) throw new Error("atomgit contents response has an unexpected shape");
			return decoded.toString("utf8");
		}
		return buffer.toString("utf8");
	}

	private async downloadBinary(url: string, maxBytes: number): Promise<Buffer> {
		const controller = new AbortController();
		// 超时中止同样覆盖 DNS/连接挂起阶段，避免设置页长时间转圈
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { "user-agent": "PiDeck-content-updater" },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.byteLength > maxBytes) {
				throw new Error(`response too large (${buffer.byteLength} bytes) for ${url}`);
			}
			return buffer;
		} finally {
			clearTimeout(timer);
		}
	}
}
