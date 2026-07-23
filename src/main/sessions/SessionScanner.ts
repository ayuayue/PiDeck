import { execFile } from "node:child_process";
import { app, shell } from "electron";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { basename as posixBasename, dirname as posixDirname, join as posixJoin } from "node:path/posix";
import type { ChatMessage, ChatRole, SessionSummary } from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import { extractMessageText, extractThinkingRaw } from "../pi/messageContent";
import { SessionSummaryCache, type SessionFileVersion } from "./sessionSummaryCache";

export class SessionScanner {
  private readonly root = join(app.getPath("home"), ".pi", "agent", "sessions");
  private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");
  /** WSL 配置（发行版、用户名、动态获取的 home 目录），由 configureWsl 设置；null 表示未启用 */
  private wslConfig: { distro: string; user: string; home: string } | null = null;
  /** 比 renderer watchdog 更短，确保超时前先终止实际扫描，避免后台请求堆积。 */
  private scanTimeoutMs = 18_000;
  private readonly summaryCache = new SessionSummaryCache<SessionSummary | null>();
  private summaryCacheFileSetKey = "";

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

  /**
   * 配置 WSL 会话目录。启用时动态获取 WSL 用户的 home 目录，
   * 确保 root 用户（/root）和普通用户（/home/<user>）都能正确扫描。
   */
  async configureWsl(wslDistro: string, wslUser: string): Promise<void> {
    // 动态获取 WSL 中用户的 HOME 目录，解决 root（/root）与普通用户（/home/user）路径差异
    const home = await this.fetchWslHome(wslDistro, wslUser);
    this.wslConfig = { distro: wslDistro, user: wslUser, home };
    this.clearSummaryCache();
  }

  /** 清除 WSL 配置 */
  clearWsl(): void {
    this.wslConfig = null;
    this.clearSummaryCache();
  }

  /** 通过 wsl.exe 动态获取用户 HOME 目录，失败时 fallback 到 /home/<user> */
  private fetchWslHome(distro: string, user: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(this.wslExePath, ["-d", distro, "-u", user, "sh", "-c", "echo $HOME"], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 8_000,
        windowsHide: true,
      }, (err, stdout) => {
        if (err || !stdout.trim()) {
          // fallback：标准 Linux 用户目录规则
          resolve(user === "root" ? "/root" : `/home/${user}`);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /** WSL 中 pi session 目录（基于动态获取的 home） */
  private get wslSessionsDir(): string {
    return `${this.wslConfig!.home}/.pi/agent/sessions`;
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

  /** 通过 wsl.exe 写入文件内容 */
  private writeWslFile(wslPath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 使用 tee 写入，避免 heredoc 中的特殊字符问题
      const proc = execFile(
        this.wslExePath,
        ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "tee", wslPath],
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
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "rm", wslPath], {
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

  /** 通过 wsl.exe 递归查找所有 .jsonl 文件，返回 Linux 绝对路径 */
  private async collectWslJsonl(signal?: AbortSignal): Promise<string[]> {
    const sessionsDir = this.wslSessionsDir;
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, [
        "-d", this.wslConfig!.distro, "-u", this.wslConfig!.user,
        "find", sessionsDir, "-name", "*.jsonl", "-type", "f"
      ], {
        encoding: "utf8",
        timeout: 15_000,
        signal,
        windowsHide: true,
        shell: this.wslShell,
      }, (err, stdout) => {
        if (err) { reject(err); return; }
        const files = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(files);
      });
    });
  }

  async list(projectPath?: string): Promise<SessionSummary[]> {
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
      // WSL 模式 vs Windows 模式：互斥扫描，不会同时展示两个环境的会话。
      // WSL 启用时仅扫描 WSL 会话目录，否则仅扫描 Windows 本地会话目录。
      const files = this.wslConfig
        ? await this.collectWslJsonl(signal).catch(rethrowAbort([] as string[]))
        : await this.collectJsonl(this.root).catch(() => [] as string[]);
      const fileSetKey = [...files].sort().join("\n");
      if (fileSetKey !== this.summaryCacheFileSetKey) {
        this.summaryCache.clear();
        this.summaryCacheFileSetKey = fileSetKey;
      }

      const summaries = await Promise.all(files.map(file =>
        this.readSummary(file, signal).catch(rethrowAbort(null))
      ));
      signal?.throwIfAborted();

      const validSummaries = summaries.filter((summary): summary is SessionSummary => Boolean(summary));

      if (!projectPath) {
        return validSummaries.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      // 异步 isSameProject 过滤
      const matched = await Promise.all(
        validSummaries.map(summary => this.isSameProject(summary, projectPath!, signal))
      );
      signal?.throwIfAborted();
      const filtered = validSummaries
        .filter((_, i) => matched[i])
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const childCount = filtered.filter(s => s.parentSessionPath).length;
      return filtered;
    } finally {
      if (scanTimer) clearTimeout(scanTimer);
    }
  }

  // ── 会话操作：rename / delete / copy / exportHtml / readMessages ─

  /**
   * 重命名会话：在 JSONL 文件头部插入一条 sessionName 元数据。
   * pi 读取时会取第一个遇到的 sessionName 字段，所以插在最前面即可覆盖旧名。
   * 支持 WSL 路径。
   */
  async rename(filePath: string, newName: string): Promise<void> {
    const wsl = this.isWslPath(filePath);
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const metaLine = JSON.stringify({ sessionName: newName, ts: Date.now() });

    // 查找已有的 sessionName 行并替换（首条匹配），避免每次重命名都前置插入导致文件膨胀
    let found = false;
    let sessionNameCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.sessionName === "string") {
          sessionNameCount++;
          if (!found) {
            lines[i] = metaLine;
            found = true;
          }
        }
      } catch {
        // 跳过不可解析的行
      }
    }

