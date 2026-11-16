import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app, shell } from "electron";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { appendFile, mkdir, open as openFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { basename as posixBasename, dirname as posixDirname, isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path/posix";
import type { ArchivedPiSession, ChatMessage, ChatRole, SessionLocator, SessionSummary } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import { sessionLocatorFromLegacy } from "../../shared/locationAdapters";
import { extractMessageText, extractThinkingRaw } from "../pi/messageContent";
import { isRoleMessageRole } from "../pi/sessionEntryIds";
import { replaceExpandedRefBlocksWithLabels } from "../../shared/expandedRefBlocks";
import { extractReferenceMessageText } from "../../shared/sessionReferenceContext";
import { toWindowsHostPath, toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";
import { getAppLogger } from "../logging/sharedLogger";
import {
	cleanSessionTitleCandidate,
	extractTextFromContent,
	inferSessionTitleFromLines,
	isCopiedParentSessionInfo,
	isLegacySessionNameEntry,
	isLegacySessionNameLine,
	isSessionScanLine,
	readForkHistoryBoundary,
	stripLegacySessionNameLine,
	tryRestorePathGluedHeader,
	type ForkHistoryBoundary,
	type SessionScanLine,
	type SessionScanMessage,
	type SessionTitleFallbackKind,
	type SessionTitleInference,
} from "./sessionNameLine";
import { SessionSummaryCache, type SessionFileVersion } from "./sessionSummaryCache";
import { rewriteJsonlLines } from "./jsonlLineStream";
import { readSessionChatMessages, readSessionMessages, type SessionMessageReadHost } from "./scanner/sessionMessageReads";
import { createSessionInfoAppender } from "./scanner/sessionInfoAppender";
import { exportSessionHtml, type SessionHtmlExportHost } from "./scanner/sessionHtmlExport";
import { collectFromRootsLocal, collectFromRootsWsl, collectJsonl, collectWslJsonl, mapLimited, type SessionRootEnumerationHost } from "./scanner/sessionRootEnumeration";
import { hasSessionHeader, isSessionFile, listPathSummary, optionalString, readLocalFileHead, readLocalFilePrefix, readLocalFileSuffix, readSessionSummary, type SessionSummaryReadHost } from "./scanner/sessionSummaryRead";
import { FIRST_MESSAGE_TITLE_MAX_BYTES, inferFirstMessageTitle, inferSessionNameAndValidity, inferSessionNameFromFile, probeTintinwebSubagentParent, type SessionTitleProbeHost } from "./scanner/sessionTitleProbe";
import { canonicalSessionPath, findSessionsRootForFile, inferProjectPathFromFile, isSameProject, isUnderProjectSessionDir, looksLikeNestedSessionPath, normalizeSessionPath, sessionPathToken, type SessionScanRootsHost } from "./scanner/sessionPathDerivation";

type SessionScannerCopyKey = Extract<MainProcessTranslationKey, "session.untitled" | "session.emptyPreview" | "session.copyTitle" | "session.fileTooLargeForWholeRead" | "session.deleteFileBusy">;

type SessionScannerCopy = (key: SessionScannerCopyKey, params?: Record<string, string | number>) => string;

const defaultSessionScannerCopy: Record<SessionScannerCopyKey, string> = {
	"session.untitled": "Untitled",
	"session.emptyPreview": "空会话",
	"session.copyTitle": "{title} copy",
	"session.fileTooLargeForWholeRead": "This session file is too large ({sizeMb}MB, over the {limitMb}MB whole-read limit); the operation was cancelled to avoid crashing the app.",
	"session.deleteFileBusy": "会话文件仍被占用，请先停止该会话后重试。",
};

function defaultTranslate(key: SessionScannerCopyKey, params: Record<string, string | number> = {}): string {
	return defaultSessionScannerCopy[key].replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

// 会话标题推断已抽到 ./sessionNameLine.ts（纯函数，远端按需标题 H1 与本地扫描共用同一份实现）。

/** 取错误的 code（ENOENT/EPERM/EBUSY…）：Electron 的 trashItem 失败信息是通用的，code 才有诊断价值。 */
function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * 在文本片段（通常是文件头 4KB）中探测旧版私有 sessionName 行。
 * 只对可解析的行判定；片段末尾可能截断行，解析失败时保守跳过（不影响判定）。
 */
function hasLegacySessionNameLine(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (isLegacySessionNameLine(trimmed)) return true;
		// 遇到首条非私有行即可停止：私有行只可能出现在头部（旧版前置插入），
		// 首条正常记录之后的区域无需继续探测。
		return false;
	}
	return false;
}

export class SessionScanner {
	private readonly root = join(app.getPath("home"), ".pi", "agent", "sessions");
	private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");
	/** WSL 配置由主进程统一解析；内部保留 home 字段以维持扫描代码的单一 Linux 路径语义。 */
	private wslConfig: { distro: string; user: string; home: string } | null = null;
	/** 比 renderer watchdog 更短，确保超时前先终止实际扫描，避免后台请求堆积。 */
	private scanTimeoutMs = 18_000;
	/** 摘要扫描并发：打包正式目录可有数百 JSONL，Promise.all 全开会占满主线程，点击/输入跟着卡。 */
	private static readonly SUMMARY_READ_CONCURRENCY = 4;
	/**
	 * 整文件读入的体量上限：超过即拒绝（抛可读错误）。
	 *
	 * 主进程 V8 老生代堆上限只有 384MB（见 src/main/v8HeapLimits.ts），而
	 * `readFile(utf8)` 读到的字符串 + `split` 出的行数组合计约为文件体积的 2 倍——
	 * 几百 MB 的会话会让 V8 `FatalProcessOutOfMemory` abort 掉主进程（用户看到「闪退」，
	 * 日志里连堆栈都没有）。32MB 是「安全 × 常见会话都够用」的折中：
	 * 正常会话几 MB 以内，超限的都是该走流式路径的大会话。
	 */
	private static readonly MAX_IN_MEMORY_SESSION_BYTES = 32 * 1024 * 1024;
	/** 多项目同时 list() 时串行化，避免展开多个项目时并行扫盘把 IPC 打爆。 */
	private listQueue: Promise<void> = Promise.resolve();
	private readonly summaryCache = new SessionSummaryCache<SessionSummary | null>();
	private summaryCacheFileSetKey = "";
	/**
	 * 最近一次 list() 解析出的会话扫描根目录。
	 * 默认 ~/.pi/agent/sessions，加上 settings 中的 sessionDir（如项目 .pi/sessions）。
	 * 供子会话父路径推断作为边界。
	 */
	private activeScanRoots: string[] = [];

	/** 消息读取（readMessages / readChatMessages）需要的宿主持有面，见 scanner/sessionMessageReads.ts。 */
	private readonly messageReadHost: SessionMessageReadHost = {
		readSessionRawText: (filePath) => this.readSessionRawText(filePath),
		hostPathFor: (filePath) => this.hostPathFor(filePath),
	};

	/** HTML 导出需要的宿主持有面，见 scanner/sessionHtmlExport.ts。 */
	private readonly htmlExportHost: SessionHtmlExportHost = {
		readSummary: (filePath) => this.readSummary(filePath),
		hostPathFor: (filePath) => this.hostPathFor(filePath),
		translate: (key) => this.translate(key),
		extractText: (content) => this.extractText(content),
	};

	/** 摘要读取（readSummary）需要的宿主持有面，见 scanner/sessionSummaryRead.ts。 */
	private readonly summaryReadHost: SessionSummaryReadHost = {
		isWslPath: (filePath) => this.isWslPath(filePath),
		readWslFileVersion: (filePath, signal) => this.readWslFileVersion(filePath, signal),
		readWslFileHead: (filePath, maxBytes, signal) => this.readWslFileHead(filePath, maxBytes, signal),
		summaryCache: this.summaryCache,
		withSessionLocator: (summary) => this.withSessionLocator(summary),
		sessionLocatorForPath: (filePath, isWsl) => this.sessionLocatorForPath(filePath, isWsl),
		inferParentSessionFromPath: (filePath) => this.inferParentSessionFromPath(filePath),
		inferWslParentSessionFromPath: (filePath, signal) => this.inferWslParentSessionFromPath(filePath, signal),
		resolveForkParentPath: (filePath, forkParentSession, isWsl, sessionCwd, signal) => this.resolveForkParentPath(filePath, forkParentSession, isWsl, sessionCwd, signal),
		canonicalProjectPath: (path, wsl) => this.canonicalProjectPath(path, wsl),
		looksLikeNestedSessionPath: (filePath) => this.looksLikeNestedSessionPath(filePath),
		translate: (key) => this.translate(key),
		codexRoot: this.codexRoot,
	};

	constructor(private readonly translate: SessionScannerCopy = defaultTranslate) {}

	/** 项目级 sessionDir 缓存：settings 文件版本 → 解析出的目录（null = 该项目无配置）。 */
	private readonly projectSearchRootCache = new Map<string, { version: string; root: string | null }>();

	/**
	 * wsl.exe 命令与启动模式。优先绝对路径，
	 * 文件不存在时回退到 shell PATH 查找。
	 */
	private resolveWslExe(): { command: string; shell: boolean } {
		const systemRoot = process.env.SystemRoot || "C:\\Windows";
		const candidates = process.arch === "ia32" ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")] : [join(systemRoot, "System32", "wsl.exe")];
		for (const candidate of candidates) {
			if (existsSync(candidate)) return { command: candidate, shell: false };
		}
		return { command: "wsl", shell: true };
	}
	/** @deprecated 使用 resolveWslExe() 代替 */
	private get wslExePath(): string {
		return this.resolveWslExe().command;
	}
	/** 是否需要 shell 模式来查找 wsl.exe */
	private get wslShell(): boolean {
		return this.resolveWslExe().shell;
	}

	/** WSL 会话路径是 Linux 路径，即使本类跑在 Windows Node 里也必须用 posix join。 */
	private joinRuntimePath(...parts: string[]): string {
		const first = parts[0] ?? "";
		if (this.wslConfig && first.startsWith("/")) {
			return posixJoin(...parts.map((part) => part.replace(/\\/g, "/")));
		}
		return join(...parts);
	}

	async configureWsl(environment: WslEnvironment | null): Promise<void> {
		this.wslConfig = environment ? { distro: environment.distro, user: environment.user, home: environment.linuxHome } : null;
		// 环境切换时只重置“本轮扫描键”，并从磁盘重新装载缓存；不要把另一环境的磁盘缓存清空。
		this.summaryCacheFileSetKey = "";
		await this.summaryCache.reloadFromDisk();
	}

	/** 清除 WSL 配置 */
	clearWsl(): void {
		this.wslConfig = null;
		this.summaryCacheFileSetKey = "";
		void this.summaryCache.reloadFromDisk();
	}

	/** WSL 中 pi 默认 session 目录（基于动态获取的 home） */
	private get wslSessionsDir(): string {
		return `${this.wslConfig!.home}/.pi/agent/sessions`;
	}

	/** 当前环境下的默认会话根目录（全局 encoded-cwd 布局） */
	private get defaultSessionsRoot(): string {
		return this.wslConfig ? this.wslSessionsDir : this.root;
	}

	/**
	 * 跨会话全文搜索（session-index sidecar）的**全局**扫描根：全局默认根 + 全局
	 * settings 的 sessionDir（若存在）。项目级 .pi/settings.json 的 sessionDir 不在这里，
	 * 由 `resolveContentSearchRoots` 追加（那里能拿到已注册项目列表）。
	 * WSL 模式下返回 Linux 侧根（宿主 Go 进程直接读 UNC 不可靠，跨 WSL 的
	 * 全文搜索暂不支持，返回空数组由调用方降级）。
	 */
	async resolveGlobalSearchRoots(): Promise<string[]> {
		if (this.wslConfig) return [];
		const roots = [this.defaultSessionsRoot];
		// 全局 settings：~/.pi/agent/settings.json（与 resolveConfiguredSessionDir 的全局分支同源）
		const globalSettingsPath = join(dirname(this.root), "settings.json");
		const globalRaw = await this.readSessionDirSettingLocal(globalSettingsPath);
		if (!globalRaw) return roots;
		const resolved = this.resolveSessionDirPath(globalRaw, this.root);
		if (!resolved) return roots;
		const normalized = this.normalize(resolved);
		if (roots.some((root) => this.normalize(root) === normalized)) return roots;
		if (!existsSync(resolved)) return roots;
		roots.push(resolved);
		return roots;
	}

	/**
	 * 正文搜索的完整扫描根 = 全局根 + 各项目的项目级 sessionDir（合并去重）。
	 *
	 * 为什么必须带上项目级目录：项目 `.pi/settings.json` 的 sessionDir 是不少用户实际的
	 * 会话落点，只喂全局根会出现「明明有这条消息却搜不到」（标题/预览能搜到，因为侧栏目录
	 * 按项目扫描）。这里只认项目自己的配置，不回退全局——全局那份已由全局根覆盖。
	 * 调用方负责按当前环境过滤项目（WSL 项目不传进来）。
	 */
	async resolveContentSearchRoots(projectPaths: readonly string[]): Promise<string[]> {
		const roots = await this.resolveGlobalSearchRoots();
		if (roots.length === 0) return roots;
		const seen = new Set(roots.map((root) => this.normalize(root)));
		for (const root of await this.resolveProjectSearchRoots(projectPaths)) {
			const normalized = this.normalize(root);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			roots.push(root);
		}
		return roots;
	}

	/**
	 * 各项目的项目级会话目录（项目 `.pi/settings.json` 的 sessionDir）。
	 *
	 * 每次搜索按键都会调用，所以每个项目只 stat 一次 settings 文件（mtime+size 做缓存键），
	 * 内容未变时不重复读取；目录本身每次调用校验存在性（用户可能后建目录）。
	 * 读失败/无配置/目录不存在一律跳过：搜索入口只降级、不报错。
	 */
	async resolveProjectSearchRoots(projectPaths: readonly string[]): Promise<string[]> {
		if (this.wslConfig) return [];
		const roots: string[] = [];
		const seen = new Set<string>();
		for (const projectPath of projectPaths) {
			if (!projectPath) continue;
			const root = await this.resolveCachedProjectSearchRoot(projectPath);
			if (!root) continue;
			const normalized = this.normalize(root);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			roots.push(root);
		}
		return roots;
	}

	/** 项目级 sessionDir 解析（带 settings 版本缓存）；无可用目录时返回 undefined。 */
	private async resolveCachedProjectSearchRoot(projectPath: string): Promise<string | undefined> {
		const settingsPath = join(projectPath, ".pi", "settings.json");
		let version: string;
		try {
			const info = await stat(settingsPath);
			version = `${info.mtimeMs}:${info.size}`;
		} catch {
			this.projectSearchRootCache.delete(projectPath);
			return undefined;
		}
		const cached = this.projectSearchRootCache.get(projectPath);
		if (cached && cached.version === version) {
			return cached.root && existsSync(cached.root) ? cached.root : undefined;
		}
		const raw = await this.readSessionDirSettingLocal(settingsPath);
		const resolved = raw ? this.resolveSessionDirPath(raw, projectPath) : undefined;
		// 缓存解析结果（不缓存存在性：目录可能后建，存在性在命中缓存时现查）
		this.projectSearchRootCache.set(projectPath, { version, root: resolved ?? null });
		return resolved && existsSync(resolved) ? resolved : undefined;
	}

	/** 判断文件路径是否为 WSL Linux 路径（以 / 开头且属于当前 WSL 配置） */
	private isWslPath(filePath: string): boolean {
		if (!this.wslConfig) return false;
		// WSL 路径是 Linux 绝对路径（以 / 开头且不以盘符开头）
		return filePath.startsWith("/") && !/^[A-Za-z]:/.test(filePath);
	}

	/**
	 * 会话文件本体读写用的宿主路径：WSL 会话映射到 `\\wsl.localhost\<distro>\...`。
	 *
	 * 为什么 WSL 不再走 `wsl cat` / `dd`：那是**整文件字符串**通道（execFile 的
	 * maxBuffer 是上限，主进程 384MB 堆是上限），既做不了流式，也做不了按字节定向读。
	 * 映射成 UNC 后 Node fs 可以直接 open/read(position)/write/rename，于是本地那套
	 * 「流式扫描 + 按 offset 定向读 + 临时文件原子改名」对 WSL 会话免费复用。
	 * 这条通路本来就是 PiDeck 读 WSL 会话历史的主路（AgentManager.toSessionHostPath）
	 * 与会话文件编辑的写路（SessionFileEditor：hostPath + temp + rename 重试），不是新引入的能力。
	 *
	 * 注意：catalog 里的身份（SessionRecord.id / filePath）仍是 Linux 路径，
	 * 只在真正落盘处做映射；`wsl cat/dd` 仍保留给确定性小文件（settings、归档索引）。
	 */
	private hostPathFor(filePath: string): string {
		if (!this.isWslPath(filePath)) return filePath;
		const distro = this.wslConfig?.distro;
		if (!distro) return filePath;
		try {
			return toWindowsHostPath(filePath, { distro });
		} catch {
			// 无法映射（畸形路径）：退回原路径，由调用方按 IO 失败处理
			return filePath;
		}
	}

	// ── WSL 文件操作封装 ───────────────────────────────────────────

	/** 通过 wsl.exe 读取文件内容 */
	private readWslFile(wslPath: string, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "cat", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 10_000,
					signal,
					windowsHide: true,
					// 会话 JSONL 可能很大（单条 thinking 块可到 600KB+，千条消息轻松超 1MB）；
					// Node execFile 默认 maxBuffer=1MB，超出会抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，
					// 导致 readSummary 返回 null、会话从列表消失（#147）。64MB 覆盖常见大会话。
					maxBuffer: 64 * 1024 * 1024,
				},
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				},
			);
		});
	}

	/** 通过 wsl.exe 只读取文件头部，避免父会话校验反复传输大型 JSONL。 */
	private readWslFileHead(wslPath: string, maxBytes = 4096, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "head", "-c", String(maxBytes), "--", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					signal,
					windowsHide: true,
				},
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				},
			);
		});
	}

	/** 通过 wsl.exe 读取文件尾部；pi `/name` 会把权威 session_info 追加在日志末尾。 */
	private readWslFileTail(wslPath: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "tail", "-c", String(maxBytes), "--", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					signal,
					windowsHide: true,
				},
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				},
			);
		});
	}

	/** 通过 wsl.exe 写入文件内容 */
	private writeWslFile(wslPath: string, content: string): Promise<void> {
		return new Promise((resolve, reject) => {
			// 用 dd of= 从 stdin 写入：不做 stdout 回显（tee 会把内容回显，大文件回写时
			// 同样撞 1MB maxBuffer，Node 会 kill 子进程，文件可能只写一半——#147 同家族问题）。
			// 内容走 stdin 传参，天然避开 heredoc/特殊字符问题；of= 作为单一参数传给 dd，
			// 含空格路径也安全（数组传参不会被拆分）。
			const proc = execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "dd", `of=${wslPath}`, "bs=1M"], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (err) => {
				if (err) reject(err);
				else resolve();
			});
			if (proc.stdin) {
				proc.stdin.end(content);
			}
		});
	}

	/** 通过 wsl.exe 获取缓存判定所需的修改时间和大小。 */
	private readWslFileVersion(wslPath: string, signal?: AbortSignal): Promise<SessionFileVersion> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "stat", "-c", "%Y %s", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					signal,
					windowsHide: true,
				},
				(err, stdout) => {
					if (err) {
						reject(err);
						return;
					}
					const [mtimeSeconds, size] = stdout.trim().split(/\s+/).map(Number);
					resolve({ mtimeMs: mtimeSeconds * 1000, size });
				},
			);
		});
	}

	/** 通过 wsl.exe 删除文件 */
	private deleteWslFile(wslPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "rm", "-f", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => {
					if (err) reject(err);
					else resolve();
				},
			);
		});
	}

	/** 通过 wsl.exe 复制文件 */
	private copyWslFile(srcPath: string, dstPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "cp", srcPath, dstPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => {
					if (err) reject(err);
					else resolve();
				},
			);
		});
	}

	/** 归档写入前先保证 WSL 目标目录存在。 */
	private mkdirWsl(dirPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "mkdir", "-p", "--", dirPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => {
					if (err) reject(err);
					else resolve();
				},
			);
		});
	}

	/** 通过 wsl.exe 检查文件是否存在 */
	private existsWslFile(wslPath: string, signal?: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-f", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					signal,
					windowsHide: true,
				},
				(err) => {
					resolve(!err);
				},
			);
		});
	}

	// ── 会话列表扫描 ─────────────────────────────────────────────

	/** 扫描根枚举（find / readdir / 去重并发）实现在 scanner/sessionRootEnumeration.ts。 */
	private get rootEnumerationHost(): SessionRootEnumerationHost {
		return {
			resolveWslExe: () => this.resolveWslExe(),
			wslConfig: this.wslConfig,
			normalizePath: (path) => this.normalize(path),
			archiveDirName: SessionScanner.ARCHIVE_DIR_NAME,
			collectJsonl: (dir) => this.collectJsonl(dir),
			collectWslJsonl: (dir, signal) => this.collectWslJsonl(dir, signal),
		};
	}

	/** 通过 wsl.exe 在指定目录递归查找 *.jsonl，返回 Linux 绝对路径 */
	private async collectWslJsonl(sessionsDir: string, signal?: AbortSignal): Promise<string[]> {
		return collectWslJsonl(this.rootEnumerationHost, sessionsDir, signal);
	}

	private async collectFromRootsLocal(roots: string[]): Promise<string[]> {
		return collectFromRootsLocal(this.rootEnumerationHost, roots);
	}

	private async collectFromRootsWsl(roots: string[], signal?: AbortSignal): Promise<string[]> {
		return collectFromRootsWsl(this.rootEnumerationHost, roots, signal);
	}

	private async collectJsonl(dir: string): Promise<string[]> {
		return collectJsonl(this.rootEnumerationHost, dir);
	}

	/** 滑动窗口并发：每个 worker 在 `await mapper(...)` 处自然交回事件循环（回归守卫 tests/sessionScannerMapLimited.test.mjs）。 */
	private async mapLimited<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
		return mapLimited(items, concurrency, mapper);
	}

	async list(projectPath?: string): Promise<SessionSummary[]> {
		const run = this.listQueue.then(
			() => this.listUnqueued(projectPath),
			() => this.listUnqueued(projectPath),
		);
		this.listQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async listUnqueued(projectPath?: string): Promise<SessionSummary[]> {
		// 匹配用路径：WSL 模式下转 /mnt/...，与会话 JSONL 内 cwd 对齐。
		const normalizedProjectPath = projectPath && this.wslConfig ? toWslLinuxPath(projectPath, this.wslConfig) : projectPath;
		// WSL 扫描会启动大量外部命令；整体 watchdog 必须早于 renderer 超时，
		// 这样超时会真正终止底层 wsl.exe，而不是只释放前端锁后继续堆积扫描。
		const controller = this.wslConfig ? new AbortController() : null;
		const signal = controller?.signal;
		const scanTimer = controller ? setTimeout(() => controller.abort(new Error("Session scan timed out")), this.scanTimeoutMs) : null;
		const rethrowAbort =
			<T>(fallback: T) =>
			(error: unknown): T => {
				if (signal?.aborted) throw signal.reason ?? error;
				return fallback;
			};

		try {
			// 重启后先恢复磁盘摘要缓存，避免全量重读 JSONL。
			await this.summaryCache.ensureLoaded();

			// 扫描根 = 默认全局 sessions + 项目/全局 sessionDir（如 <project>/.pi/sessions）。
			// pi 配置 sessionDir 后不再写 encoded-cwd 子目录，必须额外扫该路径。
			const scanRoots = await this.resolveScanRoots(projectPath, normalizedProjectPath);
			this.activeScanRoots = scanRoots;

			// WSL 模式 vs 本地模式：互斥扫描，不会同时展示两个环境的会话。
			const files = this.wslConfig ? await this.collectFromRootsWsl(scanRoots, signal).catch(rethrowAbort([] as string[])) : await this.collectFromRootsLocal(scanRoots);
			const fileSetKey = [...files].sort().join("\n");
			if (fileSetKey !== this.summaryCacheFileSetKey) {
				// 仅修剪当前环境下已消失文件，保留未变化会话的摘要命中（含磁盘恢复的条目）。
				this.summaryCache.prune(files, this.wslConfig ? "wsl" : "local");
				this.summaryCacheFileSetKey = fileSetKey;
			}

			// 侧栏列表只认路径 + stat：正文留给点击后的轮次历史页。
			// 打包目录可有数百 JSONL，再在 list() 里 parse 会占满主进程，点击/输入跟着卡。
			const summaries = await this.mapLimited(files, SessionScanner.SUMMARY_READ_CONCURRENCY, (file) => this.listPathSummary(file, signal).catch(rethrowAbort(null)));
			signal?.throwIfAborted();

			const validSummaries = summaries.filter((summary): summary is SessionSummary => Boolean(summary));

			if (!normalizedProjectPath) {
				return validSummaries.sort((a, b) => b.updatedAt - a.updatedAt);
			}
			const filtered = validSummaries.filter((summary) => this.isSameProject(summary, normalizedProjectPath)).sort((a, b) => b.updatedAt - a.updatedAt);
			return filtered;
		} finally {
			if (scanTimer) clearTimeout(scanTimer);
		}
	}

	/**
	 * 解析本次应扫描的会话根目录。
	 * 始终包含默认全局目录（保留历史会话）；若 settings 配置了 sessionDir 且目录存在则追加。
	 *
	 * @param hostProjectPath 项目原始路径（通常是 Windows 路径，用于读 .pi/settings.json）
	 * @param runtimeProjectPath 运行时 cwd 路径（WSL 下已是 /mnt/...，用于解析相对 sessionDir）
	 */
	private async resolveScanRoots(hostProjectPath?: string, runtimeProjectPath?: string): Promise<string[]> {
		const roots: string[] = [this.defaultSessionsRoot];
		if (!hostProjectPath || !runtimeProjectPath) return roots;

		const configured = await this.resolveConfiguredSessionDir(hostProjectPath, runtimeProjectPath);
		if (!configured) return roots;

		const normalizedConfigured = this.normalize(configured);
		if (roots.some((root) => this.normalize(root) === normalizedConfigured)) return roots;

		const exists = this.wslConfig ? await this.existsWslDir(configured) : existsSync(configured);
		if (exists) roots.push(configured);
		return roots;
	}

	/**
	 * 读取 pi 的 sessionDir 配置并解析为可扫描绝对路径。
	 * 优先级：项目 `.pi/settings.json` > 全局 `~/.pi/agent/settings.json`。
	 */
	private async resolveConfiguredSessionDir(hostProjectPath: string, runtimeProjectPath: string): Promise<string | undefined> {
		const projectSettingsPath = join(this.toHostReadablePath(hostProjectPath), ".pi", "settings.json");
		const projectRaw = await this.readSessionDirSettingLocal(projectSettingsPath);

		const globalRaw = this.wslConfig ? await this.readSessionDirSettingWsl(`${this.wslConfig.home}/.pi/agent/settings.json`) : await this.readSessionDirSettingLocal(join(app.getPath("home"), ".pi", "agent", "settings.json"));

		const raw = projectRaw ?? globalRaw;
		if (!raw) return undefined;
		return this.resolveSessionDirPath(raw, runtimeProjectPath);
	}

	private async readSessionDirSettingLocal(settingsPath: string): Promise<string | undefined> {
		try {
			if (!existsSync(settingsPath)) return undefined;
			const raw = await readFile(settingsPath, "utf8");
			const parsed = JSON.parse(raw) as { sessionDir?: unknown };
			return typeof parsed.sessionDir === "string" && parsed.sessionDir.trim() ? parsed.sessionDir.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	private async readSessionDirSettingWsl(settingsPath: string): Promise<string | undefined> {
		try {
			const raw = await this.readWslFile(settingsPath);
			const parsed = JSON.parse(raw) as { sessionDir?: unknown };
			return typeof parsed.sessionDir === "string" && parsed.sessionDir.trim() ? parsed.sessionDir.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 将 sessionDir 配置解析为扫描用绝对路径。
	 * 对齐 pi：展开 `~`；相对路径相对项目 cwd（非 settings 文件目录）。
	 */
	private resolveSessionDirPath(sessionDir: string, projectCwd: string): string {
		const expanded = this.expandHomePrefix(sessionDir);
		if (this.wslConfig) {
			const normalized = expanded.replace(/\\/g, "/");
			if (posixIsAbsolute(normalized)) return normalized;
			if (/^[A-Za-z]:[\\/]/.test(expanded)) {
				return toWslLinuxPath(expanded, this.wslConfig);
			}
			return posixJoin(projectCwd.replace(/\\/g, "/"), normalized);
		}
		if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
			return resolve(expanded);
		}
		return resolve(projectCwd, expanded);
	}

	/** 展开 `~` / `~/...`；WSL 下使用 WSL home */
	private expandHomePrefix(input: string): string {
		const home = this.wslConfig?.home ?? app.getPath("home");
		if (input === "~") return home;
		if (input.startsWith("~/") || input.startsWith("~\\")) {
			return this.wslConfig ? `${home}/${input.slice(2).replace(/\\/g, "/")}` : join(home, input.slice(2));
		}
		return input;
	}

	/**
	 * 把可能的 /mnt/<drive>/... 转成 Windows 盘符路径，便于宿主 fs 读取项目 settings。
	 * 非 /mnt 的 Linux 路径保持原样（由 WSL 链路处理）。
	 */
	private toHostReadablePath(path: string): string {
		const match = path.replace(/\\/g, "/").match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
		if (!match) return path;
		return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
	}

	private async existsWslDir(wslPath: string): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-d", wslPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => resolve(!err),
			);
		});
	}

	/**
	 * 重命名会话：按 pi 原生格式在 JSONL 末尾追加 session_info 记录。
	 *
	 * pi 要求会话文件首条可解析记录必须是 type:"session"（buildSessionInfo 中
	 * 否则直接返回 null），旧版在文件头前置 {"sessionName":...} 会让 pi 完全无法
	 * 加载该会话（/resume 中也不可见，见 #114）。pi 原生 /rename 的做法是末尾追加
	 * {type:"session_info", id, parentId, timestamp, name}，读取时取最后一条。
	 *
	 * 顺带剔除旧版 PiDeck 写入的 sessionName 私有行，修复已被破坏的会话文件。
	 * 支持 WSL 路径。
	 */
	async rename(filePath: string, newName: string): Promise<void> {
		// WSL 与本地同一条流式路径（hostPathFor 把 Linux 路径映射成 UNC）
		const hostPath = this.hostPathFor(filePath);
		const appender = createSessionInfoAppender({ isLegacySessionNameEntry });
		const tempPath = `${hostPath}.pideck-rewrite-${randomUUID().slice(0, 8)}.tmp`;
		try {
			await rewriteJsonlLines(hostPath, tempPath, appender.transform);
			await appendFile(tempPath, `${appender.build(newName)}\n`, "utf8");
			// 写临时文件再原子改名：大会话重写中途失败不会留下被截断的原会话。
			// 重试一次：WSL 走 \\wsl.localhost 的 9P 通道，rename 偶发瞬时失败
			// （SessionFileEditor.renameWithRetry 有同样观察）；失败时原文件不动。
			await this.renameWithRetry(tempPath, hostPath);
			getAppLogger()?.info("session", "Session renamed", { filePath, newName });
		} catch (error) {
			await rm(tempPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	/** 原子改名 + 一次重试（9P/占用导致的偶发 EPERM/EBUSY）。 */
	private async renameWithRetry(from: string, to: string): Promise<void> {
		try {
			await rename(from, to);
		} catch (error) {
			void getAppLogger()?.warn("session", "Session file swap failed, retrying once", {
				from,
				to,
				error: error instanceof Error ? error.message : String(error),
			});
			await new Promise((resolve) => setTimeout(resolve, 60));
			await rename(from, to);
		}
	}

	/**
	 * 修复会话文件头部的两类损坏（在 AgentManager 每次 spawn pi 前调用，经 PiProcess options 注入）：
	 *
	 * 1. 旧版 PiDeck 私有 sessionName 头行（#114 存量受损文件）。
	 * 2. 首行被写成「<文件路径>.jsonl{JSON} 粘连」（2026-08 用户现场：路径与 session header
	 *    无换行粘连，pi 跳过坏行后首条记录变成 model_change，拒绝加载）。
	 *
	 * pi 要求首条可解析记录是 type:"session" 头，两类损坏都会触发「Session file is not a valid
	 * pi session」（exit 1）。先读文件头 4KB 快速探测（避免大文件全量读取拖慢 Agent 启动），
	 * 命中才全量修复并回写；返回是否实际修复。WSL 会话同样走 UNC 宿主路径（见 hostPathFor）。
	 */
	async repairCorruptSessionHeader(filePath: string): Promise<boolean> {
		const hostPath = this.hostPathFor(filePath);
		const head = await this.readFileHeadNative(hostPath, 4096);

		// 模式 1：旧版私有头行（只会出现在文件头部区域；中后段同类行不阻塞 pi 加载，
		// 留待重命名时一并清理，与既有行为一致）
		if (hasLegacySessionNameLine(head)) {
			// 修复需要整文件重写：先过体量护栏，超限抛可读错误（大会话整读会 abort 主进程）
			await this.assertInMemoryReadSafe(hostPath);
			const raw = await readFile(hostPath, "utf8");
			const stripped = stripLegacySessionNameLine(raw);
			if (stripped === raw) return false;
			await writeFile(hostPath, stripped, "utf8");
			return true;
		}

		// 模式 2：首行路径粘连（.jsonl{ + 合法 session header，见 tryRestorePathGluedHeader）
		const restoredFirstLine = tryRestorePathGluedHeader(head);
		if (restoredFirstLine !== null) {
			await this.assertInMemoryReadSafe(hostPath);
			const raw = await readFile(hostPath, "utf8");
			// 只重写第一行；其余行原样保留（含空行与末尾结构）
			const lines = raw.split(/\r?\n/);
			if (lines[0] === restoredFirstLine) return false;
			lines[0] = restoredFirstLine;
			const output = lines.join("\n");
			await writeFile(hostPath, output, "utf8");
			return true;
		}

		return false;
	}

	/** 读取本地文件前 maxBytes 字节（用于会话文件头部快速探测，避免大文件全量读）。 */
	private async readFileHeadNative(filePath: string, maxBytes: number): Promise<string> {
		const handle = await openFile(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	/**
	 * 删除会话文件，同时清理同级子会话目录（如果存在）。
	 *
	 * 目录结构约定：父会话 <stem>.jsonl 与子会话目录 <stem>/ 相邻。
	 * 删除父会话时一并移除 <stem>/ 目录及其下所有子会话 JSONL，避免残留孤儿目录。
	 * 删除顺序固定为「先文件、后目录」：反过来的话文件删除失败会留下无主的孤儿目录
	 * （issue #364 里用户看到的就是这一步之后整个会话删不掉）。
	 */
	async delete(filePath: string): Promise<void> {
		if (this.isWslPath(filePath)) {
			// rm -f 语义保证“文件已被外部清理”与成功删除等价，避免重启后删空草稿报错。
			await this.deleteWslSiblingDir(filePath);
			await this.deleteWslFile(filePath);
			// WSL 分支是硬删除（rm -f，不进回收站），不可恢复的操作必须留痕
			getAppLogger()?.info("session", "Session deleted permanently (WSL)", { filePath });
			return;
		}

		// catalog 可能保留一个已被 pi/系统回收站移走的历史路径；删除接口必须幂等。
		if (!existsSync(filePath)) {
			getAppLogger()?.info("session", "Session delete skipped (file already gone)", { filePath });
		} else {
			// 删除会话是用户主动操作：统一移入系统回收站（可恢复）。
			// 回收站不可用时直接抛错——拒绝静默硬删，错误由 IPC 层呈现给用户。
			await this.trashWithRetry(filePath, "session-file");
			getAppLogger()?.info("session", "Session moved to trash", { filePath });
		}

		// 同级目录只做尽力清理：里面可能还有仍在运行的子会话占用句柄。
		// 它失败绝不能把「文件已经删掉」的会话报成删除失败（否则条目永远卡在列表里）。
		await this.deleteSiblingDirBestEffort(filePath);
	}

	// ── 会话归档：移动到 <扫描根>/.pideck-archive/ 并记录原路径 ──
	// 归档与删除的区别：文件不销毁，随时可从归档恢复；归档目录内不再被扫描。

	/** 归档目录名（各扫描根下的隐藏子目录） */
	private static readonly ARCHIVE_DIR_NAME = ".pideck-archive";
	/** 归档索引文件名：记录 归档路径 → 原始路径 映射，恢复时据此移回 */
	private static readonly ARCHIVE_INDEX_NAME = "index.json";

	/** 取 filePath 所在扫描根的归档目录；非扫描根内文件返回 undefined */
	private archiveDirFor(filePath: string): string | undefined {
		const root = this.findSessionsRootForFile(filePath);
		if (!root) return undefined;
		return this.joinRuntimePath(root, SessionScanner.ARCHIVE_DIR_NAME);
	}

	/**
	 * 归档会话：把 JSONL（连同同级子会话目录）移入归档目录，并写入索引。
	 * 支持 WSL 路径；返回归档后的文件路径。
	 */
	async archive(filePath: string): Promise<string> {
		const wsl = this.isWslPath(filePath);
		const archiveDir = this.archiveDirFor(filePath);
		if (!archiveDir) throw new Error("会话不在可扫描目录内，无法归档");
		// 归档目标 = 归档目录 + 原文件名；重名时追加时间戳避免覆盖已有归档。
		const target = this.joinRuntimePath(archiveDir, basename(filePath));
		const finalTarget = existsSync(target) || (wsl && (await this.existsWslFile(target))) ? this.joinRuntimePath(archiveDir, `${basename(filePath, extname(filePath))}.${Date.now()}${extname(filePath)}`) : target;

		if (wsl) {
			await this.mkdirWsl(archiveDir);
			await this.moveWsl(filePath, finalTarget);
		} else {
			await mkdir(archiveDir, { recursive: true });
			await rename(filePath, finalTarget);
		}
		// 同级子会话目录（<stem>/）一并移入归档，保持子会话归属。
		const siblingDir = this.getSiblingDir(filePath);
		if (siblingDir) {
			const targetSibling = this.joinRuntimePath(archiveDir, basename(siblingDir));
			if (wsl) {
				if (await this.existsWslDir(siblingDir)) await this.moveWsl(siblingDir, targetSibling);
			} else if (existsSync(siblingDir)) {
				await rename(siblingDir, targetSibling);
			}
		}
		await this.recordArchiveEntry(finalTarget, filePath, wsl);
		// 归档会移动用户会话文件（含同级子会话目录），是会话可见性变化的原因，需可追溯
		getAppLogger()?.info("session", "Session archived", { from: filePath, to: finalTarget, wsl });
		return finalTarget;
	}

	/**
	 * 从归档恢复会话：按索引把文件移回原路径。
	 * 原路径已存在（被新建会话占用）时抛错，避免覆盖。
	 */
	async unarchive(archivedPath: string): Promise<string> {
		const wsl = this.isWslPath(archivedPath);
		const originalPath = await this.lookupArchiveOriginal(archivedPath, wsl);
		if (!originalPath) throw new Error("归档索引中找不到该会话");
		if (wsl ? await this.existsWslFile(originalPath) : existsSync(originalPath)) {
			throw new Error("原路径已被占用，无法恢复");
		}
		if (wsl) {
			await this.moveWsl(archivedPath, originalPath);
		} else {
			await rename(archivedPath, originalPath);
		}
		// 子会话目录一并移回
		const siblingDir = this.getSiblingDir(archivedPath);
		if (siblingDir) {
			const originalSibling = this.getSiblingDir(originalPath);
			if (originalSibling) {
				if (wsl ? await this.existsWslDir(siblingDir) : existsSync(siblingDir)) {
					if (wsl) await this.moveWsl(siblingDir, originalSibling);
					else await rename(siblingDir, originalSibling);
				}
			}
		}
		await this.removeArchiveEntry(archivedPath, wsl);
		getAppLogger()?.info("session", "Session restored from archive", { archivedPath, originalPath });
		return originalPath;
	}

	/**
	 * 当前环境的会话扫描根（最近一次 list() 记录的根集合；未扫描过时退回默认根）。
	 * 供目录导入判断「用户选的目录是不是会话树的祖先」（如 ~/.pi），这类目录命中必为 0 而需要提示。
	 */
	getSessionScanRoots(): string[] {
		if (this.activeScanRoots.length > 0) return [...this.activeScanRoots];
		return [this.defaultSessionsRoot];
	}

	/** 列出当前环境全部已归档会话（摘要从 JSONL 的 cwd 取 projectPath；原路径供恢复索引） */
	async listArchived(): Promise<ArchivedPiSession[]> {
		// 归档目录可能分布在任意扫描根下（默认全局根 + 项目 sessionDir），
		// 用最近一次 list() 记录的扫描根集合遍历；未扫描过时退回默认根。
		const roots = this.activeScanRoots.length > 0 ? this.activeScanRoots : this.wslConfig ? [this.wslSessionsDir] : [this.root];
		// 归档索引一次读齐（archivedPath → originalPath），避免逐文件反查重复读盘。
		const index = await this.readArchiveIndex(Boolean(this.wslConfig)).catch(() => ({}) as Record<string, string>);
		const results: ArchivedPiSession[] = [];
		const seen = new Set<string>();
		for (const root of roots) {
			const archiveDir = this.joinRuntimePath(root, SessionScanner.ARCHIVE_DIR_NAME);
			const files = this.wslConfig ? await this.collectJsonlFromDirWsl(archiveDir).catch(() => [] as string[]) : await this.collectJsonl(archiveDir).catch(() => [] as string[]);
			for (const file of files) {
				if (seen.has(this.normalize(file))) continue;
				seen.add(this.normalize(file));
				const summary = await this.readSummary(file).catch(() => null);
				if (!summary) continue;
				results.push({
					summary,
					// 索引缺失/损坏的极旧归档无法自动恢复；会话管理项目页会将其隐藏。
					...(index[file] ? { originalPath: index[file] } : {}),
				});
			}
		}
		return results.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
	}

	/**
	 * 永久删除已归档会话（区别于恢复）：把归档区 JSONL（连同同级子会话目录）移入系统回收站，
	 * 并从归档索引移除条目。只允许删除 .pideck-archive 目录内的文件，防路径穿越。
	 * 幂等：归档文件已被外部清理时视为成功。
	 */
	async deleteArchived(archivedPath: string): Promise<void> {
		const wsl = this.isWslPath(archivedPath);
		const archiveDir = this.archiveDirFor(archivedPath);
		if (!archiveDir) throw new Error("归档文件不在可扫描目录内，无法删除");
		// 安全防护：归档路径必须直接位于某扫描根的 .pideck-archive 目录下，拒绝跨目录删除。
		if (this.normalize(dirname(archivedPath)) !== this.normalize(archiveDir)) {
			throw new Error("归档文件不在归档目录内，拒绝删除");
		}
		// 先删同级子会话目录，再删文件本体（与 delete() 同语义，均走系统回收站）。
		if (wsl) {
			await this.deleteWslSiblingDir(archivedPath);
			await this.deleteWslFile(archivedPath);
		} else {
			await this.deleteSiblingDir(archivedPath);
			if (existsSync(archivedPath)) await this.trashWithRetry(archivedPath, "session-file");
		}
		await this.removeArchiveEntry(archivedPath, wsl);
		getAppLogger()?.info("session", "Archived session deleted permanently", { archivedPath, wsl });
	}

	/** 通过 wsl.exe 移动文件/目录 */
	private moveWsl(srcPath: string, dstPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "mv", "-f", srcPath, dstPath],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => {
					if (err) reject(err);
					else resolve();
				},
			);
		});
	}

	/** 读归档索引（JSON：{ archivedPath: originalPath }） */
	private async readArchiveIndex(wsl: boolean): Promise<Record<string, string>> {
		const roots = wsl ? [this.wslSessionsDir] : [this.root];
		const merged: Record<string, string> = {};
		for (const root of roots) {
			const indexPath = this.joinRuntimePath(root, SessionScanner.ARCHIVE_DIR_NAME, SessionScanner.ARCHIVE_INDEX_NAME);
			try {
				const raw = wsl ? await this.readWslFile(indexPath) : await readFile(indexPath, "utf8");
				Object.assign(merged, JSON.parse(raw) as Record<string, string>);
			} catch {
				// 索引缺失/损坏视为空归档；归档操作会重新写入。
			}
		}
		return merged;
	}

	/** 写入归档索引（合并现有条目 + 新增/删除） */
	private async writeArchiveIndex(entries: Record<string, string>, wsl: boolean): Promise<void> {
		const archiveDir = wsl ? this.joinRuntimePath(this.wslSessionsDir, SessionScanner.ARCHIVE_DIR_NAME) : join(this.root, SessionScanner.ARCHIVE_DIR_NAME);
		const content = JSON.stringify(entries, null, 2);
		if (wsl) {
			await this.mkdirWsl(archiveDir);
			await this.writeWslFile(this.joinRuntimePath(archiveDir, SessionScanner.ARCHIVE_INDEX_NAME), content);
		} else {
			await mkdir(archiveDir, { recursive: true });
			await writeFile(join(archiveDir, SessionScanner.ARCHIVE_INDEX_NAME), content, "utf8");
		}
	}

	/** 新增归档索引条目 */
	private async recordArchiveEntry(archivedPath: string, originalPath: string, wsl: boolean): Promise<void> {
		const entries = await this.readArchiveIndex(wsl);
		entries[archivedPath] = originalPath;
		await this.writeArchiveIndex(entries, wsl);
	}

	/** 删除归档索引条目 */
	private async removeArchiveEntry(archivedPath: string, wsl: boolean): Promise<void> {
		const entries = await this.readArchiveIndex(wsl);
		if (!(archivedPath in entries)) return;
		delete entries[archivedPath];
		await this.writeArchiveIndex(entries, wsl);
	}

	/** 按归档路径查原始路径 */
	private async lookupArchiveOriginal(archivedPath: string, wsl: boolean): Promise<string | undefined> {
		const entries = await this.readArchiveIndex(wsl);
		return entries[archivedPath];
	}

	/** 通过 wsl.exe 递归列出目录下 *.jsonl（供归档目录扫描） */
	private collectJsonlFromDirWsl(dir: string): Promise<string[]> {
		return new Promise((resolve, reject) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "find", dir, "-name", "*.jsonl", "-type", "f"],
				{
					encoding: "utf8",
					timeout: 15_000,
					windowsHide: true,
					shell: this.wslShell,
					// 与 collectWslJsonl 同理，目录列表极端情况下兑底防 maxBuffer 溢出。
					maxBuffer: 16 * 1024 * 1024,
				},
				(err, stdout) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(stdout.trim().split(/\r?\n/).filter(Boolean));
				},
			);
		});
	}

	/**
	 * 获取 JSONL 文件同级子会话目录路径。
	 * 例如 /path/to/stem.jsonl → /path/to/stem/
	 * 如果 filePath 不以 .jsonl 结尾或求得的目录与 sessions 根相同，返回 undefined。
	 */
	private getSiblingDir(filePath: string): string | undefined {
		if (!filePath.toLowerCase().endsWith(".jsonl")) return undefined;
		const dir = filePath.replace(/\.jsonl$/i, "");
		// 安全防护：不删除 sessions 根目录
		if (this.normalize(dir) === this.normalize(this.root)) return undefined;
		return dir;
	}

	/** 删除 Windows 同级子会话目录（如果存在） */
	private async deleteSiblingDir(filePath: string): Promise<void> {
		const siblingDir = this.getSiblingDir(filePath);
		if (!siblingDir || !existsSync(siblingDir)) return;
		// 同级子会话目录同样走系统回收站；失败抛错（拒绝静默硬删）。
		await this.trashWithRetry(siblingDir, "sibling-dir");
	}

	/**
	 * 尽力清理同级子会话目录：失败只记日志，不影响文件本体的删除结果。
	 * 子会话可能仍被运行中的子 agent 占用，这属于「目录里还有活会话」，
	 * 不该把父会话的删除整个报成失败（issue #364）。
	 */
	private async deleteSiblingDirBestEffort(filePath: string): Promise<void> {
		try {
			await this.deleteSiblingDir(filePath);
		} catch (error) {
			getAppLogger()?.warn("session", "Sibling session dir trash failed (ignored)", {
				filePath,
				code: errorCodeOf(error),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * 把路径移入系统回收站，失败时有限重试。
	 *
	 * Windows 上 pi 被 kill 后可能仍短暂持有会话 JSONL 的写句柄，此时 shell.trashItem
	 * 只返回通用的「Failed to perform delete operation」，无法从错误里区分「被占用」还是
	 * 「路径不存在」，因此统一按短间隔重试；路径已消失即视为成功（删除幂等）。
	 * 重试用尽仍失败时抛带 code/target/attempts 的结构化错误，供上层记录可诊断日志
	 * 并给用户可操作提示（issue #364）。
	 */
	private async trashWithRetry(targetPath: string, target: "session-file" | "sibling-dir"): Promise<void> {
		const attempts = 3;
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			try {
				await shell.trashItem(targetPath);
				return;
			} catch (error) {
				lastError = error;
				// 子目录/文件可能被并发删除或外部清理：路径已不存在即等同成功。
				if (!existsSync(targetPath)) return;
				getAppLogger()?.warn("session", "Trash target busy, retrying", {
					target,
					targetPath,
					attempt,
					attempts,
					code: errorCodeOf(error),
				});
				if (attempt < attempts) await delay(150 * attempt);
			}
		}
		const busy = new Error(this.translate("session.deleteFileBusy")) as Error & {
			code: string;
			target: string;
			attempts: number;
			errno?: string;
			cause?: unknown;
		};
		busy.code = "SESSION_FILE_BUSY";
		busy.target = target;
		busy.attempts = attempts;
		busy.errno = errorCodeOf(lastError);
		busy.cause = lastError;
		throw busy;
	}

	/** 删除 WSL 同级子会话目录（如果存在） */
	private async deleteWslSiblingDir(filePath: string): Promise<void> {
		const siblingDir = this.getSiblingDir(filePath);
		if (!siblingDir) return;
		// 安全防护：不删除 WSL sessions 根目录
		if (this.normalize(siblingDir) === this.normalize(this.wslSessionsDir)) return;
		// 检查目录是否存在
		const exists = await new Promise<boolean>((resolve) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-d", siblingDir],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
				(err) => resolve(!err),
			);
		});
		if (!exists) return;
		// 递归删除目录
		await new Promise<void>((resolve) => {
			execFile(
				this.wslExePath,
				["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "rm", "-rf", siblingDir],
				{
					shell: this.wslShell,
					encoding: "utf8",
					timeout: 10_000,
					windowsHide: true,
				},
				() => resolve(),
			); // 静默：失败不阻塞文件删除
		});
	}

	/**
	 * 复制会话文件并追加新的 session_info 名称记录（pi 原生格式，见 rename/#114）。
	 * 这不是 CLI 的 fork：不裁剪会话树，只生成一个可独立打开/继续的新历史会话文件。
	 * WSL 会话经 UNC 宿主路径走同一条流式复制（见 hostPathFor）。
	 */
	async copy(filePath: string): Promise<SessionSummary> {
		const wsl = this.isWslPath(filePath);
		const current = await this.readSummary(filePath).catch(() => null);
		const copyName = this.translate("session.copyTitle", {
			title: current?.name || this.translate("session.untitled"),
		});
		const targetPath = await this.nextCopyPath(filePath, wsl);
		// copiedFrom 作为附加字段保留来源信息；pi 会忽略未知字段，不影响加载。
		// 流式复制：大会话（数百 MB）整文件读入会撞 V8 单字符串上限/主进程堆上限；
		// 复制中途失败时删掉半截目标文件，避免留下一个「能看见但打不开」的会话。
		const sourceHostPath = this.hostPathFor(filePath);
		const targetHostPath = this.hostPathFor(targetPath);
		const appender = createSessionInfoAppender({ isLegacySessionNameEntry, extra: { copiedFrom: filePath } });
		try {
			await rewriteJsonlLines(sourceHostPath, targetHostPath, appender.transform);
			await appendFile(targetHostPath, `${appender.build(copyName)}\n`, "utf8");
		} catch (error) {
			await rm(targetHostPath, { force: true }).catch(() => {});
			throw error;
		}
		// 摘要仍按 Linux/catalog 路径读（readSummary 内部同样做宿主路径映射），
		// 保证 SessionSummary.id/filePath 保持 catalog 身份不变。
		const summary = await this.readSummary(targetPath);
		if (!summary) throw new Error("复制后的会话文件无法读取");
		return summary;
	}

	/** 将历史 JSONL 会话直接导出为基础 HTML，WSL 会话经 UNC 走同一条流式导出 */
	async exportHtml(filePath: string): Promise<{ path: string }> {
		return exportSessionHtml(this.htmlExportHost, filePath);
	}

	/**
	 * 读取会话消息列表（「引用历史会话消息」选择器用），支持 WSL 路径。
	 *
	 * 大会话必须流式读：整文件 `readFile + split` 在数百 MB 会话上会撞 V8 单字符串
	 * 上限（ERR_STRING_TOO_LONG）或主进程 384MB 堆上限（V8 abort → 应用闪退）。
	 * 返回值再叠一层条数/字节上限（只截尾，保留最近的），见 REFERENCE_MESSAGE_LIMIT。
	 *
	 * 取文口径是 `extractReferenceMessageText`（**不含 thinking**）：thinking 实测占这类会话
	 * 正文的八成以上，进来只会把引用上下文撑爆（见 shared/sessionReferenceContext 文件头）。
	 * 这里的条数/字节上限只保护 IPC 负载，真正的上下文预算在 buildSessionReferenceContext。
	 */
	async readMessages(filePath: string): Promise<Array<{ role: string; content: string; timestamp: number }>> {
		return readSessionMessages(this.messageReadHost, filePath);
	}

	/**
	 * 统一读取本地/WSL 会话原文（WSL 经 UNC 宿主路径，见 hostPathFor）。
	 *
	 * 注意：这是**整文件进内存**的接口，只适合确定较小的会话文件；大会话请走
	 * `SessionHistoryReader`（流式索引 + 按 offset 定向读单行）。超过
	 * MAX_IN_MEMORY_SESSION_BYTES 时直接抛错，避免重演「打开大会话即闪退」——
	 * 主进程 V8 老生代堆上限只有 384MB（见 v8HeapLimits.ts），几百 MB 的字符串
	 * 会让 V8 FatalProcessOutOfMemory abort 掉主进程，连堆栈都记不下来。
	 */
	async readSessionRawText(filePath: string): Promise<string> {
		const hostPath = this.hostPathFor(filePath);
		await this.assertInMemoryReadSafe(hostPath);
		return readFile(hostPath, "utf8");
	}

	/** 整文件读入前的体量护栏；超限抛可读错误而不是让 V8 终止进程。 */
	private async assertInMemoryReadSafe(filePath: string): Promise<void> {
		const info = await stat(filePath);
		if (info.size <= SessionScanner.MAX_IN_MEMORY_SESSION_BYTES) return;
		throw new Error(
			this.translate("session.fileTooLargeForWholeRead", {
				sizeMb: Math.round(info.size / (1024 * 1024)),
				limitMb: Math.round(SessionScanner.MAX_IN_MEMORY_SESSION_BYTES / (1024 * 1024)),
			}),
		);
	}

	/**
	 * 读会话文件并返回与 Agent 运行时完全一致的 ChatMessage[]。
	 * 使用与 AgentManager.convertAgentMessages 相同的提取逻辑：
	 *  - user 消息：extractMessageText + extractImages
	 *  - assistant 消息：extractMessageText + extractThinkingRaw
	 *  - toolResult 消息：配对前面的 toolCall 生成工具卡片
	 *  - compactionSummary：生成系统消息
	 */
	async readChatMessages(filePath: string): Promise<ChatMessage[]> {
		return readSessionChatMessages(this.messageReadHost, filePath);
	}

	// ── 内部私有方法 ─────────────────────────────────────────────

	private async nextCopyPath(filePath: string, wsl: boolean): Promise<string> {
		const dir = wsl ? posixDirname(filePath) : dirname(filePath);
		const ext = extname(filePath) || ".jsonl";
		const base = wsl ? posixBasename(filePath, ext) : basename(filePath, ext);
		for (let index = 1; index < 1000; index += 1) {
			const suffix = index === 1 ? "copy" : `copy-${index}`;
			const candidate = wsl ? posixJoin(dir, `${base}-${suffix}${ext}`) : join(dir, `${base}-${suffix}${ext}`);
			// WSL 路径必须真查存在性：否则永远返回 copy-1，重复复制会覆盖。
			if (wsl) {
				if (!(await this.existsWslFile(candidate))) return candidate;
				continue;
			}
			if (!existsSync(candidate)) return candidate;
		}
		throw new Error("无法生成唯一的复制会话文件名");
	}

	/**
	 * 从文件路径推断父会话文件路径。
	 *
	 * 算法：从子会话文件所在目录向上遍历，在每一层检查同级目录中是否存在
	 * <dirname>.jsonl 文件，并校验其内容为合法 Pi Agent 会话 JSONL。
	 *
	 * 支持的布局（任一扩展都可用）：
	 *   - pi-subagents:  <stem>/<run-id>/run-N/session.jsonl → 父 = <stem>.jsonl
	 *   - Claude Code 式: <stem>/subagents/agent-<id>.jsonl    → 父 = <stem>.jsonl
	 *   - 自定义嵌套:     <stem>/any/deep/path/session.jsonl   → 父 = <stem>.jsonl
	 *
	 * 深度限制 10 层，且不超出 sessions 根目录，避免误判和性能问题。
	 */
	private inferParentSessionFromPath(filePath: string): string | undefined {
		// 仅处理 .jsonl 文件
		if (!filePath.toLowerCase().endsWith(".jsonl")) return undefined;

		// 自定义 sessionDir 与默认根并存时，以包含该文件的最近扫描根为边界。
		const normalizedRoot = this.normalize(this.findSessionsRootForFile(filePath));
		let currentDir = dirname(filePath);

		for (let depth = 0; depth < 10; depth++) {
			const normalizedDir = this.normalize(currentDir);
			// 停止条件：到达或超出 sessions 根目录
			if (normalizedDir === normalizedRoot || !normalizedDir.startsWith(`${normalizedRoot}/`)) break;

			const dirName = basename(currentDir);
			if (!dirName) break;

			const parentDir = dirname(currentDir);
			const candidateParent = join(parentDir, `${dirName}.jsonl`);

			if (existsSync(candidateParent) && this.isSessionFile(candidateParent)) {
				return candidateParent;
			}

			currentDir = parentDir;
		}

		return undefined;
	}

	private isSessionFile(filePath: string): boolean {
		return isSessionFile(filePath);
	}

	/**
	 * WSL 子会话使用 Linux 绝对路径；Windows Node 的 path/fs 不能直接处理这类路径。
	 * 因此边界、路径拼接和父文件校验都必须走 posix + wsl.exe 读取链路。
	 */
	private async inferWslParentSessionFromPath(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!filePath.toLowerCase().endsWith(".jsonl") || !this.wslConfig) return undefined;

		const normalizedRoot = this.normalize(this.findSessionsRootForFile(filePath));
		let currentDir = posixDirname(filePath);
		for (let depth = 0; depth < 10; depth++) {
			const normalizedDir = this.normalize(currentDir);
			if (normalizedDir === normalizedRoot || !normalizedDir.startsWith(`${normalizedRoot}/`)) break;

			const dirName = posixBasename(currentDir);
			if (!dirName) break;
			const parentDir = posixDirname(currentDir);
			const candidateParent = posixJoin(parentDir, `${dirName}.jsonl`);
			if (await this.existsWslFile(candidateParent, signal)) {
				const head = await this.readWslFileHead(candidateParent, 4096, signal).catch(() => "");
				if (hasSessionHeader(head)) return candidateParent;
			}
			currentDir = parentDir;
		}
		return undefined;
	}

	private async listPathSummary(filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
		return listPathSummary(this.summaryReadHost, filePath, signal);
	}

	private sessionLocatorForPath(filePath: string, isWsl = this.isWslPath(filePath)): SessionLocator {
		return sessionLocatorFromLegacy({
			environment: isWsl ? "wsl" : "native",
			filePath,
			...(isWsl && this.wslConfig
				? {
						wslDistro: this.wslConfig.distro,
						wslUser: this.wslConfig.user,
					}
				: {}),
		});
	}

	private withSessionLocator(summary: SessionSummary): SessionSummary {
		if (summary.locator) return summary;
		return { ...summary, locator: this.sessionLocatorForPath(summary.filePath, summary.wsl === true || this.isWslPath(summary.filePath)) };
	}

	private async readSummary(filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
		return readSessionSummary(this.summaryReadHost, filePath, signal);
	}

	/** 应用退出前刷盘，保证本轮扫描结果可被下次启动复用。 */
	async flushSummaryCache(): Promise<void> {
		await this.summaryCache.flush();
	}

	private extractText(content: unknown): string {
		// 实现搬到 sessionNameLine.extractTextFromContent：与远端按需标题共用同一份提取口径。
		return extractTextFromContent(content);
	}

	// ── 标题与子会话探测（实现在 scanner/sessionTitleProbe.ts） ─────

	/** 标题探测的宿主持有面：有界读取、会话文件映射与 fork 父路径解析。 */
	private readonly titleProbeHost: SessionTitleProbeHost = {
		isWslPath: (filePath) => this.isWslPath(filePath),
		readWslFileHead: (filePath, maxBytes, signal) => this.readWslFileHead(filePath, maxBytes, signal),
		readWslFileTail: (filePath, maxBytes, signal) => this.readWslFileTail(filePath, maxBytes, signal),
		readWslFileVersion: (filePath, signal) => this.readWslFileVersion(filePath, signal),
		existsWslFile: (filePath, signal) => this.existsWslFile(filePath, signal),
		hostPathFor: (filePath) => this.hostPathFor(filePath),
		resolveForkParentPath: (filePath, forkParentSession, isWsl, sessionCwd, signal) => this.resolveForkParentPath(filePath, forkParentSession, isWsl, sessionCwd, signal),
	};

	/**
	 * 有界读文件头部推断会话标题（不读完整正文、不写摘要缓存）。
	 * 供 SessionCatalog 对新发现或未锁定 provisional 会话补名——轻量扫描（listPathSummary）不带 name，
	 * 未打开过的 pi 会话若只在打开/重命名时才能获得标题，侧栏会一直 Untitled。
	 */
	async inferSessionNameFromFile(filePath: string): Promise<string | undefined> {
		return inferSessionNameFromFile(this.titleProbeHost, filePath);
	}

	/**
	 * 读有界头部并同时校验会话头有效性：transcript 等无 type 头的产物会被标记
	 * valid:false，供 catalog 在 mergeScanned 时拒绝索引（#168）。读不到文件时
	 * 返回空对象（valid 缺省 = 不拒绝），兼容权限/锁定文件不被误删。
	 * nameFromSessionInfo 只描述 title 的文件来源；catalog 仅在首次发现或未确认的
	 * provisional 标题阶段采用该名称，后续 pi/TUI 改名不会覆盖 PiDeck 显示标题。
	 * `includeTitle:false` 只返回头部有效性和结构元数据，不读取尾部或小文件全文。
	 */
	async inferSessionNameAndValidity(
		filePath: string,
		options: { includeTitle?: boolean; includeFirstUserText?: boolean } = {},
	): Promise<{ name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean; fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string; firstUserText?: string }> {
		return inferSessionNameAndValidity(this.titleProbeHost, filePath, options);
	}

	/**
	 * 有界读取文件开头，取「文件内首条 user 文本」（其次首条 assistant 文本）。
	 *
	 * 与 readHeadAndInfer 的头/尾窗口不同：这里从头往后单调读，不会因为 64KB 头窗口还没读到第一条
	 * 用户消息（系统提示很大时很常见）就退化成「尾部某条消息」。用于 #266 存量自愈的指纹比对——
	 * 当年被锁进 catalog 的首句兜底来自实时视图的真首句，必须用同一基准才比得上。
	 *
	 * 读取有界（FIRST_MESSAGE_TITLE_MAX_BYTES）：超限时宁可放弃比对（保持原标题），不做无界扫描。
	 */
	async inferFirstMessageTitle(filePath: string, maxBytes = FIRST_MESSAGE_TITLE_MAX_BYTES): Promise<string | undefined> {
		return inferFirstMessageTitle(this.titleProbeHost, filePath, maxBytes);
	}

	/**
	 * 有界探测平铺子代理会话（@tintinweb/pi-subagents 形态）：
	 * 会话文件与父会话同目录平铺、文件名 <timestamp>_<sessionId>.jsonl，
	 * 路径推断（looksLikeNestedSessionPath）无法识别；它与 pi 原生 fork/branch
	 * 的文件形态完全一致（都带 parentSession header），唯一区分是 tintinweb 会
	 * setSessionName("<agent>#<id前8位>")，会话名以 #8 位十六进制结尾。
	 * 返回解析后的父会话路径；非 tintinweb 形态（fork/普通会话）返回 undefined。
	 * 仅读头部（SUMMARY_NAME_WINDOW_BYTES），不触碰完整正文。
	 */
	async probeTintinwebSubagentParent(filePath: string): Promise<string | undefined> {
		return probeTintinwebSubagentParent(this.titleProbeHost, filePath);
	}

	/**
	 * 由 fork/branch/tintinweb 子代理的 parentSession header 解析父会话路径。
	 * 仅允许引用当前 sessions 根目录内的现有文件（防路径穿越/误挂载），
	 * 本地/WSL 分别按平台语义拼接（绝对 Windows 路径用 resolve 而非 join，
	 * 否则盘符路径会在 join 时被重置）。解析失败返回 undefined，不抛异常。
	 *
	 * parentSession 的写入方有两种基准：pi 原生 fork/branch 传绝对路径或相对会话
	 * 文件所在目录的路径；@tintinweb/pi-subagents（≤0.19）传相对会话 cwd 的路径
	 * （如 `.pi\sessions\<stem>.jsonl`，项目级 sessionDir 场景），只按文件所在目录解析必然落空。
	 * 因此依次尝试「会话文件所在目录 → 会话 cwd」两个基准，返回第一个存在且在扫描根内的候选。
	 */
	private async resolveForkParentPath(filePath: string, forkParentSession: string, isWsl: boolean, sessionCwd?: string, signal?: AbortSignal): Promise<string | undefined> {
		const normalizedForkParent = forkParentSession.replace(/\\/g, "/");
		const candidates: string[] = [];
		const fileDir = isWsl ? posixDirname(filePath) : dirname(filePath);
		candidates.push(isWsl ? posixJoin(fileDir, normalizedForkParent) : resolve(fileDir, forkParentSession));
		if (sessionCwd) {
			// WSL 会话的 cwd 是发行版内 posix 路径；本地是 Windows 绝对路径，resolve 直接吃绝对 parentSession。
			candidates.push(isWsl ? posixJoin(this.normalize(sessionCwd), normalizedForkParent) : resolve(sessionCwd, forkParentSession));
		}
		const normalizedSessionsRoot = this.normalize(this.findSessionsRootForFile(filePath));
		for (const resolved of candidates) {
			const normalizedResolved = this.normalize(resolved);
			const isInsideSessionsRoot = normalizedResolved !== normalizedSessionsRoot && normalizedResolved.startsWith(`${normalizedSessionsRoot}/`);
			if (!isInsideSessionsRoot) continue;
			const resolvedExists = isWsl ? await this.existsWslFile(resolved, signal) : existsSync(resolved);
			if (resolvedExists) return resolved;
		}
		return undefined;
	}

	// ── 路径归属推导（实现在 scanner/sessionPathDerivation.ts） ────────

	/** 路径推导的宿主持有面：每次取当前扫描根与默认根（activeScanRoots 随 list() 变化）。 */
	private get scanRoots(): SessionScanRootsHost {
		return { activeScanRoots: this.activeScanRoots, defaultSessionsRoot: this.defaultSessionsRoot };
	}

	/** 路径比「sessions 根下的单层 jsonl」更深，才值得做父会话探测。 */
	private looksLikeNestedSessionPath(filePath: string): boolean {
		return looksLikeNestedSessionPath(this.scanRoots, filePath);
	}

	private inferProjectPathFromFile(filePath: string) {
		return inferProjectPathFromFile(filePath);
	}

	/** 找到包含 filePath 的最近（最长路径）扫描根。 */
	private findSessionsRootForFile(filePath: string): string {
		return findSessionsRootForFile(this.scanRoots, filePath);
	}

	private isSameProject(summary: SessionSummary, projectPath: string) {
		return isSameProject(this.scanRoots, summary, projectPath);
	}

	private isUnderProjectSessionDir(filePath: string, projectPath: string): boolean {
		return isUnderProjectSessionDir(this.scanRoots, filePath, projectPath);
	}

	private canonicalProjectPath(path: string, wsl: boolean) {
		return canonicalSessionPath(path, wsl);
	}

	private normalize(path: string) {
		return normalizeSessionPath(path);
	}

	private safePathToken(path: string) {
		return sessionPathToken(path);
	}
}
