import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PiRpcClient } from "./PiRpcClient";
import { PiLocator } from "./PiLocator";
import type { AppSettings } from "../../shared/types";

type PiProcessSettings = Pick<
  AppSettings,
  "piProxyEnabled" | "piProxyUrl" | "piProxyBypass" | "customPiPath"
>;

export class PiProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private rpc?: PiRpcClient;
  /** 从 --version 解析出的主版本号，用于启动诊断信息。 */
  private piMajorVersion: number | null = null;

  /** 启动失败 / 异常退出时的诊断信息 */
  private diagnostics: {
    command: string;
    args: string[];
    cwd: string;
    stderr: string[];
    exitCode: number | null;
    exitSignal: string | null;
    customPiPath: string | undefined;
    versionCheck: boolean;
  } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly settings?: PiProcessSettings,
  ) {
    super();
  }

  /** 返回诊断信息（进程启动失败或异常退出后调用） */
  getDiagnostics(): Readonly<{
    command: string;
    args: string[];
    cwd: string;
    stderr: string[];
    exitCode: number | null;
    exitSignal: string | null;
    customPiPath: string | undefined;
    versionCheck: boolean;
  }> | null {
    return this.diagnostics;
  }

  start(sessionPath?: string) {
    if (this.proc) return this.rpc!;

    // 信任确认由内置 pi-deck-project-trust 扩展处理，不再静默 --approve。
    // PiDeck 桌面端通过 ctx.ui.select 弹窗让用户选择信任策略。
    const args = ["--mode", "rpc"];
    if (sessionPath) args.push("--session", sessionPath);

    const locator = new PiLocator();
    // 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题
    const command = locator.resolveCommand(this.settings?.customPiPath);
    const invocation = locator.createInvocation(command, args);

    // 初始化诊断信息
    const versionOk = this.piMajorVersion !== null && this.piMajorVersion > 0;
    this.diagnostics = {
      command: command,
      args,
      cwd: this.cwd,
      stderr: [],
      exitCode: null,
      exitSignal: null,
      customPiPath: this.settings?.customPiPath,
      versionCheck: versionOk || this.tryVersionCheck(locator),
    };

    // 每个 agent 绑定独立 cwd，确保 pi 自己发现项目级 AGENTS.md、settings 和 session 分组。
    // 打包后的 Electron 不一定继承用户终端 PATH；这里补齐跨平台 Node 工具链常见 bin 目录，尽量让已安装 pi 的用户开箱即用。
    // Windows 下通过 PiLocator.createInvocation 显式包裹含空格的 npm shim 路径，避免 cmd 拆分路径导致 agent 启动失败。
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: locator.createProcessEnv(this.settings, invocation.pathPrefix),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this.rpc = new PiRpcClient(this.proc.stdin, this.proc.stdout);

    this.rpc.on("event", event => this.emit("event", event));
    this.rpc.on("protocol-error", line => this.emit("protocol-error", line));
    // 转发 RPC 日志到 AgentManager，用于前端调试面板展示
    this.rpc.on("log", entry => this.emit("rpc-log", entry));

    this.proc.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      // 缓冲启动期 stderr（上限 8KB），供启动失败后诊断展示
      if (this.diagnostics) {
        this.diagnostics.stderr.push(text);
        const total = this.diagnostics.stderr.reduce((s, l) => s + l.length, 0);
        if (total > 8192) this.diagnostics.stderr = [this.diagnostics.stderr.join("").slice(-4096)];
      }
      // stderr 不属于 RPC 协议，单独暴露给 UI 的日志面板，避免污染 JSONL stdout。
      this.emit("stderr", text);
    });

    this.proc.on("error", error => this.emit("error", error));
    this.proc.on("exit", (code, signal) => {
      // 退出时更新诊断信息
      if (this.diagnostics) {
        this.diagnostics.exitCode = code;
        this.diagnostics.exitSignal = signal;
      }
      this.rpc?.close(new Error(`pi exited: code=${code ?? "null"}, signal=${signal ?? "null"}`));
      this.emit("exit", { code, signal });
      this.proc = undefined;
      this.rpc = undefined;
    });

    return this.rpc;
  }

  get client() {
    if (!this.rpc) throw new Error("pi process is not running");
    return this.rpc;
  }

  isRunning(): boolean {
    return this.proc !== undefined && this.rpc !== undefined;
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill();
  }

  /** @returns versionCheck 是否通过 */
  private tryVersionCheck(locator: PiLocator): boolean {
    try {
      const command = locator.resolveCommand(this.settings?.customPiPath);
      const invocation = locator.createInvocation(command, ["--version"]);
      const result = execFileSync(invocation.command, invocation.args, {
        encoding: "utf8" as const,
        timeout: 5_000,
        shell: false,
        env: locator.createProcessEnv(this.settings, invocation.pathPrefix),
      });
      const version = result.trim();
      this.piMajorVersion = this.parseMajorVersion(version);
      return true;
    } catch {
      this.piMajorVersion = 0;
      return false;
    }
  }

  /**
   * 从 pi 的版本号字符串提取主版本号。
   * 格式通常为 "0.79.4"，支持语义化版本或裸数字。
   */
  private parseMajorVersion(version: string): number {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) return parseInt(match[2], 10);
    // fallback：如果只有主版本号
    const major = parseInt(version, 10);
    return Number.isFinite(major) ? major : 0;
  }
}
