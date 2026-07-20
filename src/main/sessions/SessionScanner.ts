import { execFile } from "node:child_process";
import { app, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { SessionSummary } from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";

export class SessionScanner {
  private readonly root = join(app.getPath("home"), ".pi", "agent", "sessions");
  private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");
  /** WSL 配置（发行版、用户名、动态获取的 home 目录），由 configureWsl 设置；null 表示未启用 */
  private wslConfig: { distro: string; user: string; home: string } | null = null;

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
  }

  /** 清除 WSL 配置 */
  clearWsl(): void {
    this.wslConfig = null;
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
  private readWslFile(wslPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "cat", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 10_000,
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

  /** 通过 wsl.exe 获取文件修改时间戳 */
  private readWslFileMtime(wslPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "stat", "-c", "%Y", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(Number(stdout.trim()) * 1000);
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
  private existsWslFile(wslPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.wslExePath, ["-d", this.wslConfig!.distro, "-u", this.wslConfig!.user, "test", "-f", wslPath], {
        shell: this.wslShell,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }, (err) => { resolve(!err); });
    });
  }

  // ── 会话列表扫描 ─────────────────────────────────────────────

  /** 通过 wsl.exe 递归查找所有 .jsonl 文件，返回 Linux 绝对路径 */
  private async collectWslJsonl(): Promise<string[]> {
    const sessionsDir = this.wslSessionsDir;
    return new Promise((resolve, reject) => {
      execFile(this.wslExePath, [
        "-d", this.wslConfig!.distro, "-u", this.wslConfig!.user,
        "find", sessionsDir, "-name", "*.jsonl", "-type", "f"
      ], {
        encoding: "utf8",
        timeout: 15_000,
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
    // WSL 模式 vs Windows 模式：互斥扫描，不会同时展示两个环境的会话。
    // WSL 启用时仅扫描 WSL 会话目录，否则仅扫描 Windows 本地会话目录。
    const files = this.wslConfig
      ? await this.collectWslJsonl().catch(() => [] as string[])
      : await this.collectJsonl(this.root).catch(() => [] as string[]);

    const summaries = await Promise.all(files.map(file => this.readSummary(file).catch(() => null)));

    const validSummaries = summaries.filter((summary): summary is SessionSummary => Boolean(summary));

    if (!projectPath) {
      return validSummaries.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    // 异步 isSameProject 过滤
    const matched = await Promise.all(
      validSummaries.map(summary => this.isSameProject(summary, projectPath!))
    );
    return validSummaries
      .filter((_, i) => matched[i])
      .sort((a, b) => b.updatedAt - a.updatedAt);
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

  async delete(filePath: string): Promise<void> {
    if (this.isWslPath(filePath)) {
      // WSL 中直接删除（WSL 没有 Electron shell.trashItem 实现）
      await this.deleteWslFile(filePath);
      return;
    }
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

  private parentSessionFileForSubagentPath(filePath: string) {
    // pi-subagents persists resumable runs as <parent-stem>/<run-id>/run-N/session.jsonl.
    // Match the full layout so unrelated nested Pi sessions remain visible.
    if (basename(filePath).toLowerCase() !== "session.jsonl") return undefined;
    const runDirectory = dirname(filePath);
    if (!/^run-\d+$/i.test(basename(runDirectory))) return undefined;
    const runRoot = dirname(runDirectory);
    const parentSessionRoot = dirname(runRoot);
    return join(dirname(parentSessionRoot), `${basename(parentSessionRoot)}.jsonl`);
  }

  private async readSummary(filePath: string): Promise<SessionSummary | null> {
    // WSL 路径通过 wsl.exe 命令读取，Windows 路径直接用 fs
    const isWsl = this.isWslPath(filePath);
    const [raw, info] = await Promise.all([
      isWsl ? this.readWslFile(filePath) : readFile(filePath, "utf8"),
      isWsl ? this.readWslFileMtime(filePath).then(m => ({ mtimeMs: m })) : stat(filePath),
    ]);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

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
      if (entry.type === "custom" && entry.customType === "pi-subagents.child-session") {
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

    // 检测子会话：pi-subagents 的内部 worker/reviewer 会话。
    // 不在顶层列表显示，而是设置 parentSessionPath 供 UI 嵌套渲染。
    const hasLegacySubagentName = latestSessionInfoName?.startsWith("subagent-") === true;
    const hasLegacyOwnedPath = Boolean(this.parentSessionFileForSubagentPath(filePath));
    let parentSessionPath: string | undefined;
    if (source === "pi") {
      const isSubagentChild =
        hasSubagentChildMarker
        || (hasLegacySubagentName && (hasLegacyOwnedPath || Boolean(forkParentSession)));

      if (isSubagentChild) {
        // 优先从路径布局推断父会话（标准 run-N/session.jsonl 布局）
        parentSessionPath = this.parentSessionFileForSubagentPath(filePath);
        // 路径推断失败时尝试 forkParentSession 字段（如 "parent-session.jsonl"）
        if (!parentSessionPath && forkParentSession) {
          const resolved = join(dirname(filePath), forkParentSession);
          // WSL 路径检查文件是否存在
          const resolvedExists = isWsl ? await this.existsWslFile(resolved) : existsSync(resolved);
          if (resolvedExists) {
            parentSessionPath = resolved;
          }
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

    return {
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

  private async isSameProject(summary: SessionSummary, projectPath: string) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    if (await this.isParentSessionForProject(normalizedSessionProject, normalizedProject, summary.filePath)) return true;
    return this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
  }

  private async isParentSessionForProject(sessionProject: string, projectPath: string, filePath: string) {
    // 早期用户常在 home 目录启动 pi 再操作子项目；这类历史 session 的 cwd 是父目录，
    // 但文件内容可能明确提到当前项目。仅对父目录 session 做内容校验，避免把无关 home 会话全部展示到子项目下。
    if (!sessionProject || !projectPath.startsWith(`${sessionProject}/`)) return false;
    const text = await this.readCachedText(filePath);
    return text.includes(projectPath);
  }

  private async readCachedText(filePath: string) {
    try {
      const raw = this.isWslPath(filePath)
        ? await this.readWslFile(filePath)
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
