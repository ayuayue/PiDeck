import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PiRpcClient } from "./PiRpcClient";
import { PiLocator } from "./PiLocator";
import type { AppSettings } from "../../shared/types";

type PiProcessSettings = Pick<
  AppSettings,
  "piProxyEnabled" | "piProxyUrl" | "piProxyBypass" | "customPiPath"
>;

type PiProcessLocator = Pick<
  PiLocator,
  "resolveCommand" | "createInvocation" | "createProcessEnv"
>;

type VersionCacheEntry =
  | { status: "pending"; promise: Promise<boolean> }
  | { status: "done"; ok: boolean; majorVersion: number | null };

export class PiProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private rpc?: PiRpcClient;
  /** 从 --version 解析出的主版本号，用于启动诊断信息。 */
  private piMajorVersion: number | null = null;
  /**
   * pi --version 只用于启动失败后的诊断，不应阻塞真正的 RPC 进程启动。
   * 按 command 路径缓存结果，避免连续打开多个 Agent 时重复启动 Node shim。
   */
  private static readonly versionCache = new Map<string, VersionCacheEntry>();

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
    private readonly locator: PiProcessLocator = new PiLocator(),
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

  start(sessionPath?: string, trustOverride?: "approve" | "no-approve") {
    if (this.proc) return this.rpc!;

    // 信任确认由桌面端 AgentManager.ensureProjectTrust 在启动 pi 前完成，不再静默 --approve。
    // pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，故信任弹窗由桌面端自行处理。
    const args = ["--mode", "rpc"];
    if (sessionPath) args.push("--session", sessionPath);
    // 信任覆盖：用 --approve/--no-approve 覆盖 pi 的 trustStore 决策（本次生效，不落盘）。
    // trust-session 用 --approve 让 pi 本次加载项目资源；deny 用 --no-approve 以不信任模式启动。
    if (trustOverride === "approve") args.push("--approve");
    else if (trustOverride === "no-approve") args.push("--no-approve");

    // 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题
    const command = this.locator.resolveCommand(this.settings?.customPiPath);
    const invocation = this.locator.createInvocation(command, args);

    // 初始化诊断信息。versionCheck 只作为故障诊断字段，不能阻塞 RPC 启动；
    // 若缓存里已有成功结果立即填入，否则先标记 false，后台检查完成后再更新。
    const cachedVersion = PiProcess.versionCache.get(command);
    this.piMajorVersion = cachedVersion?.status === "done" ? cachedVersion.majorVersion : this.piMajorVersion;
    this.diagnostics = {
      command: command,
      args,
      cwd: this.cwd,
      stderr: [],
      exitCode: null,
      exitSignal: null,
      customPiPath: this.settings?.customPiPath,
      versionCheck: cachedVersion?.status === "done" ? cachedVersion.ok : false,
    };
    void this.ensureVersionCheck(command);

    // 每个 agent 绑定独立 cwd，确保 pi 自己发现项目级 AGENTS.md、settings 和 session 分组。
    // 打包后的 Electron 不一定继承用户终端 PATH；这里补齐跨平台 Node 工具链常见 bin 目录，尽量让已安装 pi 的用户开箱即用。
    // Windows 下通过 PiLocator.createInvocation 显式包裹含空格的 npm shim 路径，避免 cmd 拆分路径导致 agent 启动失败。
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.locator.createProcessEnv(this.settings, invocation.pathPrefix),
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

  /** 后台执行 pi --version：更新诊断缓存，但不阻塞 start()/spawn。 */
  private ensureVersionCheck(command: string): Promise<boolean> {
    const cached = PiProcess.versionCache.get(command);
    if (cached?.status === "done") {
      this.piMajorVersion = cached.majorVersion;
      if (this.diagnostics?.command === command) this.diagnostics.versionCheck = cached.ok;
      return Promise.resolve(cached.ok);
    }
    if (cached?.status === "pending") return cached.promise;

    const promise = new Promise<boolean>((resolve) => {
      const invocation = this.locator.createInvocation(command, ["--version"]);
      execFile(invocation.command, invocation.args, {
        encoding: "utf8" as const,
        timeout: 5_000,
        shell: false,
        env: this.locator.createProcessEnv(this.settings, invocation.pathPrefix),
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }, (error, stdout) => {
        const ok = !error;
        const majorVersion = ok ? this.parseMajorVersion(stdout.trim()) : 0;
        PiProcess.versionCache.set(command, { status: "done", ok, majorVersion });
        this.piMajorVersion = majorVersion;
        if (this.diagnostics?.command === command) this.diagnostics.versionCheck = ok;
        this.emit("version-check", { ok, majorVersion });
        resolve(ok);
      });
    });
    PiProcess.versionCache.set(command, { status: "pending", promise });
    return promise;
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
