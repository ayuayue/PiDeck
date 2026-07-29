import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "./PiRpcClient";
import { PiLocator } from "./PiLocator";
import {
  parkBlockedExtensionsInDir,
  unparkBlockedExtensions,
  type ParkedExtension,
} from "./piExtensionFilter";
import type { AppSettings } from "../../shared/types";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";

type PiProcessSettings = Pick<
  AppSettings,
  | "piProxyEnabled"
  | "piProxyUrl"
  | "piProxyBypass"
  | "customPiPath"
  | "wslEnabled"
  | "wslDistro"
  | "wslUser"
  | "piRpcOffline"
  | "piRpcNoExtensions"
  | "piRpcNoSkills"
>;

type PiProcessLocator = Pick<
  PiLocator,
  "resolveCommand" | "createInvocation" | "createProcessEnv"
>;

/** 可选：覆盖扩展扫描用的用户 home（WSL 映射 Windows home 时传入）。 */
type PiProcessOptions = {
  agentHomeDir?: string;
};

type VersionCacheEntry =
  | { status: "pending"; promise: Promise<boolean> }
  | { status: "done"; ok: boolean; minorVersion: number | null };

export class PiProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private rpc?: PiRpcClient;
  /** 从 --version 解析出的次版本号（第二段），用于启动诊断和信任标志兼容性判断。 */
  private piMinorVersion: number | null = null;
  /**
   * pi --version 只用于启动失败后的诊断，不应阻塞真正的 RPC 进程启动。
   * 按 command 路径缓存结果，避免连续打开多个 Agent 时重复启动 Node shim。
   */
  private static readonly versionCache = new Map<string, VersionCacheEntry>();

  /**
   * --approve/--no-approve 信任标志在 pi 0.79.0 引入。
   * 检查次版本号是否 >= 79（当前 pi 版本为 0.x.y，次版本号对应第二段）。
   * 未来 pi 升级到 1.x+ 后需要同步更新此检查。
   */
  private static versionSupportsTrustFlags(minorVersion: number | null): boolean {
    if (minorVersion === null) return false;
    return minorVersion >= 79;
  }

  /**
   * 应用启动时预热 pi --version 缓存，避免首次创建 Agent（尤其 trust 路径）同步等待版本检测。
   * 失败不抛错：仅影响缓存命中与诊断字段，不阻塞主流程。
   */
  static warmVersionCache(
    settings?: PiProcessSettings,
    locator: PiProcessLocator = new PiLocator(),
  ): Promise<boolean> {
    const command = locator.resolveCommand(
      settings?.customPiPath,
      settings?.wslEnabled,
      settings?.wslDistro,
      settings?.wslUser,
    );
    // 复用实例方法的缓存逻辑：构造临时实例只为调用 ensureVersionCheck。
    const probe = new PiProcess(process.cwd(), settings, locator);
    return probe.ensureVersionCheck(command);
  }

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
    /** 被桌面端 RPC 启动路径自动隔离的扩展名（如 codeisland） */
    blockedExtensions?: string[];
  } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly settings?: PiProcessSettings,
    private readonly locator: PiProcessLocator = new PiLocator(),
    private readonly options: PiProcessOptions = {},
  ) {
    super();
    // EventEmitter 在没有 listener 时 emit('error') 会变成未捕获异常并可能拖垮主进程。
    // AgentManager 在 await start() 之后才挂业务 error 监听，spawn 的 ENOENT 等错误
    // 往往在中间窗口异步到达。这里先挂一个诊断 sink，保证永远不会因 0 listener 崩进程；
    // 业务侧仍可再挂自己的 listener 做 UI 提示。
    this.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[PiProcess] child process error (pre-listener safe sink):", message);
    });
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
    blockedExtensions?: string[];
  }> | null {
    return this.diagnostics;
  }

  /** 本进程生命周期内临时停放的扩展，exit/stop 时还原。 */
  private parkedExtensions: ParkedExtension[] = [];

  /**
   * 仅停放 codeisland 等黑名单文件，不碰 npm packages / 其它本地扩展。
   * 用户已开 piRpcNoExtensions 时无需停放（扩展本就不会加载）。
   */
  private parkIncompatibleExtensions(): string[] {
    if (this.settings?.piRpcNoExtensions) return [];
    const home = this.options.agentHomeDir?.trim() || homedir();
    const dirs = [
      join(home, ".pi", "agent", "extensions"),
      join(this.cwd, ".pi", "extensions"),
    ];
    const parked: ParkedExtension[] = [];
    for (const dir of dirs) {
      parked.push(...parkBlockedExtensionsInDir(dir));
    }
    this.parkedExtensions = parked;
    // 去重 basename 供诊断展示
    return [...new Set(parked.map((p) => p.name))];
  }

  /** 还原本进程停放的扩展；幂等，可多次调用。 */
  private restoreParkedExtensions(): void {
    if (this.parkedExtensions.length === 0) return;
    unparkBlockedExtensions(this.parkedExtensions);
    this.parkedExtensions = [];
  }

  async start(sessionPath?: string, trustOverride?: "approve" | "no-approve", noSession?: boolean) {
    if (this.proc) return this.rpc!;

    // 信任确认由桌面端 AgentManager.ensureProjectTrust 在启动 pi 前完成，不再静默 --approve。
    // pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，故信任弹窗由桌面端自行处理。
    const args = ["--mode", "rpc"];
    // RPC 无 TUI，不需要主题发现/加载；跳过可少扫用户/项目/package themes，加快冷启动。
    // 内置 dark/light 仍可被扩展渲染路径按需使用，只是不扫盘加载自定义主题。
    args.push("--no-themes");
    // 桌面端模型列表来自本地 models.json；默认 --offline 跳过 pi 启动期模型目录网络刷新。
    if (this.settings?.piRpcOffline !== false) args.push("--offline");
    // 诊断开关：坏扩展/技能有时会拖垮 RPC 初始化；用户可在开发设置临时关闭后重试。
    if (this.settings?.piRpcNoExtensions) args.push("--no-extensions");
    if (this.settings?.piRpcNoSkills) args.push("--no-skills");

    // 仅临时停放 codeisland 等黑名单扩展文件；npm packages 与其它本地扩展照常加载。
    // 不用 --no-extensions 白名单，避免误伤 package 扩展。
    const blockedNames = this.parkIncompatibleExtensions();
    if (blockedNames.length > 0) {
      console.warn(
        "[PiProcess] Desktop-incompatible extensions parked for RPC:",
        blockedNames.join(", "),
      );
    }

    if (noSession) args.push("--no-session");
    if (sessionPath) args.push("--session", sessionPath);

    // 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题
    const command = this.locator.resolveCommand(this.settings?.customPiPath, this.settings?.wslEnabled, this.settings?.wslDistro, this.settings?.wslUser);

    // 信任覆盖：用 --approve/--no-approve 覆盖 pi 的 trustStore 决策（本次生效，不落盘）。
    // trust-session 用 --approve 让 pi 本次加载项目资源；deny 用 --no-approve 以不信任模式启动。
    // --approve/--no-approve 从 pi 0.79.0 开始支持。对老版本 pi 不传递这些参数，
    // 避免 "unknown option" 错误导致 RPC 进程启动失败。
    if (trustOverride) {
      await this.ensureVersionCheck(command);
      const cached = PiProcess.versionCache.get(command);
      if (cached?.status === "done" && PiProcess.versionSupportsTrustFlags(cached.minorVersion)) {
        if (trustOverride === "approve") args.push("--approve");
        else if (trustOverride === "no-approve") args.push("--no-approve");
      }
      // 版本不支持信任标志时静默跳过：老版本 pi 无 trust 系统，自动加载所有资源。
    }

    let spawnCwd = this.cwd;
    let diagnosticCwd = this.cwd;
    let finalPiArgs = args;
    let wslCwd: string | undefined;
    if (command.startsWith("wsl://")) {
      const distro = this.settings?.wslDistro;
      if (!distro) throw new Error("WSL distribution is unavailable for pi startup.");
      const environment = { distro };
      wslCwd = toWslLinuxPath(this.cwd, environment);
      spawnCwd = toWindowsHostPath(this.cwd, environment);
      diagnosticCwd = wslCwd;

      const sessionIndex = args.indexOf("--session");
      if (sessionIndex >= 0) {
        finalPiArgs = args.map((arg, index) =>
          index === sessionIndex + 1 ? toWslLinuxPath(arg, environment) : arg,
        );
      }
    }
    const invocation = this.locator.createInvocation(
      command,
      finalPiArgs,
      wslCwd ? { wslCwd } : undefined,
    );
    const finalArgs = invocation.args;

    // 初始化诊断信息。信任场景的版本检测已在上方同步完成。
    // 非信任场景仍异步触发，不阻塞 RPC 启动。
    const cachedVersion = PiProcess.versionCache.get(command);
    this.piMinorVersion = cachedVersion?.status === "done" ? cachedVersion.minorVersion : this.piMinorVersion;
    this.diagnostics = {
      command: command,
      args: finalArgs,
      cwd: diagnosticCwd,
      stderr: [],
      exitCode: null,
      exitSignal: null,
      customPiPath: this.settings?.customPiPath,
      versionCheck: cachedVersion?.status === "done" ? cachedVersion.ok : false,
      blockedExtensions: blockedNames.length > 0 ? blockedNames : undefined,
    };
    if (!trustOverride) {
      void this.ensureVersionCheck(command);
    }

    // 打印等效命令行，方便在终端重现排查
    console.log('[PiProcess] spawn等效命令:', [invocation.command, ...finalArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' '));
    console.log('[PiProcess] spawn参数:', JSON.stringify({ command: invocation.command, shell: invocation.shell, cwd: spawnCwd, wslCwd: diagnosticCwd, argsCount: finalArgs.length }));

    // 每个 agent 绑定独立 cwd，确保 pi 自己发现项目级 AGENTS.md、settings 和 session 分组。
    // 打包后的 Electron 不一定继承用户终端 PATH；这里补齐跨平台 Node 工具链常见 bin 目录，尽量让已安装 pi 的用户开箱即用。
    // Windows 下通过 PiLocator.createInvocation 显式包裹含空格的 npm shim 路径，避免 cmd 拆分路径导致 agent 启动失败。
    // spawn 本身很少同步抛错（ENOENT 等多半异步 error 事件），但 cwd 非法等仍可能同步失败，必须捕获。
    try {
      this.proc = spawn(invocation.command, finalArgs, {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
        env: this.locator.createProcessEnv(this.settings, invocation.pathPrefix, invocation.wsl),
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.diagnostics) {
        this.diagnostics.stderr.push(err.message);
        this.diagnostics.exitCode = -1;
      }
      // spawn 失败也要还原停放的扩展，避免 codeisland 永久消失。
      this.restoreParkedExtensions();
      // 同步失败也走 error 通道，让 AgentManager 能把诊断写到会话卡片而不是主进程崩掉。
      this.emit("error", err);
      throw err;
    }

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

    // 立即绑定 error/exit：不要等 AgentManager 挂业务监听。
    // macOS 上 pi 路径缺失/架构不匹配时，error 事件可能在 start() 返回后几毫秒就到。
    this.proc.on("error", (error) => {
      if (this.diagnostics) {
        this.diagnostics.stderr.push(error.message);
        // spawn 失败通常没有 exit code；用 -1 标记“未能真正拉起进程”。
        if (this.diagnostics.exitCode === null) this.diagnostics.exitCode = -1;
      }
      this.emit("error", error);
    });
    this.proc.on("exit", (code, signal) => {
      // 退出时更新诊断信息
      if (this.diagnostics) {
        this.diagnostics.exitCode = code;
        this.diagnostics.exitSignal = signal;
      }
      // pi 退出后还原临时停放的扩展，保证 CLI 仍能加载 codeisland。
      this.restoreParkedExtensions();
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
    if (!this.proc) {
      // 进程已不在仍可能残留停放态（例如 start 中途失败路径）。
      this.restoreParkedExtensions();
      return;
    }
    this.proc.kill();
    // 真正还原在 exit 回调里做；此处不提前 unpark，避免与仍在退出的 pi 竞态。
  }

  /** 后台执行 pi --version：更新诊断缓存，但不阻塞 start()/spawn。 */
  private ensureVersionCheck(command: string): Promise<boolean> {
    const cached = PiProcess.versionCache.get(command);
    if (cached?.status === "done") {
      this.piMinorVersion = cached.minorVersion;
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
        const minorVersion = ok ? this.parseMinorVersion(stdout.trim()) : 0;
        PiProcess.versionCache.set(command, { status: "done", ok, minorVersion });
        this.piMinorVersion = minorVersion;
        if (this.diagnostics?.command === command) this.diagnostics.versionCheck = ok;
        this.emit("version-check", { ok, minorVersion });
        resolve(ok);
      });
    });
    PiProcess.versionCache.set(command, { status: "pending", promise });
    return promise;
  }

  /**
   * 从 pi 的版本号字符串提取次版本号（第二段），用于信任标志兼容性判断。
   * 格式通常为 "0.79.4"，返回 79。
   */
  private parseMinorVersion(version: string): number {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) return parseInt(match[2], 10);
    // fallback：如果只有主版本号或裸数字
    const major = parseInt(version, 10);
    return Number.isFinite(major) ? major : 0;
  }
}