    let output: string;
    if (!found) {
      // 没有旧 sessionName 行，前置插入（行为与 pi 原生一致）
      output = `${metaLine}\n${raw}`;
    } else if (sessionNameCount > 5) {
      // sessionName 行数超过阈值，清理多余的旧 sessionName 行
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.sessionName === "string" && line !== metaLine) {
            return false;
          }
        } catch { /* 保留不可解析的行 */ }
        return true;
      });
      output = filtered.join("\n");
    } else {
      output = lines.join("\n");
    }

    if (wsl) {
      await this.writeWslFile(filePath, output);
    } else {
      await writeFile(filePath, output, "utf8");
    }
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
      // 先删除同级子会话目录（如果存在）
      await this.deleteWslSiblingDir(filePath);
      await this.deleteWslFile(filePath);
      return;
    }

    // 先删除同级子会话目录（如果存在），再删除文件本身
    await this.deleteSiblingDir(filePath);

    // 优先使用系统回收站（Electron shell.trashItem），避免文件永久丢失。
    // 回收站不可用时（如 Linux 部分桌面环境），fallback 到 rename 到 .trash 子目录。
    try {
      await shell.trashItem(filePath);
    } catch {
      const trashDir = join(this.root, ".trash");
      try {
        await mkdir(trashDir, { recursive: true });
        const trashName = `${basename(filePath)}.${Date.now()}.deleted`;
        await rename(filePath, join(trashDir, trashName));
      } catch {
        await unlink(filePath);
      }
    }
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
    try {
      // 优先使用回收站
      await shell.trashItem(siblingDir);
    } catch {
      // 回收站不可用时直接递归删除
      try {
        await rm(siblingDir, { recursive: true, force: true });
      } catch {
        // 目录删除失败不阻塞文件删除
      }
    }
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
   * 复制会话文件并写入新的 sessionName 元数据。
   * 这不是 CLI 的 fork：不裁剪会话树，只生成一个可独立打开/继续的新历史会话文件。
   * 支持 WSL 路径。
   */
  async copy(filePath: string): Promise<SessionSummary> {
    const wsl = this.isWslPath(filePath);
    const raw = wsl ? await this.readWslFile(filePath) : await readFile(filePath, "utf8");
    const current = await this.readSummary(filePath).catch(() => null);
    const copyName = `${current?.name || "Untitled"} copy`;
    const targetPath = this.nextCopyPath(filePath, wsl);
    const meta = JSON.stringify({ sessionName: copyName, copiedFrom: filePath, ts: Date.now() });
    const content = `${meta}\n${raw}`;

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
    const title = summary.name || "Untitled";
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
      } catch { console.warn(`[SessionScanner] 跳过无法解析的 JSONL 行: ${filePath}`); }
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
   * 从会话 JSONL 文件头部读取模型和思考级别信息。
   * 取最后一条 model_change / thinking_level_change 记录作为当前值。
   */
  async readSessionMeta(filePath: string): Promise<{
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }> {
    const raw = await this.readSessionRawText(filePath);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let provider: string | undefined;
    let modelId: string | undefined;
    let thinkingLevel: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "model_change") {
          provider = typeof entry.provider === "string" ? entry.provider : provider;
          modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
        } else if (entry.type === "thinking_level_change") {
          thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : thinkingLevel;
        }
      } catch { /* skip malformed lines */ }
    }
    return { provider, modelId, thinkingLevel };
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
          const text = extractMessageText(msg.content);
          if (!text.trim()) continue;
          const thinking = extractThinkingRaw(msg.content);
          messages.push({
            id: `sv-a-${seq++}`,
            agentId: "_viewer",
            role: "assistant",
            text,
            timestamp: ts,
            ...(thinking ? { thinking } : {}),
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

  private nextCopyPath(filePath: string, wsl: boolean): string {
    const dir = dirname(filePath);
    const ext = extname(filePath) || ".jsonl";
    const base = basename(filePath, ext);
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "copy" : `copy-${index}`;
      const candidate = join(dir, `${base}-${suffix}${ext}`);
      // WSL 路径需要通过 wsl.exe 检查文件是否存在
      if (wsl) {
        // 对于 WSL copy，我们跳过存在性检查（nextCopyPath 在 copy() 中调用，
        // copy 写入前已经通过递增确保唯一；这里仅保证路径格式正确）
        return candidate;
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
      if (entry.isDirectory()) files.push(...await this.collectJsonl(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }

    return files;
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

    const normalizedRoot = this.normalize(this.root);
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

    const normalizedRoot = this.normalize(this.wslSessionsDir);
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

  private async readSummary(filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
    // 先读取轻量文件指纹；未变化时复用摘要，避免周期扫描反复读取和解析全部 JSONL。
    const isWsl = this.isWslPath(filePath);
    const info = isWsl
      ? await this.readWslFileVersion(filePath, signal)
      : await stat(filePath);
    const version = { mtimeMs: info.mtimeMs, size: info.size };
    const cached = this.summaryCache.get(filePath, version);
    if (cached !== undefined) return cached;

    const raw = isWsl
      ? await this.readWslFile(filePath, signal)
      : await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      this.summaryCache.set(filePath, version, null);
      return null;
    }

    let name: string | undefined;
    let projectPath: string | undefined;
    let preview = "空会话";
    let firstUserText = "";
    let firstAssistantText = "";
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

    for (const line of lines) {
      const entry = JSON.parse(line) as any;
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

      name ||= entry.sessionName || entry.name || entry.data?.name || entry.header?.name || entry.session?.name;
      projectPath ||= entry.cwd || entry.projectPath || entry.header?.cwd || entry.data?.cwd || entry.session?.cwd || entry.data?.session?.cwd;

      const message = entry.message ?? entry.data?.message ?? entry;
      if (message?.role) {
        messageCount += 1;
        const text = this.extractText(message.content).trim();
        if (text && preview === "空会话") preview = text;
        if (text && message.role === "user" && !firstUserText) firstUserText = text;
        if (text && message.role === "assistant" && !firstAssistantText) firstAssistantText = text;
      }
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
    };

    const pathInferredParent = isWsl
      ? await this.inferWslParentSessionFromPath(filePath, signal)
      : this.inferParentSessionFromPath(filePath);
    subagentScore.pathInferred = pathInferredParent ? 2 : 0;
    subagentScore.customMarker = hasSubagentChildMarker ? 2 : 0;
    subagentScore.namePattern = latestSessionInfoName?.startsWith("subagent-") ? 1 : 0;
    subagentScore.parentHeader = forkParentSession ? 1 : 0;

    const confidenceScore =
      subagentScore.pathInferred +
      subagentScore.customMarker +
      subagentScore.namePattern +
      subagentScore.parentHeader;

    let parentSessionPath: string | undefined;
    if (source === "pi" && confidenceScore >= 2) {
      // 优先复用上面已完成的路径推断，避免重复遍历文件系统/WSL。
      parentSessionPath = pathInferredParent;
      // 路径推断失败时，尝试使用 forkParentSession header 引用的父路径
      if (!parentSessionPath && forkParentSession) {
        const normalizedForkParent = forkParentSession.replace(/\\/g, "/");
        const resolved = isWsl
          ? posixJoin(posixDirname(filePath), normalizedForkParent)
          // forkParentSession 可能来自 fork header 的绝对 Windows 路径；
          // path.join 在 Windows 上不会以盘符根路径重置，需用 resolve。
          : resolve(dirname(filePath), forkParentSession);
        const normalizedResolved = this.normalize(resolved);
        const normalizedSessionsRoot = this.normalize(isWsl ? this.wslSessionsDir : this.root);
        // header 来自外部 JSONL；仅允许引用当前 sessions 根目录内的现有文件，避免路径穿越或误挂载。
        const isInsideSessionsRoot =
          normalizedResolved !== normalizedSessionsRoot &&
          normalizedResolved.startsWith(`${normalizedSessionsRoot}/`);
        const resolvedExists = isInsideSessionsRoot && (
          isWsl ? await this.existsWslFile(resolved, signal) : existsSync(resolved)
        );
        if (resolvedExists) {
          parentSessionPath = resolved;
        } else {
        }
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

    const inferredName = this.cleanTitle(name) || this.cleanTitle(firstUserText) || this.cleanTitle(firstAssistantText) || "Untitled";

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
      // 标记 WSL 来源，供 rename/delete/copy/readMessages 等操作识别
      wsl: isWsl || undefined,
    };
    this.summaryCache.set(filePath, version, summary);
    return summary;
  }

  private clearSummaryCache(): void {
    this.summaryCache.clear();
    this.summaryCacheFileSetKey = "";
  }

  private optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readCodexThreadInfo(sourcePath: string) {
    try {
      const root = this.normalize(this.codexRoot);
      const target = this.normalize(sourcePath);
      if (target !== root && !target.startsWith(`${root}/`)) return undefined;
      for (const line of readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 16)) {
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

  private cleanTitle(value?: string) {
    const text = value?.replace(/\s+/g, " ").trim();
    if (!text || /^untitled$/i.test(text)) return undefined;
    return text.length > 32 ? `${text.slice(0, 32)}…` : text;
  }

  private inferProjectPathFromFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    const marker = "/.pi/agent/sessions/";
    const index = normalized.toLowerCase().indexOf(marker);
    if (index === -1) return undefined;
    const encoded = normalized.slice(index + marker.length).split("/")[0];
    return this.decodeSessionDir(encoded);
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

  private async isSameProject(summary: SessionSummary, projectPath: string, signal?: AbortSignal) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    if (await this.isParentSessionForProject(normalizedSessionProject, normalizedProject, summary.filePath, signal)) return true;
    const filePathMatch = this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
    if (!filePathMatch && summary.parentSessionPath) {
    }
    return filePathMatch;
  }

  private async isParentSessionForProject(sessionProject: string, projectPath: string, filePath: string, signal?: AbortSignal) {
    // 早期用户常在 home 目录启动 pi 再操作子项目；这类历史 session 的 cwd 是父目录，
    // 但文件内容可能明确提到当前项目。仅对父目录 session 做内容校验，避免把无关 home 会话全部展示到子项目下。
    if (!sessionProject || !projectPath.startsWith(`${sessionProject}/`)) return false;
    const text = await this.readCachedText(filePath, signal);
    return text.includes(projectPath);
  }

  private async readCachedText(filePath: string, signal?: AbortSignal) {
    try {
      const raw = this.isWslPath(filePath)
        ? await this.readWslFile(filePath, signal)
        : readFileSync(filePath, "utf8");
      return raw.replace(/\\/g, "/").toLowerCase();
    } catch {
      return "";
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
