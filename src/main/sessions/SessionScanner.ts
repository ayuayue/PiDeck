import { app } from "electron";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionSummary } from "../../shared/types";

export class SessionScanner {
  private readonly root = join(app.getPath("home"), ".pi", "agent", "sessions");

  async list(projectPath?: string): Promise<SessionSummary[]> {
    const files = await this.collectJsonl(this.root).catch(() => [] as string[]);
    const summaries = await Promise.all(files.map(file => this.readSummary(file).catch(() => null)));

    return summaries
      .filter((summary): summary is SessionSummary => Boolean(summary))
      .filter(summary => !projectPath || this.isSameProject(summary, projectPath))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 80);
  }

  /**
   * 重命名会话：在 JSONL 文件头部插入一条 sessionName 元数据。
   * pi 读取时会取第一个遇到的 sessionName 字段，所以插在最前面即可覆盖旧名。
   */
  async rename(filePath: string, newName: string): Promise<void> {
    const raw = await readFile(filePath, "utf8");
    const meta = JSON.stringify({ sessionName: newName, ts: Date.now() });
    await writeFile(filePath, `${meta}\n${raw}`, "utf8");
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

  private async readSummary(filePath: string): Promise<SessionSummary | null> {
    const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    let name: string | undefined;
    let projectPath: string | undefined;
    let preview = "空会话";
    let firstUserText = "";
    let firstAssistantText = "";
    let messageCount = 0;

    for (const line of lines) {
      const entry = JSON.parse(line) as any;
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

    const inferredName = this.cleanTitle(name) || this.cleanTitle(firstUserText) || this.cleanTitle(firstAssistantText) || "Untitled";

    return {
      id: filePath,
      filePath,
      projectPath: projectPath ? this.normalize(projectPath) : this.inferProjectPathFromFile(filePath),
      name: inferredName,
      preview: preview.slice(0, 160),
      updatedAt: info.mtimeMs,
      messageCount,
    };
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
    // pi 会把 cwd 存成 --C--Users-name-project-- 这种目录名；这里只用于展示和匹配，不写回 session。
    const trimmed = encoded.replace(/^--|--$/g, "");
    const drive = trimmed.match(/^([A-Za-z])--(.+)$/);
    if (drive) return `${drive[1]}:/${drive[2].replace(/-/g, "/")}`.replace(/\//g, "\\");
    return trimmed.replace(/-/g, "\\");
  }

  private isSameProject(summary: SessionSummary, projectPath: string) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    if (this.isParentSessionForProject(normalizedSessionProject, normalizedProject, summary.filePath)) return true;
    return this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
  }

  private isParentSessionForProject(sessionProject: string, projectPath: string, filePath: string) {
    // 早期用户常在 home 目录启动 pi 再操作子项目；这类历史 session 的 cwd 是父目录，
    // 但文件内容可能明确提到当前项目。仅对父目录 session 做内容校验，避免把无关 home 会话全部展示到子项目下。
    if (!sessionProject || !projectPath.startsWith(`${sessionProject}/`)) return false;
    return this.readCachedText(filePath).includes(projectPath);
  }

  private readCachedText(filePath: string) {
    try {
      return readFileSync(filePath, "utf8").replace(/\\/g, "/").toLowerCase();
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
