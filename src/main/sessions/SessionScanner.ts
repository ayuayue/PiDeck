import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app, shell } from "electron";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { mkdir, open as openFile, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { basename as posixBasename, dirname as posixDirname, isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path/posix";
import type { ArchivedPiSession, ChatMessage, ChatRole, SessionSummary } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import { isInSubagentArtifactsDir, isValidPiSessionFileHead, looksLikePiSessionFileStem, SUBAGENT_ARTIFACTS_DIR_NAME } from "../../shared/sessionIdentity";
import { extractMessageText, extractThinkingRaw } from "../pi/messageContent";
import { toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";
import { getAppLogger } from "../logging/sharedLogger";
import {
  isLegacySessionNameEntry,
  isLegacySessionNameLine,
  stripLegacySessionNameLine,
  tryRestorePathGluedHeader,
} from "./sessionNameLine";
import { SessionSummaryCache, type SessionFileVersion } from "./sessionSummaryCache";

type SessionScannerCopyKey = Extract<MainProcessTranslationKey,
  | "session.untitled"
  | "session.emptyPreview"
  | "session.copyTitle"
>;

type SessionScannerCopy = (
  key: SessionScannerCopyKey,
  params?: Record<string, string | number>,
) => string;

const defaultSessionScannerCopy: Record<SessionScannerCopyKey, string> = {
  "session.untitled": "Untitled",
  "session.emptyPreview": "空会话",
  "session.copyTitle": "{title} copy",
};

function defaultTranslate(
  key: SessionScannerCopyKey,
  params: Record<string, string | number> = {},
): string {
  return defaultSessionScannerCopy[key].replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

/** catalog 扫描只取摘要字段；JSONL 行形态不固定，未知字段忽略。 */
type SessionScanMessage = {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  /** 生图消息标识：PiDeck 本地写入的 api=openai-images 或 imageGen 元数据 */
  api?: string;
  imageGen?: unknown;
};

type SessionScanLine = {
  type?: string;
  customType?: string;
  name?: string;
  sessionName?: string;
  cwd?: string;
  projectPath?: string;
  parentSession?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  codexSessionId?: string;
  sourcePath?: string;
  threadSource?: string;
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
  role?: string;
  content?: unknown;
  model?: string;
  message?: SessionScanMessage;
  data?: {
    name?: string;
    cwd?: string;
    message?: SessionScanMessage;
    session?: { cwd?: string };
  };
  header?: { name?: string; cwd?: string; parentSession?: string };
  session?: { name?: string; cwd?: string };
};

function isSessionScanLine(value: unknown): value is SessionScanLine {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 清洗会话标题候选：时间戳文件名 / 纯 untitled 不算标题；标题本身不做存储截断。 */
function cleanScanTitle(value?: string): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  // 时间戳文件名不是会话名：跳过才能回退到首条 user/assistant 文本。
  if (!text || /^untitled$/i.test(text) || looksLikePiSessionFileStem(text)) return undefined;
  // 侧栏负责视觉窗口与 hover 滚动；这里必须保留 session_info 的完整名称，尤其是末尾的 (fork)。
  return text;
}

/**
 * 从已解析的 JSONL 行序列推断会话标题（与 readSummary 的 inferredName 同一优先级：
 * session_info 名 > 旧版私有 sessionName > 首条 user 文本 > 首条 assistant 文本）。
 * 推断不出返回 undefined（空文件/只有 tool 消息），由调用方兜底 Untitled。
 *
 * @returns { name, fromSessionInfo }：fromSessionInfo 标记标题是否直接取自 session_info
 *（或旧版私有 sessionName 行）——只有这类权威来源才允许覆盖 catalog 已有真实标题；
 * 首条消息回退是弱信号，会话文件变大后 session_info 可能落在头/尾窗口盲区，
 * 弱回退不能把用户/自动命名的标题冲掉（2026-09 用户现场）。
 */
function inferScanNameFromLines(
  lines: string[],
  extractText: (content: unknown) => string,
): { name?: string; fromSessionInfo: boolean } {
  let latestSessionInfoName: string | undefined;
  let name: string | undefined;
  let firstUserText = "";
  let firstAssistantText = "";
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 头部截断的半行/损坏行：跳过，不影响标题推断。
      continue;
    }
    if (!isSessionScanLine(parsed)) continue;
    const entry = parsed;
    if (entry.type === "session_info") {
      // Forked sessions may contain an older copied name; only the latest marker is authoritative.
      latestSessionInfoName = typeof entry.name === "string" ? entry.name : entry.data?.name;
    }
    name ||= entry.sessionName || entry.name || entry.data?.name || entry.header?.name || entry.session?.name;
    const nested = entry.message ?? entry.data?.message;
    const message: SessionScanMessage = nested ?? { role: entry.role, content: entry.content };
    if (message.role) {
      const text = extractText(message.content).trim();
      if (text && message.role === "user" && !firstUserText) firstUserText = text;
      if (text && message.role === "assistant" && !firstAssistantText) firstAssistantText = text;
    }
  }
  // 取出 clean 前先保留「是否来自 session_info」判定：clean 后也可能是 timestamp/stem，
  // 此时权威性随其一并失效（时间戳名同样不能覆盖真实标题）。
  const infoName = cleanScanTitle(latestSessionInfoName) || cleanScanTitle(name);
  if (infoName) return { name: infoName, fromSessionInfo: true };
  const fallback = cleanScanTitle(firstUserText) || cleanScanTitle(firstAssistantText);
  if (fallback) return { name: fallback, fromSessionInfo: false };
  return { name: undefined, fromSessionInfo: false };
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
  /** 摘要只读文件前缀：catalog 不需要整份历史，1MB 足够取 cwd/预览/模型。 */
  private static readonly SUMMARY_PARSE_MAX_BYTES = 1024 * 1024;
  /** 轻量补名读取窗口：头部用于校验会话/首条消息，尾部用于捕获 pi `/name` 追加的最新 session_info。 */
  private static readonly SUMMARY_NAME_WINDOW_BYTES = 64 * 1024;
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

  constructor(private readonly translate: SessionScannerCopy = defaultTranslate) {}

  /**
   * wsl.exe 命令与启动模式。优先绝对路径，
   * 文件不存在时回退到 shell PATH 查找。
   */
  private resolveWslExe(): { command: string; shell: boolean } {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidates = process.arch === "ia32"
      ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")]
      : [join(systemRoot, "System32", "wsl.exe")];
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
    this.wslConfig = environment
      ? { distro: environment.distro, user: environment.user, home: environment.linuxHome }
      : null;
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

  /** 判断文件路径是否为 WSL Linux 路径（以 / 开头且属于当前 WSL 配置） */
  private isWslPath(filePath: string): boolean {
    if (!this.wslConfig) return false;
    // WSL 路径是 Linux 绝对路径（以 / 开头且不以盘符开头）
    return filePath.startsWith("/") && !/^[A-Za-z]:/.test(filePath);
  }

  // ── WSL 文件操作封装 ───────────────────────────────────────────

  /** 通过 wsl.exe 读取文件内容 */
  private readWslFile(wslPath: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "cat", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 10_000,
        signal,
        windowsHide: true,
        // 会话 JSONL 可能很大（单条 thinking 块可到 600KB+，千条消息轻松超 1MB）；
        // Node execFile 默认 maxBuffer=1MB，超出会抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，
        // 导致 readSummary 返回 null、会话从列表消失（#147）。64MB 覆盖常见大会话。
        maxBuffer: 64 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  /** 通过 wsl.exe 只读取文件头部，避免父会话校验反复传输大型 JSONL。 */
  private readWslFileHead(wslPath: string, maxBytes = 4096, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, [
        "-d", this.wslConfig!.distro, "-u", this.wslConfig!.user,
        "head", "-c", String(maxBytes), "--", wslPath,
      ], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        signal,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  /** 通过 wsl.exe 读取文件尾部；pi `/name` 会把权威 session_info 追加在日志末尾。 */
  private readWslFileTail(wslPath: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, [
        "-d", this.wslConfig!.distro, "-u", this.wslConfig!.user,
        "tail", "-c", String(maxBytes), "--", wslPath,
      ], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        signal,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  /** 通过 wsl.exe 写入文件内容 */
  private writeWslFile(wslPath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 用 dd of= 从 stdin 写入：不做 stdout 回显（tee 会把内容回显，大文件回写时
      // 同样撞 1MB maxBuffer，Node 会 kill 子进程，文件可能只写一半——#147 同家族问题）。
      // 内容走 stdin 传参，天然避开 heredoc/特殊字符问题；of= 作为单一参数传给 dd，
      // 含空格路径也安全（数组传参不会被拆分）。
      const proc = execFile(
        this.wslExePath,
        ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "dd", `of=${wslPath}`, "bs=1M"],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
        (err) => { if (err) reject(err); else resolve(); }
      );
      if (proc.stdin) {
        proc.stdin.end(content);
      }
    });
  }

  /** 通过 wsl.exe 获取缓存判定所需的修改时间和大小。 */
  private readWslFileVersion(wslPath: string, signal?: AbortSignal): Promise<SessionFileVersion> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "stat", "-c", "%Y %s", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        signal,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const [mtimeSeconds, size] = stdout.trim().split(/\s+/).map(Number);
        resolve({ mtimeMs: mtimeSeconds * 1000, size });
      });
    });
  }

  /** 通过 wsl.exe 删除文件 */
  private deleteWslFile(wslPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "rm", "-f", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => { if (err) reject(err); else resolve(); });
    });
  }

  /** 通过 wsl.exe 复制文件 */
  private copyWslFile(srcPath: string, dstPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "cp", srcPath, dstPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => { if (err) reject(err); else resolve(); });
    });
  }

  /** 归档写入前先保证 WSL 目标目录存在。 */
  private mkdirWsl(dirPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "mkdir", "-p", "--", dirPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => { if (err) reject(err); else resolve(); });
    });
  }

  /** 通过 wsl.exe 检查文件是否存在 */
  private existsWslFile(wslPath: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-f", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        signal,
        windowsHide: true,
      }, (err) => { resolve(!err); });
    });
  }

  // ── 会话列表扫描 ─────────────────────────────────────────────

  /** 通过 wsl.exe 在指定目录递归查找 *.jsonl，返回 Linux 绝对路径 */
  private async collectWslJsonl(sessionsDir: string, signal?: AbortSignal): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, [
        "-d", this.wslConfig!.distro, "-u", this.wslConfig!.user,
        // 跳过归档目录（.pideck-archive）与回收目录（.trash）：归档会话不参与常规扫描。
        // subagent-artifacts 是 pi-subagents 产物转储，不是会话文件，与本地 collectJsonl 同口径排除。
        "find", sessionsDir, "-name", "*.jsonl", "-type", "f",
        "-not", "-path", `*/${SessionScanner.ARCHIVE_DIR_NAME}/*`,
        "-not", "-path", `*/${SUBAGENT_ARTIFACTS_DIR_NAME}/*`
      ], {
        encoding: "utf8",
        timeout: 15_000,
        signal,
        windowsHide: true,
        shell: this.wslShell,
        // 目录列表通常远小于 1MB，但极端场景（上万文件）下兑底防 maxBuffer 溢出。
        maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) { reject(err); return; }
        const files = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(files);
      });
    });
  }

  async list(projectPath?: string): Promise<SessionSummary[]> {
    const run = this.listQueue.then(
      () => this.listUnqueued(projectPath),
      () => this.listUnqueued(projectPath),
    );
    this.listQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async listUnqueued(projectPath?: string): Promise<SessionSummary[]> {
    // 匹配用路径：WSL 模式下转 /mnt/...，与会话 JSONL 内 cwd 对齐。
    const normalizedProjectPath = projectPath && this.wslConfig
      ? toWslLinuxPath(projectPath, this.wslConfig)
      : projectPath;
    // WSL 扫描会启动大量外部命令；整体 watchdog 必须早于 renderer 超时，
    // 这样超时会真正终止底层 wsl.exe，而不是只释放前端锁后继续堆积扫描。
    const controller = this.wslConfig ? new AbortController() : null;
    const signal = controller?.signal;
    const scanTimer = controller
      ? setTimeout(() => controller.abort(new Error("Session scan timed out")), this.scanTimeoutMs)
      : null;
    const rethrowAbort = <T>(fallback: T) => (error: unknown): T => {
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
      const files = this.wslConfig
        ? await this.collectFromRootsWsl(scanRoots, signal).catch(rethrowAbort([] as string[]))
        : await this.collectFromRootsLocal(scanRoots);
      const fileSetKey = [...files].sort().join("\n");
      if (fileSetKey !== this.summaryCacheFileSetKey) {
        // 仅修剪当前环境下已消失文件，保留未变化会话的摘要命中（含磁盘恢复的条目）。
        this.summaryCache.prune(files, this.wslConfig ? "wsl" : "local");
        this.summaryCacheFileSetKey = fileSetKey;
      }

      // 侧栏列表只认路径 + stat：正文留给点击后的轮次历史页。
      // 打包目录可有数百 JSONL，再在 list() 里 parse 会占满主进程，点击/输入跟着卡。
      const summaries = await this.mapLimited(
        files,
        SessionScanner.SUMMARY_READ_CONCURRENCY,
        (file) => this.listPathSummary(file, signal).catch(rethrowAbort(null)),
      );
      signal?.throwIfAborted();

      const validSummaries = summaries.filter((summary): summary is SessionSummary => Boolean(summary));

      if (!normalizedProjectPath) {
        return validSummaries.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      const filtered = validSummaries
        .filter((summary) => this.isSameProject(summary, normalizedProjectPath))
        .sort((a, b) => b.updatedAt - a.updatedAt);
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
  private async resolveScanRoots(
    hostProjectPath?: string,
    runtimeProjectPath?: string,
  ): Promise<string[]> {
    const roots: string[] = [this.defaultSessionsRoot];
    if (!hostProjectPath || !runtimeProjectPath) return roots;

    const configured = await this.resolveConfiguredSessionDir(hostProjectPath, runtimeProjectPath);
    if (!configured) return roots;

    const normalizedConfigured = this.normalize(configured);
    if (roots.some((root) => this.normalize(root) === normalizedConfigured)) return roots;

    const exists = this.wslConfig
      ? await this.existsWslDir(configured)
      : existsSync(configured);
    if (exists) roots.push(configured);
    return roots;
  }

  /**
   * 读取 pi 的 sessionDir 配置并解析为可扫描绝对路径。
   * 优先级：项目 `.pi/settings.json` > 全局 `~/.pi/agent/settings.json`。
   */
  private async resolveConfiguredSessionDir(
    hostProjectPath: string,
    runtimeProjectPath: string,
  ): Promise<string | undefined> {
    const projectSettingsPath = join(this.toHostReadablePath(hostProjectPath), ".pi", "settings.json");
    const projectRaw = await this.readSessionDirSettingLocal(projectSettingsPath);

    const globalRaw = this.wslConfig
      ? await this.readSessionDirSettingWsl(`${this.wslConfig.home}/.pi/agent/settings.json`)
      : await this.readSessionDirSettingLocal(join(app.getPath("home"), ".pi", "agent", "settings.json"));

    const raw = projectRaw ?? globalRaw;
    if (!raw) return undefined;
    return this.resolveSessionDirPath(raw, runtimeProjectPath);
  }

  private async readSessionDirSettingLocal(settingsPath: string): Promise<string | undefined> {
    try {
      if (!existsSync(settingsPath)) return undefined;
      const raw = await readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as { sessionDir?: unknown };
      return typeof parsed.sessionDir === "string" && parsed.sessionDir.trim()
        ? parsed.sessionDir.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async readSessionDirSettingWsl(settingsPath: string): Promise<string | undefined> {
    try {
      const raw = await this.readWslFile(settingsPath);
      const parsed = JSON.parse(raw) as { sessionDir?: unknown };
      return typeof parsed.sessionDir === "string" && parsed.sessionDir.trim()
        ? parsed.sessionDir.trim()
        : undefined;
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
      return this.wslConfig
        ? `${home}/${input.slice(2).replace(/\\/g, "/")}`
        : join(home, input.slice(2));
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
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-d", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => resolve(!err));
    });
  }

  private async collectFromRootsLocal(roots: string[]): Promise<string[]> {
    const all: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const files = await this.collectJsonl(root).catch(() => [] as string[]);
      for (const file of files) {
        const key = this.normalize(file);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(file);
      }
    }
    return all;
  }

  private async collectFromRootsWsl(roots: string[], signal?: AbortSignal): Promise<string[]> {
    const all: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const files = await this.collectWslJsonl(root, signal).catch(() => [] as string[]);
      for (const file of files) {
        const key = this.normalize(file);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(file);
      }
    }
    return all;
  }

  /** 分块并发 + 块间让出事件循环，避免数百 JSONL 同时 parse 卡住点击/输入。 */
  private async mapLimited<T, R>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    const limit = Math.max(1, concurrency);
    for (let index = 0; index < items.length; index += limit) {
      const chunk = items.slice(index, index + limit);
      const mapped = await Promise.all(chunk.map((item) => mapper(item)));
      results.push(...mapped);
      if (index + limit < items.length) {
        // setTimeout(0) 兼容测试 VM（无 setImmediate），同样把控制权交回事件循环。
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
    return results;
  }

  // ── 会话操作：rename / delete / copy / exportHtml / readMessages ─

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
    const wsl = this.isWslPath(filePath);
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const output = this.appendSessionInfoLine(raw, newName);
    if (wsl) {
      await this.writeWslFile(filePath, output);
    } else {
      await writeFile(filePath, output, "utf8");
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
   * 命中才全量修复并回写；返回是否实际修复。支持 WSL 路径。
   */
  async repairCorruptSessionHeader(filePath: string): Promise<boolean> {
    const wsl = this.isWslPath(filePath);
    const head = wsl ? await this.readWslFileHead(filePath) : await this.readFileHeadNative(filePath, 4096);

    // 模式 1：旧版私有头行（只会出现在文件头部区域；中后段同类行不阻塞 pi 加载，
    // 留待重命名时一并清理，与既有行为一致）
    if (hasLegacySessionNameLine(head)) {
      const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
      const stripped = stripLegacySessionNameLine(raw);
      if (stripped === raw) return false;
      if (wsl) {
        await this.writeWslFile(filePath, stripped);
      } else {
        await writeFile(filePath, stripped, "utf8");
      }
      return true;
    }

    // 模式 2：首行路径粘连（.jsonl{ + 合法 session header，见 tryRestorePathGluedHeader）
    const restoredFirstLine = tryRestorePathGluedHeader(head);
    if (restoredFirstLine !== null) {
      const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
      // 只重写第一行；其余行原样保留（含空行与末尾结构）
      const lines = raw.split(/\r?\n/);
      if (lines[0] === restoredFirstLine) return false;
      lines[0] = restoredFirstLine;
      const output = lines.join("\n");
      if (wsl) {
        await this.writeWslFile(filePath, output);
      } else {
        await writeFile(filePath, output, "utf8");
      }
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
   * 在 JSONL 文本末尾追加 pi 原生 session_info 记录，返回新文本。
   *
   * id/parentId 规则与 pi SessionManager 一致：id 为文件内不冲突的 8 位十六进制，
   * parentId 指向追加前最后一条带 id 的记录（没有则 null，由 pi 视为新根）。
   * 会话树靠 parentId 串联，指向最后一片叶子可保持链条完整。
   *
   * 同时剔除旧版 PiDeck 的 {"sessionName":...} 私有行（无 type 字段）：pi 无法识别，
   * 位于文件头时会破坏首行校验导致整个会话无法加载（#114 的存量受损文件）。
   */
  private appendSessionInfoLine(raw: string, name: string, extra?: Record<string, unknown>): string {
    // 与 pi appendSessionInfo 相同的清洗规则：换行折叠为空格，避免破坏 JSONL 行结构。
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    const ids = new Set<string>();
    let lastId: string | null = null;
    const keptLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 不可解析的行原样保留，不做破坏性清理
      }
      // 判定旧版私有格式：带 sessionName 且无 type（判定逻辑见 sessionNameLine.ts，与修复路径共用）
      if (parsed !== null && isLegacySessionNameEntry(parsed)) continue;
      if (parsed !== null && typeof (parsed as { id?: unknown }).id === "string" && (parsed as { id?: string }).id) {
        ids.add((parsed as { id: string }).id);
        lastId = (parsed as { id: string }).id;
      }
      keptLines.push(trimmed);
    }
    // 与 pi generateId 一致：randomUUID 前 8 位，冲突时重试
    let id = randomUUID().slice(0, 8);
    while (ids.has(id)) id = randomUUID().slice(0, 8);
    const entry = {
      type: "session_info",
      id,
      parentId: lastId,
      timestamp: new Date().toISOString(),
      name: sanitized,
      ...extra,
    };
    keptLines.push(JSON.stringify(entry));
    return `${keptLines.join("\n")}\n`;
  }

  /**
   * 删除会话文件，同时清理同级子会话目录（如果存在）。
   *
   * 目录结构约定：父会话 <stem>.jsonl 与子会话目录 <stem>/ 相邻。
   * 删除父会话时一并移除 <stem>/ 目录及其下所有子会话 JSONL，
   * 避免残留孤儿目录。仅删除单个子会话时（无同级目录）行为不变。
   */
  async delete(filePath: string): Promise<void> {
    if (this.isWslPath(filePath)) {
      // rm -f 语义保证“文件已被外部清理”与成功删除等价，避免重启后删空草稿报错。
      await this.deleteWslSiblingDir(filePath);
      await this.deleteWslFile(filePath);
      return;
    }

    // 先删除同级子会话目录（如果存在），再删除文件本身。
    await this.deleteSiblingDir(filePath);
    // catalog 可能保留一个已被 pi/系统回收站移走的历史路径；删除接口必须幂等。
    if (!existsSync(filePath)) return;

    // 删除会话是用户主动操作：统一移入系统回收站（可恢复）。
    // 回收站不可用时直接抛错——拒绝静默硬删，错误由 IPC 层呈现给用户。
    await shell.trashItem(filePath);
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
    const finalTarget = existsSync(target) || (wsl && await this.existsWslFile(target))
      ? this.joinRuntimePath(archiveDir, `${basename(filePath, extname(filePath))}.${Date.now()}${extname(filePath)}`)
      : target;

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
    return originalPath;
  }

  /** 列出当前环境全部已归档会话（供恢复 UI 展示；带归档前原始路径供按项目归属过滤） */
  async listArchived(): Promise<ArchivedPiSession[]> {
    // 归档目录可能分布在任意扫描根下（默认全局根 + 项目 sessionDir），
    // 用最近一次 list() 记录的扫描根集合遍历；未扫描过时退回默认根。
    const roots = this.activeScanRoots.length > 0
      ? this.activeScanRoots
      : this.wslConfig
        ? [this.wslSessionsDir]
        : [this.root];
    // 归档索引一次读齐（archivedPath → originalPath），避免逐文件反查重复读盘。
    const index = await this.readArchiveIndex(Boolean(this.wslConfig)).catch(() => ({} as Record<string, string>));
    const results: ArchivedPiSession[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const archiveDir = this.joinRuntimePath(root, SessionScanner.ARCHIVE_DIR_NAME);
      const files = this.wslConfig
        ? await this.collectJsonlFromDirWsl(archiveDir).catch(() => [] as string[])
        : await this.collectJsonl(archiveDir).catch(() => [] as string[]);
      for (const file of files) {
        if (seen.has(this.normalize(file))) continue;
        seen.add(this.normalize(file));
        const summary = await this.readSummary(file).catch(() => null);
        if (!summary) continue;
        results.push({
          summary,
          // 索引缺失/损坏的极旧归档没有原始路径：弹窗不展示（配置页仍可全局恢复）。
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
      if (existsSync(archivedPath)) await shell.trashItem(archivedPath);
    }
    await this.removeArchiveEntry(archivedPath, wsl);
  }

  /** 通过 wsl.exe 移动文件/目录 */
  private moveWsl(srcPath: string, dstPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "mv", "-f", srcPath, dstPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => { if (err) reject(err); else resolve(); });
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
    const archiveDir = wsl
      ? this.joinRuntimePath(this.wslSessionsDir, SessionScanner.ARCHIVE_DIR_NAME)
      : join(this.root, SessionScanner.ARCHIVE_DIR_NAME);
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
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "find", dir, "-name", "*.jsonl", "-type", "f"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        shell: this.wslShell,
        // 与 collectWslJsonl 同理，目录列表极端情况下兑底防 maxBuffer 溢出。
        maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) { reject(err); return; }
        resolve(stdout.trim().split(/\r?\n/).filter(Boolean));
      });
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
    await shell.trashItem(siblingDir);
  }

  /** 删除 WSL 同级子会话目录（如果存在） */
  private async deleteWslSiblingDir(filePath: string): Promise<void> {
    const siblingDir = this.getSiblingDir(filePath);
    if (!siblingDir) return;
    // 安全防护：不删除 WSL sessions 根目录
    if (this.normalize(siblingDir) === this.normalize(this.wslSessionsDir)) return;
    // 检查目录是否存在
    const exists = await new Promise<boolean>((resolve) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-d", siblingDir], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => resolve(!err));
    });
    if (!exists) return;
    // 递归删除目录
    await new Promise<void>((resolve) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "rm", "-rf", siblingDir], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }, () => resolve()); // 静默：失败不阻塞文件删除
    });
  }

  /**
   * 复制会话文件并追加新的 session_info 名称记录（pi 原生格式，见 rename/#114）。
   * 这不是 CLI 的 fork：不裁剪会话树，只生成一个可独立打开/继续的新历史会话文件。
   * 支持 WSL 路径。
   */
  async copy(filePath: string): Promise<SessionSummary> {    const wsl = this.isWslPath(filePath);
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const current = await this.readSummary(filePath).catch(() => null);
    const copyName = this.translate("session.copyTitle", {
      title: current?.name || this.translate("session.untitled"),
    });
    const targetPath = await this.nextCopyPath(filePath, wsl);
    // copiedFrom 作为附加字段保留来源信息；pi 会忽略未知字段，不影响加载。
    const content = this.appendSessionInfoLine(raw, copyName, { copiedFrom: filePath });

    if (wsl) {
      await this.writeWslFile(targetPath, content);
    } else {
      await writeFile(targetPath, content, "utf8");
    }
    const summary = await this.readSummary(targetPath);
    if (!summary) throw new Error("复制后的会话文件无法读取");
    return summary;
  }

  /** 将历史 JSONL 会话直接导出为基础 HTML，支持 WSL 路径 */
  async exportHtml(filePath: string): Promise<{ path: string }> {
    const wsl = this.isWslPath(filePath);
    const summary = await this.readSummary(filePath);
    if (!summary) throw new Error("会话文件无法读取");
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        const entry = JSON.parse(line) as any;
        const message = entry.message ?? entry.data?.message ?? entry;
        if (!message?.role) return "";
        const text = this.extractText(message.content).trim();
        if (!text) return "";
        return `<section class=\"msg ${this.escapeHtml(message.role)}\"><h2>${this.escapeHtml(message.role)}</h2><pre>${this.escapeHtml(text)}</pre></section>`;
      } catch {
        return "";
      }
    }).filter(Boolean).join("\n");
    const title = summary.name || this.translate("session.untitled");
    const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>${this.escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:920px;margin:32px auto;padding:0 20px;color:#1f2937}.msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.msg h2{margin:0 0 8px;font-size:13px;color:#64748b}.msg pre{white-space:pre-wrap;margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style></head><body><h1>${this.escapeHtml(title)}</h1><p>${new Date(summary.updatedAt).toLocaleString()} · ${summary.messageCount} messages</p>${rows}</body></html>`;
    const safeName = title.replace(/[\\/:*?\"<>|]/g, "_").slice(0, 80) || "session";
    const targetPath = join(app.getPath("downloads"), `${safeName}-${Date.now()}.html`);
    await writeFile(targetPath, html, "utf8");
    return { path: targetPath };
  }

  /** 读取会话消息列表，支持 WSL 路径 */
  async readMessages(filePath: string): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    const wsl = this.isWslPath(filePath);
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const messages: Array<{ role: string; content: string; timestamp: number }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type && entry.type !== "message") continue;
        if (entry.sessionName && !entry.message) continue;
        const message = (entry.message ?? (entry.data as Record<string, unknown> | undefined)?.message ?? entry) as Record<string, unknown> | undefined;
        if (!message?.role) continue;
        const content = this.extractText(message.content).trim();
        if (!content) continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        messages.push({ role: String(message.role), content, timestamp: Number(entry.ts ?? entry.timestamp ?? Date.now()) });
      } catch {
        // 单行解析失败跳过；大量失败说明 JSONL 结构异常，双写日志文件便于离线排查
        void getAppLogger()?.warn("session", "Skipped unparseable JSONL line", { filePath });
        console.warn(`[SessionScanner] 跳过无法解析的 JSONL 行: ${filePath}`);
      }
    }
    return messages;
  }

  /** 统一读取本地/WSL 会话原文，供 Viewer 与 AgentManager 共享转换管线。 */
  async readSessionRawText(filePath: string): Promise<string> {
    return this.isWslPath(filePath)
      ? this.readWslFile(filePath)
      : readFile(filePath, "utf8");
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
    const raw = await this.readSessionRawText(filePath);
    const lines = raw.split(/\r?\n/).filter(Boolean);

    // 第一遍：收集所有 toolCall，用于 toolResult 配对
    const toolCallsMap = new Map<string, { name: string; args: unknown }>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "message") {
          const msg = (entry.message as Record<string, unknown> | undefined);
          if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if ((block as Record<string, unknown>)?.type === "toolCall") {
                const tc = block as Record<string, unknown>;
                if (tc.id) {
                  toolCallsMap.set(String(tc.id), { name: String(tc.name ?? "tool"), args: tc.arguments });
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    // 第二遍：生成 ChatMessage[]
    const messages: ChatMessage[] = [];
    let seq = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "message") continue;
        const msg = (entry.message as Record<string, unknown> | undefined);
        if (!msg?.role) continue;
        const ts = Number(entry.timestamp ?? msg.timestamp ?? Date.now());

        if (msg.role === "user") {
          const text = extractMessageText(msg.content);
          if (!text.trim()) continue;
          const images = this.extractImagesFromContent(msg.content);
          messages.push({
            id: `sv-u-${seq++}`,
            agentId: "_viewer",
            role: "user",
            text,
            timestamp: ts,
            ...(images.length > 0 ? { images } : {}),
          });
        } else if (msg.role === "assistant") {
          const images = this.extractImagesFromContent(msg.content);
          // SessionFileEditor 将 extra 展开到 message 顶层，因此历史 JSONL
          // 实际字段是 message.api / message.imageGen，而不是 message.extra。
          const extraRecord = msg;
          // 旧历史只保存了 openai-images 标识，没有 imageGen 元数据；补齐标记后
          // 才能进入生图结果组件，显示复制/保存操作，而不是普通图片预览。
          const isImageGen = extraRecord.api === "openai-images" ||
            (extraRecord.imageGen && typeof extraRecord.imageGen === "object");
          const text = extractMessageText(msg.content) ||
            (isImageGen ? "[imagegen]" : "");
          if (!text.trim() && images.length === 0) continue;
          const thinking = extractThinkingRaw(msg.content);
          const imageGen = isImageGen
            ? (extraRecord.imageGen && typeof extraRecord.imageGen === "object"
              ? extraRecord.imageGen
              : { status: "complete", prompt: "" })
            : undefined;
          messages.push({
            id: `sv-a-${seq++}`,
            agentId: "_viewer",
            role: "assistant",
            text,
            timestamp: ts,
            ...(thinking ? { thinking } : {}),
            ...(images.length > 0 ? { images } : {}),
            ...(imageGen ? { meta: { imageGen } } : {}),
          });
        } else if (msg.role === "toolResult") {
          const toolCallId = String(msg.toolCallId ?? `sv-tool-${seq}`);
          const historicalCall = toolCallsMap.get(toolCallId);
          const toolName = String(msg.toolName ?? historicalCall?.name ?? "tool");
          const isError = Boolean(msg.isError);
          const icon = isError ? "✗" : "✓";
          messages.push({
            id: `sv-t-${seq++}`,
            agentId: "_viewer",
            role: "tool",
            text: `${icon} ${toolName}`,
            timestamp: ts,
            meta: {
              status: isError ? "error" : "done",
              toolName,
              toolCallId,
              isError,
            },
          });
        }
      } catch { /* skip malformed lines */ }
    }

    return messages.filter((m: ChatMessage) => m.text.trim());
  }

  /** 从 content 数组中提取图片附件 */
  private extractImagesFromContent(content: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
    if (!Array.isArray(content)) return [];
    return content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const typed = item as Record<string, unknown>;
      if (typed.type !== "image") return [];
      const data = typeof typed.data === "string" ? typed.data : "";
      const mimeType = typeof typed.mimeType === "string" ? typed.mimeType : "image/png";
      return data ? [{ type: "image" as const, data, mimeType }] : [];
    });
  }

  // ── 内部私有方法 ─────────────────────────────────────────────

  private async nextCopyPath(filePath: string, wsl: boolean): Promise<string> {
    const dir = wsl ? posixDirname(filePath) : dirname(filePath);
    const ext = extname(filePath) || ".jsonl";
    const base = wsl ? posixBasename(filePath, ext) : basename(filePath, ext);
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "copy" : `copy-${index}`;
      const candidate = wsl
        ? posixJoin(dir, `${base}-${suffix}${ext}`)
        : join(dir, `${base}-${suffix}${ext}`);
      // WSL 路径必须真查存在性：否则永远返回 copy-1，重复复制会覆盖。
      if (wsl) {
        if (!(await this.existsWslFile(candidate))) return candidate;
        continue;
      }
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("无法生成唯一的复制会话文件名");
  }

  private escapeHtml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  private async collectJsonl(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
        continue;
      }
      // 跳过归档目录：归档会话不参与常规扫描（.trash 同理不扫）。
      // 跳过 subagent-artifacts：pi-subagents 的产物转储目录（transcript 等），
      // 不是会话文件；混进扫描会让每个子代理在侧栏「嵌套 + 顶层平铺」重复显示。
      if (entry.name === SessionScanner.ARCHIVE_DIR_NAME || entry.name === SUBAGENT_ARTIFACTS_DIR_NAME) continue;
      files.push(...await this.collectJsonl(path));
    }

    return files;
  }

  /** 路径比「sessions 根下的单层 jsonl」更深，才值得做父会话探测。 */
  private looksLikeNestedSessionPath(filePath: string): boolean {
    const normalized = this.normalize(filePath);
    const root = this.normalize(this.findSessionsRootForFile(filePath));
    if (!normalized.startsWith(`${root}/`)) return false;
    const relative = normalized.slice(root.length + 1);
    return relative.split("/").length > 2;
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

  /**
   * 快速校验 Windows 本地路径是否为 Pi Agent 会话 JSONL（非备份/导出/重命名残留）。
   * 真实会话的首行通常是 `type: session`；兼容 PiDeck 重命名后前置的 sessionName 元数据，
   * 但要求随后仍出现 type 字段，不能只凭任意 JSON 对象误判为父会话。
   */
  private readLocalFileHead(filePath: string, maxBytes = 4096): string {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  }

  private isSessionFile(filePath: string): boolean {
    try {
      return this.hasSessionHeader(this.readLocalFileHead(filePath));
    } catch {
      return false;
    }
  }

  private hasSessionHeader(raw: string): boolean {
    for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 12)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return true;
      } catch {
        // 跳过无法解析的行（损坏/二进制残留），继续检查后续行中的 type 字段
        continue;
      }
    }
    return false;
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
        if (this.hasSessionHeader(head)) return candidateParent;
      }
      currentDir = parentDir;
    }
    return undefined;
  }

  /**
   * 侧栏 list() 专用：只 stat + 路径推断，不读 JSONL 正文。
   * 标题/预览留给 catalog；模型/思考在历史读取完成后回填；点开会话走轮次历史页。
   * 不写入 summaryCache——空标题一旦进缓存，会把后续真正的 readSummary 结果冻住。
   */
  private async listPathSummary(filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
    const isWsl = this.isWslPath(filePath);
    const info = isWsl
      ? await this.readWslFileVersion(filePath, signal)
      : await stat(filePath);
    const source = this.inferSourceFromFileName(filePath);
    // 只对明显嵌套的路径查父会话，避免每个顶层 JSONL 都走 exists/wsl.exe。
    const nested = this.looksLikeNestedSessionPath(filePath);
    const parentSessionPath = source === "pi" && nested
      ? (isWsl
        ? await this.inferWslParentSessionFromPath(filePath, signal)
        : this.inferParentSessionFromPath(filePath))
      : undefined;
    return {
      id: filePath,
      filePath,
      projectPath: this.inferProjectPathFromFile(filePath),
      preview: "",
      updatedAt: info.mtimeMs,
      messageCount: 0,
      source,
      parentSessionPath,
      wsl: isWsl || undefined,
      // originKey 对 Codex 导入含 importedSourceId；从文件名 codex_<id>.jsonl 还原，避免扫描后变成另一条记录。
      codexSessionId: source === "codex" ? this.inferImportedIdFromFileName(filePath, "codex_") : undefined,
    };
  }

  /** 导入器约定文件名：codex_<id>.jsonl / claude_<id>.jsonl / opencode_<id>.jsonl。 */
  private inferSourceFromFileName(filePath: string): NonNullable<SessionSummary["source"]> {
    const base = basename(filePath).toLowerCase();
    if (base.startsWith("codex_")) return "codex";
    if (base.startsWith("claude_")) return "claude";
    if (base.startsWith("opencode_")) return "opencode";
    return "pi";
  }

  private inferImportedIdFromFileName(filePath: string, prefix: string): string | undefined {
    const base = basename(filePath);
    if (!base.toLowerCase().startsWith(prefix) || !base.toLowerCase().endsWith(".jsonl")) return undefined;
    const id = base.slice(prefix.length, -".jsonl".length).trim();
    return id || undefined;
  }

  private async readSummary(filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
    // 先读取轻量文件指纹；未变化时复用摘要，避免周期扫描反复读取和解析全部 JSONL。
    const isWsl = this.isWslPath(filePath);
    const info = isWsl
      ? await this.readWslFileVersion(filePath, signal)
      : await stat(filePath);
		// schema v2：摘要新增 hasImageGen；不带 tag 的旧缓存缺字段，会一直不显示角标
		const version = { mtimeMs: info.mtimeMs, size: info.size, schema: 2 };
    const cached = this.summaryCache.get(filePath, version);
    if (cached !== undefined) return cached;

    // catalog 摘要只读前缀：整文件 parse 会在后台扫描时占满主线程，点击/输入跟着卡。
    const raw = isWsl
      ? await this.readWslFileHead(filePath, SessionScanner.SUMMARY_PARSE_MAX_BYTES, signal)
      : await this.readLocalFilePrefix(filePath, SessionScanner.SUMMARY_PARSE_MAX_BYTES);
    const truncated = version.size > SessionScanner.SUMMARY_PARSE_MAX_BYTES;
    const text = truncated
      ? raw.slice(0, Math.max(0, raw.lastIndexOf("\n")))
      : raw;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      this.summaryCache.set(filePath, version, null);
      return null;
    }

    let projectPath: string | undefined;
    const emptyPreview = this.translate("session.emptyPreview");
    let preview = emptyPreview;
    let messageCount = 0;
    /** 会话来源：扫描前几行检测导入标记 */
    let source: SessionSummary["source"] = "pi";
    let codexSessionId: string | undefined;
    let codexThreadSource: SessionSummary["codexThreadSource"];
    let codexParentThreadId: string | undefined;
    let codexAgentRole: string | undefined;
    let codexAgentNickname: string | undefined;
    let codexSourcePath: string | undefined;
    let latestSessionInfoName: string | undefined;
    let forkParentSession: string | undefined;
    let hasSubagentChildMarker = false;
    /** 最后一条 model_change / thinking_level_change 记录 */
    let modelProvider: string | undefined;
    let modelId: string | undefined;
    let thinkingLevel: string | undefined;
    /** 扫描范围内是否出现生图消息（侧栏图片角标用） */
    let hasImageGen = false;
    /** 最后一条 assistant 消息携带的 provider/model（旧格式兼容回退）。 */
    let lastAssistantModel: { provider: string; modelId: string } | undefined;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 损坏行或前缀截断的半行：跳过，不影响该会话摘要。
        continue;
      }
      if (!isSessionScanLine(parsed)) continue;
      const entry = parsed;
      if (entry.type === "session_info") {
        // Forked sessions may contain an older copied name; only the latest marker is authoritative.
        latestSessionInfoName = this.optionalString(entry.name ?? entry.data?.name);
      }
      if (entry.type === "session") {
        forkParentSession ||= this.optionalString(entry.parentSession ?? entry.header?.parentSession);
      }
      // 检测显式子会话标记：支持任何 "*.child-session" 格式，
      // 不仅限于 pi-subagents，未来其他扩展也可沿用此约定。
      if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType.endsWith(".child-session")) {
        hasSubagentChildMarker = true;
      }
      // 扫描前几行的非消息条目，检测导入来源标记
      if (source === "pi") {
        if (entry.type === "codex_import") {
          source = "codex";
          codexSessionId = this.optionalString(entry.codexSessionId);
          codexSourcePath = this.optionalString(entry.sourcePath);
          codexThreadSource = entry.threadSource === "subagent" ? "subagent" : "user";
          codexParentThreadId = this.optionalString(entry.parentThreadId);
          codexAgentRole = this.optionalString(entry.agentRole);
          codexAgentNickname = this.optionalString(entry.agentNickname);
        }
        else if (entry.type === "claude_import") source = "claude";
        else if (entry.type === "opencode_import") source = "opencode";
      }

      projectPath ||= entry.cwd || entry.projectPath || entry.header?.cwd || entry.data?.cwd || entry.session?.cwd || entry.data?.session?.cwd;

      // Track the last model_change / thinking_level_change so the catalog can
      // surface them to the renderer even when the Agent is not running.
      if (entry.type === "model_change") {
        modelProvider = typeof entry.provider === "string" ? entry.provider : modelProvider;
        modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
      } else if (entry.type === "thinking_level_change") {
        thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : thinkingLevel;
      }

      const nested = entry.message ?? entry.data?.message;
      const message: SessionScanMessage = nested ?? {
        role: entry.role,
        content: entry.content,
        provider: entry.provider,
        model: entry.model,
      };
      if (message.role) {
        messageCount += 1;
        const text = this.extractText(message.content).trim();
        if (text && preview === emptyPreview) preview = text;
        // 旧 JSONL 可能没有 model_change；从最后一条 assistant 消息回退模型。
        if (message.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
          lastAssistantModel = { provider: message.provider, modelId: message.model };
        }
      }
    }

    // 旧会话不包含 model_change / thinking_level_change 时，
    // 按 pi getSessionContextSettings 的回退规则补齐：
    //   - 模型取自最后一条 assistant 消息的 provider / model 字段
    //   - 模型从消息恢复成功时，认为 Agent 曾经运行过，未记录的思考强度视为 "off"
    if (!modelProvider || !modelId) {
      if (lastAssistantModel) {
        modelProvider = lastAssistantModel.provider;
        modelId = lastAssistantModel.modelId;
      }
    }
    if (thinkingLevel == null && (modelProvider || lastAssistantModel)) {
      thinkingLevel = "off";
    }

    // 检测子会话：任意扩展产生的内部 worker/reviewer 会话。
    // 不在顶层列表显示，而是设置 parentSessionPath 供 UI 嵌套渲染。
    //
    // 采用分层信号打分机制，兼容不同扩展的子会话存储方式：
    //   强信号（2分）：路径布局匹配、显式 customType 标记
    //   弱信号（1分）：子会话命名模式、parentSession header 引用
    //   置信度阈值：≥ 2 分判定为子会话
    const subagentScore = {
      pathInferred: 0,       // 路径布局 ← 新泛化算法
      customMarker: 0,       // customType: "*.child-session"
      namePattern: 0,        // sessionName 以 "subagent-" 开头
      parentHeader: 0,       // session header 中的 parentSession
      tintinwebMarker: 0,    // tintinweb 平铺子代理：会话名 <agent>#<8hex> + parentSession header
    };

    const pathInferredParent = isWsl
      ? await this.inferWslParentSessionFromPath(filePath, signal)
      : this.inferParentSessionFromPath(filePath);
    subagentScore.pathInferred = pathInferredParent ? 2 : 0;
    subagentScore.customMarker = hasSubagentChildMarker ? 2 : 0;
    subagentScore.namePattern = latestSessionInfoName?.startsWith("subagent-") ? 1 : 0;
    subagentScore.parentHeader = forkParentSession ? 1 : 0;
    // @tintinweb/pi-subagents 持久化的子代理会话是 pi 原生平铺文件（与父同目录，
    // 文件名 <timestamp>_<sessionId>.jsonl），路径推断与 subagent- 前缀都不命中；
    // 它 setSessionName("<agent>#<id 前 8 位>")（UUID 片段，8 位 16 进制），
    // 且 header 带 parentSession——该形态与 pi 原生 fork 同构，仅靠名字模式区分。
    subagentScore.tintinwebMarker =
      Boolean(forkParentSession) && /^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName ?? "") ? 2 : 0;

    const confidenceScore =
      subagentScore.pathInferred +
      subagentScore.customMarker +
      subagentScore.namePattern +
      subagentScore.parentHeader +
      subagentScore.tintinwebMarker;

    let parentSessionPath: string | undefined;
    if (source === "pi" && confidenceScore >= 2) {
      // 优先复用上面已完成的路径推断，避免重复遍历文件系统/WSL。
      parentSessionPath = pathInferredParent;
      // 路径推断失败时，尝试使用 forkParentSession header 引用的父路径
      if (!parentSessionPath && forkParentSession) {
        parentSessionPath = await this.resolveForkParentPath(filePath, forkParentSession, isWsl, signal);
      }
    }

    if (source === "codex" && codexSourcePath && !codexParentThreadId) {
      const fallbackInfo = this.readCodexThreadInfo(codexSourcePath);
      if (fallbackInfo) {
        codexThreadSource = fallbackInfo.threadSource;
        codexParentThreadId = fallbackInfo.parentThreadId;
        codexAgentRole = fallbackInfo.agentRole;
        codexAgentNickname = fallbackInfo.agentNickname;
      }
    }

    // 会话名优先级与 pi getSessionName 一致：最后一条 session_info 为准；
    // 旧版 PiDeck 的 sessionName 私有行及其他字段仅作降级回退。
    // pi 默认 sessionName / 未改名的 session_info 是 JSONL 文件名时间戳，不能当标题。
    // 与轻量补名共用 inferScanNameFromLines，保证两处推断结果一致。
    const inferred = inferScanNameFromLines(lines, (content) => this.extractText(content));
    const inferredName = inferred.name || this.translate("session.untitled");

    const summary: SessionSummary = {
      id: filePath,
      filePath,
      projectPath: projectPath ? this.normalize(projectPath) : this.inferProjectPathFromFile(filePath),
      name: inferredName,
      preview: preview.slice(0, 160),
      updatedAt: info.mtimeMs,
      messageCount,
      source,
      codexSessionId,
      codexThreadSource,
      codexParentThreadId,
      codexAgentRole,
      codexAgentNickname,
      parentSessionPath,
      model: modelProvider && modelId ? { provider: modelProvider, modelId } : undefined,
      thinkingLevel,
      hasImageGen: hasImageGen || undefined,
      // 标记 WSL 来源，供 rename/delete/copy/readMessages 等操作识别
      wsl: isWsl || undefined,
    };
    this.summaryCache.set(filePath, version, summary);
    return summary;
  }

  /** 应用退出前刷盘，保证本轮扫描结果可被下次启动复用。 */
  async flushSummaryCache(): Promise<void> {
    await this.summaryCache.flush();
  }

  private optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readCodexThreadInfo(sourcePath: string) {
    try {
      const root = this.normalize(this.codexRoot);
      const target = this.normalize(sourcePath);
      if (target !== root && !target.startsWith(`${root}/`)) return undefined;
      for (const line of this.readLocalFileHead(sourcePath).split(/\r?\n/).filter(Boolean).slice(0, 16)) {
        const entry = JSON.parse(line) as any;
        if (entry.type === "session_meta" && entry.payload) {
          return getCodexSessionThreadInfo(entry.payload);
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return String((item as any).text ?? (item as any).thinking ?? "");
        return "";
      }).filter(Boolean).join(" ");
    }
    return "";
  }

  /**
   * 有界读取文件头 + 文件尾，返回会话头原文、推断标题与权威性标记（不读完整正文、不写摘要缓存）。
   * pi `/name` 会在 JSONL 末尾追加 session_info，只读头部会永久看不到大会话的外部改名；
   * 因此头部负责有效性/首条消息，尾部负责最新 session_info；文件超过单窗大小才补读尾部。
   *
   * nameFromSessionInfo=false 表示标题只是首条消息回退（session_info 落在头/尾窗口盲区），
   * 弱信号不得覆盖 catalog 已有真实标题（2026-09 自动命名被第二轮消息挤掉盲区后回退覆盖的现场）。
   */
  private async readHeadAndInfer(
    filePath: string,
  ): Promise<{ raw: string; name: string | undefined; nameFromSessionInfo: boolean } | null> {
    const isWsl = this.isWslPath(filePath);
    try {
      const version = isWsl ? await this.readWslFileVersion(filePath) : await stat(filePath);
      const windowBytes = SessionScanner.SUMMARY_NAME_WINDOW_BYTES;
      const head = isWsl
        ? await this.readWslFileHead(filePath, windowBytes)
        : await this.readLocalFilePrefix(filePath, windowBytes);
      let titleText = head;
      if (version.size > windowBytes) {
        const tail = isWsl
          ? await this.readWslFileTail(filePath, windowBytes)
          : await this.readLocalFileSuffix(filePath, windowBytes, version.size);
        titleText = `${head}\n${tail}`;
      }
      // 头/尾窗口边界可能截断半行；inferScanNameFromLines 会跳过不可解析行。
      const inferred = inferScanNameFromLines(titleText.split(/\r?\n/).filter(Boolean), (content) => this.extractText(content));
      return { raw: head, name: inferred.name, nameFromSessionInfo: inferred.fromSessionInfo };
    } catch {
      // 读不到（权限/锁定/不存在）：返回 null，调用方按 best-effort 处理，不拒绝文件。
      return null;
    }
  }

  /**
   * 有界读文件头部推断会话标题（不读完整正文、不写摘要缓存）。
   * 供 SessionCatalog 对「标题仍是占位符」的会话补名——轻量扫描（listPathSummary）不带 name，
   * 未打开过的 pi 会话若只在打开/重命名时才能获得标题，侧栏会一直 Untitled。
   */
  async inferSessionNameFromFile(filePath: string): Promise<string | undefined> {
    return (await this.readHeadAndInfer(filePath))?.name;
  }

  /**
   * 从有界头部 JSONL 文本探测 pi fork/branch 会话。
   * pi 的 fork/clone（createBranchedSession / newSession({parentSession})）都会在
   * session header 写 parentSession；子代理形态（tintinweb 平铺子代理）同样带该字段，
   * 但其会话名固定 <agent>#<8hex>，据此排除——只有真正的用户 fork/分支才返回 true。
   * 该探测只产生「fork 标记」，与 parentSessionPath（子代理父关系、列表折叠）语义分离。
   */
  private detectForkedFromHead(raw: string): boolean {
    let hasParentSession = false;
    let latestSessionInfoName: string | undefined;
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isSessionScanLine(parsed)) continue;
      const entry = parsed;
      if (entry.type === "session") {
        hasParentSession = Boolean(this.optionalString(entry.parentSession ?? entry.header?.parentSession));
      } else if (entry.type === "session_info") {
        latestSessionInfoName = this.optionalString(entry.name ?? entry.data?.name);
      }
    }
    if (!hasParentSession) return false;
    // tintinweb 子代理（名字 <agent>#<8hex>）不是用户 fork；名字缺省（落在窗口盲区）时
    // 视为普通 fork——子代理形态会被 parentSessionPath/路径推断识别，不受影响。
    if (latestSessionInfoName && /^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName)) return false;
    return true;
  }

  /**
   * 读有界头部并同时校验会话头有效性：transcript 等无 type 头的产物会被标记
   * valid:false，供 catalog 在 mergeScanned 时拒绝索引（#168）。读不到文件时
   * 返回空对象（valid 缺省 = 不拒绝），兼容权限/锁定文件不被误删。
   * nameFromSessionInfo 标记标题是否来自 session_info（权威）：只有权威来源才允许
   * 覆盖 catalog 已有真实标题，首条消息回退仅用于占位标题补名（2026-09 修复）。
   * 与 inferSessionNameFromFile 共用同一次有界读头部，补名与校验不重复读盘。
   */
  async inferSessionNameAndValidity(
    filePath: string,
  ): Promise<{ name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean }> {
    const head = await this.readHeadAndInfer(filePath);
    if (!head) return {};
    const parentSessionPath = await this.detectFlatSubagentParentFromHead(filePath, head.raw);
    const forked = this.detectForkedFromHead(head.raw);
    return { name: head.name, nameFromSessionInfo: head.nameFromSessionInfo, valid: isValidPiSessionFileHead(head.raw), parentSessionPath, forked: forked || undefined };
  }

  /**
   * 由 fork/branch/tintinweb 子代理的 parentSession header 解析父会话路径。
   * 仅允许引用当前 sessions 根目录内的现有文件（防路径穿越/误挂载），
   * 本地/WSL 分别按平台语义拼接（绝对 Windows 路径用 resolve 而非 join，
   * 否则盘符路径会在 join 时被重置）。解析失败返回 undefined，不抛异常。
   */
  private async resolveForkParentPath(
    filePath: string,
    forkParentSession: string,
    isWsl: boolean,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const normalizedForkParent = forkParentSession.replace(/\\/g, "/");
    const resolved = isWsl
      ? posixJoin(posixDirname(filePath), normalizedForkParent)
      : resolve(dirname(filePath), forkParentSession);
    const normalizedResolved = this.normalize(resolved);
    const normalizedSessionsRoot = this.normalize(this.findSessionsRootForFile(filePath));
    const isInsideSessionsRoot =
      normalizedResolved !== normalizedSessionsRoot &&
      normalizedResolved.startsWith(`${normalizedSessionsRoot}/`);
    const resolvedExists = isInsideSessionsRoot && (
      isWsl ? await this.existsWslFile(resolved, signal) : existsSync(resolved)
    );
    return resolvedExists ? resolved : undefined;
  }

  /**
   * 从有界头部 JSONL 文本中探测平铺子代理（@tintinweb/pi-subagents 形态）的父会话路径。
   * 判定：session header 带 parentSession 且会话名匹配 <agent>#<8hex>。
   * 只有该形态的平铺文件会命中；用户 fork（名字是用户命名）、普通会话不被误判。
   */
  private async detectFlatSubagentParentFromHead(
    filePath: string,
    raw: string,
  ): Promise<string | undefined> {
    // 头部截断产生的半行会被 JSON.parse 跳过，不影响本次探测。
    let forkParentSession: string | undefined;
    let latestSessionInfoName: string | undefined;
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isSessionScanLine(parsed)) continue;
      const entry = parsed;
      if (entry.type === "session") {
        forkParentSession ||= this.optionalString(entry.parentSession ?? entry.header?.parentSession);
      } else if (entry.type === "session_info") {
        latestSessionInfoName = this.optionalString(entry.name ?? entry.data?.name);
      }
    }
    if (!forkParentSession || !latestSessionInfoName) return undefined;
    // tintinweb 会话名 <agent>#<8hex>：名字必须落在 #8 位十六进制后缀，
    // 否则视为用户 fork / 普通会话（fork 名由用户命名，通常不含该模式）。
    if (!/^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName)) return undefined;
    const isWsl = this.isWslPath(filePath);
    return this.resolveForkParentPath(filePath, forkParentSession, isWsl);
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
    const head = await this.readHeadAndInfer(filePath);
    if (!head) return undefined;
    return this.detectFlatSubagentParentFromHead(filePath, head.raw);
  }

  private inferProjectPathFromFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    // 默认布局：~/.pi/agent/sessions/<encoded-cwd>/...
    const marker = "/.pi/agent/sessions/";
    const index = normalized.toLowerCase().indexOf(marker);
    if (index !== -1) {
      const encoded = normalized.slice(index + marker.length).split("/")[0];
      return this.decodeSessionDir(encoded);
    }
    // 常见项目级 sessionDir：<project>/.pi/sessions/...
    const customMarker = "/.pi/sessions/";
    const customIndex = normalized.toLowerCase().lastIndexOf(customMarker);
    if (customIndex !== -1) {
      return this.normalize(normalized.slice(0, customIndex));
    }
    return undefined;
  }

  /** 找到包含 filePath 的最近（最长路径）扫描根。 */
  private findSessionsRootForFile(filePath: string): string {
    const normalizedFile = this.normalize(filePath);
    const roots = this.activeScanRoots.length > 0
      ? this.activeScanRoots
      : [this.defaultSessionsRoot];

    let bestRoot = this.defaultSessionsRoot;
    let bestLen = -1;
    for (const root of roots) {
      const normalizedRoot = this.normalize(root);
      if (
        normalizedFile === normalizedRoot ||
        normalizedFile.startsWith(`${normalizedRoot}/`)
      ) {
        if (normalizedRoot.length > bestLen) {
          bestRoot = root;
          bestLen = normalizedRoot.length;
        }
      }
    }
    return bestRoot;
  }

  private decodeSessionDir(encoded: string) {
    // pi 会把 cwd 存成 --C--Users-name-project--（Windows）或 --mnt-c-Users-name-project--（WSL）等目录名；
    // 这里只用于展示和匹配，不写回 session。
    const trimmed = encoded.replace(/^--|--$/g, "");
    // WSL /mnt/ 路径：--mnt-c-Users-...--
    if (trimmed.startsWith("mnt-")) {
      return "/" + trimmed.replace(/-/g, "/");
    }
    // Windows 路径：--C--Users-...--
    const drive = trimmed.match(/^([A-Za-z])--(.+)$/);
    if (drive) return `${drive[1]}:/${drive[2].replace(/-/g, "/")}`.replace(/\//g, "\\");
    // 其他 Linux/WSL 路径
    return trimmed.replace(/-/g, "/");
  }

  private isSameProject(summary: SessionSummary, projectPath: string) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    // 列表扫描禁止读 JSONL 正文做父目录归属。早期「在 home 启动再进子项目」的会话，
    // 若路径编码的是父目录，侧栏可能暂时不显示；已入册条目仍走 catalog 缓存。

    // 项目级自定义 sessionDir（如 <project>/.pi/sessions）下的文件默认归属该项目。
    // 该布局不再使用 encoded-cwd 子目录，safePathToken 无法从路径反推项目。
    if (this.isUnderProjectSessionDir(summary.filePath, projectPath)) return true;

    return this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
  }

  /**
   * 判断会话文件是否位于项目的自定义 sessionDir 扫描根下。
   * activeScanRoots 中除默认全局根外的目录即配置的 sessionDir。
   */
  private isUnderProjectSessionDir(filePath: string, projectPath: string): boolean {
    const normalizedFile = this.normalize(filePath);
    const defaultRoot = this.normalize(this.defaultSessionsRoot);
    const normalizedProject = this.normalize(projectPath);
    for (const root of this.activeScanRoots) {
      const normalizedRoot = this.normalize(root);
      if (normalizedRoot === defaultRoot) continue;
      if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
        // 相对 sessionDir 通常落在项目目录内；绝对共享目录仍靠 cwd 过滤。
        if (normalizedRoot === normalizedProject || normalizedRoot.startsWith(`${normalizedProject}/`)) {
          return true;
        }
      }
    }
    return false;
  }

  private async readLocalFilePrefix(filePath: string, maxBytes: number): Promise<string> {
    const handle = await openFile(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** 读取本地文件尾部窗口；起点按字节计算，避免大会话全量加载进主进程。 */
  private async readLocalFileSuffix(filePath: string, maxBytes: number, fileSize: number): Promise<string> {
    const handle = await openFile(filePath, "r");
    try {
      const bytesToRead = Math.min(maxBytes, fileSize);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, Math.max(0, fileSize - bytesToRead));
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private normalize(path: string) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  private safePathToken(path: string) {
    const normalized = path.replace(/\\/g, "/");
    const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
    if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`.toLowerCase();
    return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`.toLowerCase();
  }
}
