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
import type { SessionProxyMode } from "../../shared/types/session";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import { appendBuiltInExtensionArgs } from "../extensions/builtInExtensions";
import { MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST } from "../extensions/extensionVersionGate";
import { getAppLogger } from "../logging/sharedLogger";
import { applyPiProxyMode } from "../sessions/sessionProxyPolicy";

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
  | "removedBuiltInExtensions"
  | "disabledExtensions"
  | "disableExtensionWhitelist"
  | "autoSessionTitle"
>;

type PiProcessLocator = Pick<
  PiLocator,
  "resolveCommand" | "createInvocation" | "createProcessEnv"
> & Partial<Pick<PiLocator, "warmWslCommand">>;


/** 可选：覆盖扩展扫描用的用户 home（WSL 映射 Windows home 时传入）。 */
type PiProcessOptions = {
  agentHomeDir?: string;
  /**
   * 解析当前应通过 -e 注入的 PiDeck 内置扩展绝对路径。
   * 未提供时 RPC 不注入内置扩展（兼容测试/探针）。
   */
  resolveBuiltInExtensionPaths?: (settings?: PiProcessSettings) => string[];
  /**
   * 白名单模式解析器：user/project packages + 本地扩展 + 内置扩展的启用路径列表。
   * 返回 null = 无禁用项，不启用白名单（pi 自动发现全部扩展）；
   * 返回数组（可能为空）= 启用白名单，start() 附加 --no-extensions 并逐条注入。
   */
  resolveEnabledExtensionPaths?: (
    settings?: PiProcessSettings,
    cwd?: string,
  ) => string[] | null;
  /**
   * 安全策略快照路径（userData/security-policy.json）。
   * 注入 PIDECK_SECURITY_CONFIG 环境变量，pi-deck-security-gate 扩展据此加载规则。
   */
  securitySnapshotPath?: string;
  /**
   * 会话身份（会话文件路径 = SessionRecord.id）。
   * 注入 PIDECK_SESSION_ID 环境变量，扩展按它解析会话级等级覆盖。
   */
  securitySessionId?: string;
  /**
   * 当前会话是否已绑定飞书（PIDECK_FEISHU_LINKED=1）。
   * pi-deck-ask-question 扩展据此把 ask_question 换成禁用提示版：
   * 飞书端交互卡片体验差（按钮截断/选项上限），agent 应把问题直接写进回复。
   * 进程级标记，绑定发生在 runtime 启动前（FeishuBridge 先建 binding 再 activateRuntime），
   * 因此 spawn 时判断可靠；绑定后已运行的会话需重启才生效（解绑后同样持续到重启）。
   */
  feishuLinked?: boolean;
  /**
   * 会话级代理覆盖（单会话开关）：on = 强制启用（复用全局 piProxyUrl），
   * off = 强制直连；缺省/follow = 跟随全局设置。仅在本进程 spawn 时生效。
   */
  proxyOverride?: SessionProxyMode;
  /**
   * spawn pi 前对会话文件的预检/修复回调（如剔除旧版 PiDeck 私有 sessionName 头行，
   * 该行会让 pi 报 "Session file is not a valid pi session" 并 exit 1）。
   * 返回是否发生修复；抛错或未注入都不阻塞启动（pi 自身的加载错误更接近事实，留日志即可）。
   */
  repairSessionFileBeforeStart?: (sessionPath: string) => Promise<boolean>;
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
  static async warmVersionCache(
    settings?: PiProcessSettings,
    locator: PiProcessLocator = new PiLocator(),
  ): Promise<boolean> {
    // WSL which 必须先异步预热，否则 resolveCommand 只能回退 Windows "pi"。
    if (settings?.wslEnabled && settings.wslDistro && settings.wslUser) {
      await locator.warmWslCommand?.(settings.wslDistro, settings.wslUser);
    }
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
      // spawn 失败（ENOENT 等）在业务 listener 挂载前到达，双写日志文件避免启动失败无痕
      void getAppLogger()?.error("pi-process", "Spawn error (pre-listener sink)", { message });
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

    // 预检会话文件：旧版 PiDeck 私有 sessionName 头行会让 pi 拒绝加载（exit 1）。
    // 修复失败不阻塞启动——pi 自身的报错会进入启动诊断，比静默吞掉更有价值。
    if (sessionPath && !noSession && this.options.repairSessionFileBeforeStart) {
      try {
        const repaired = await this.options.repairSessionFileBeforeStart(sessionPath);
        if (repaired) {
          void getAppLogger()?.warn("pi-process", "Repaired legacy sessionName header before spawn", {
            sessionPath,
          });
        }
      } catch (error) {
        void getAppLogger()?.warn("pi-process", "Session file preflight repair failed", {
          sessionPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 信任确认由桌面端 AgentManager.ensureProjectTrust 在启动 pi 前完成，不再静默 --approve。
    // pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，故信任弹窗由桌面端自行处理。
    const args = ["--mode", "rpc"];
    // RPC 无 TUI，不需要主题发现/加载；跳过可少扫用户/项目/package themes，加快冷启动。
    args.push("--no-themes");
    // 桌面端模型列表来自本地 models.json；默认 --offline 跳过 pi 启动期模型目录网络刷新。
    if (this.settings?.piRpcOffline !== false) args.push("--offline");

    // 诊断开关：坏扩展/技能有时会拖垮 RPC 初始化；用户可在开发设置临时关闭后重试。
    // piRpcNoExtensions（总开关）优先：关闭后连白名单注入也不做，保证诊断路径干净。
    if (this.settings?.piRpcNoExtensions) args.push("--no-extensions");
    if (this.settings?.piRpcNoSkills) args.push("--no-skills");

    // 仅临时停放 codeisland 等黑名单扩展文件；npm packages 与其它本地扩展照常加载。
    const blockedNames = this.parkIncompatibleExtensions();
    if (blockedNames.length > 0) {
      // 黑名单扩展被停放属于启动诊断事件，同步写入日志文件便于排查 RPC 初始化失败
      void getAppLogger()?.warn("pi-process", "Desktop-incompatible extensions parked for RPC", {
        blocked: blockedNames.join(", "),
      });
      console.warn(
        "[PiProcess] Desktop-incompatible extensions parked for RPC:",
        blockedNames.join(", "),
      );
    }

    // 白名单模式：存在禁用扩展时，--no-extensions 关自动发现 + 逐条 -e 注入未禁用的扩展。
    // 必须在 parkIncompatibleExtensions 之后调用：黑名单文件已被移走，resolver 的 existsSync
    // 会自然跳过它们，避免 -e 指向已停放路径导致 pi 报 path does not exist。
    // disableExtensionWhitelist（UI「禁用 -e 参数」总开关）为 true 时无条件关闭白名单：
    // 恢复 pi 默认发现加载全部扩展，防御个别扩展的白名单注入导致 RPC 启动失败。
    // 此处只计算列表，实际注入推迟到版本门槛检查之后（见下方 version gate），
    // 确保在拿到 command + versionCache 后统一决定。
    const whitelistPaths = this.options.resolveEnabledExtensionPaths?.(this.settings, this.cwd) ?? null;
    const useWhitelist =
      whitelistPaths !== null &&
      whitelistPaths !== undefined &&
      !this.settings?.piRpcNoExtensions &&
      !this.settings?.disableExtensionWhitelist;

    // PiDeck 内置扩展：从 app resources 以 -e 注入，不再复制到 ~/.pi/agent/extensions。
    // piRpcNoExtensions 或白名单模式时不再单独注入（白名单列表已包含内置扩展）。
    const builtInPaths = this.options.resolveBuiltInExtensionPaths?.(this.settings) ?? [];
    const argsWithBuiltIns = useWhitelist
      ? args
      : appendBuiltInExtensionArgs(args, builtInPaths, {
          noExtensions: Boolean(this.settings?.piRpcNoExtensions),
        });
    if (useWhitelist) {
      void getAppLogger()?.info("pi-process", "Extension whitelist mode enabled", {
        extensions: whitelistPaths.length,
        cwd: this.cwd,
      });
      console.log(`[PiProcess] Extension whitelist mode: ${whitelistPaths.length} extensions via -e`);
    } else if (builtInPaths.length > 0 && !this.settings?.piRpcNoExtensions) {
      void getAppLogger()?.info("pi-process", "Loading PiDeck built-in extensions via -e", {
        extensions: builtInPaths.map((path) => path.split(/[/\\]/).pop()).join(", "),
      });
      console.log(
        "[PiProcess] Loading PiDeck built-in extensions via -e:",
        builtInPaths.map((path) => path.split(/[/\\]/).pop()).join(", "),
      );
    }

    // 后续信任标志 / session / WSL 路径改写都基于已含 -e 的参数列表
    let finalPiArgs = argsWithBuiltIns;
    if (noSession) finalPiArgs.push("--no-session");
    if (sessionPath) finalPiArgs.push("--session", sessionPath);

    // 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题。
    // spawn 前再预热一次 WSL which：启动窗口已显示时异步等待可接受，不能同步 which。
    if (this.settings?.wslEnabled && this.settings.wslDistro && this.settings.wslUser) {
      await this.locator.warmWslCommand?.(this.settings.wslDistro, this.settings.wslUser);
    }
    const command = this.locator.resolveCommand(this.settings?.customPiPath, this.settings?.wslEnabled, this.settings?.wslDistro, this.settings?.wslUser);

    // 信任覆盖：用 --approve/--no-approve 覆盖 pi 的 trustStore 决策（本次生效，不落盘）。
    // trust-session 用 --approve 让 pi 本次加载项目资源；deny 用 --no-approve 以不信任模式启动。
    // --approve/--no-approve 从 pi 0.79.0 开始支持。对老版本 pi 不传递这些参数，
    // 避免 "unknown option" 错误导致 RPC 进程启动失败。
    if (trustOverride) {
      await this.ensureVersionCheck(command);
      const cached = PiProcess.versionCache.get(command);
      if (cached?.status === "done" && PiProcess.versionSupportsTrustFlags(cached.minorVersion)) {
        if (trustOverride === "approve") finalPiArgs.push("--approve");
        else if (trustOverride === "no-approve") finalPiArgs.push("--no-approve");
      }
      // 版本不支持信任标志时静默跳过：老版本 pi 无 trust 系统，自动加载所有资源。
    }

    // 扩展白名单的版本门槛：-e 的目录/包源语义从 pi 0.60 起才文档化，过低版本传目录
    // 可能 unknown option / path not found 导致 RPC 启动失败。白名单模式这里同步确认版本：
    // - 信任场景 ensureVersionCheck 已 await（versionCache 为 done），无需重复；
    // - 非信任场景强制 await 一次（--version 探测命中预热缓存，正常为 0 开销；
    //   未命中时多一次探测，仅白名单模式发生，可接受）；
    // - 版本已知且低于门槛 → 降级为默认扩展发现（禁用不生效），并补回内置扩展注入，
    //   保证启动行为与未启用白名单时一致；
    // - 版本未知（探测失败）→ 不阻塞，照常启用（warmVersionCache 已预热，未知=探测失败）。
    // 注入延迟到此处还使 --extension 路径处于 wsl 转换（下方 finalPiArgs.map）之前，
    // WSL 下同样会被正确转成 Linux 路径。
    if (useWhitelist) {
      if (!trustOverride) await this.ensureVersionCheck(command);
      const cachedVersionGate = PiProcess.versionCache.get(command);
      const minorForGate =
        cachedVersionGate?.status === "done" ? cachedVersionGate.minorVersion : this.piMinorVersion;
      if (
        minorForGate !== null &&
        minorForGate !== undefined &&
        minorForGate < MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST
      ) {
        // 版本过低：白名单不可用。不注入 --no-extensions/-e，恢复 pi 默认扩展发现，
        // 并按非白名单路径补回内置扩展，避免降级后连内置扩展都缺失。
        appendBuiltInExtensionArgs(finalPiArgs, builtInPaths, { noExtensions: false });
        void getAppLogger()?.warn("pi-process", "pi version too old for extension whitelist; falling back to default discovery", {
          minorVersion: minorForGate,
          required: MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST,
        });
        console.warn(
          `[PiProcess] pi ${minorForGate}.x too old for extension disable whitelist (need >= ${MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST}); disabled extensions will still load`,
        );
      } else {
        // 白名单模式即使列表为空也要加 --no-extensions：空列表表示「全部禁用」，不是「不启用」。
        // 路径经 spawn 参数数组传递（不经 shell），空格/中文/& 等特殊字符无需转义。
        finalPiArgs.push("--no-extensions");
        for (const extensionPath of whitelistPaths) {
          const trimmed = extensionPath.trim();
          if (!trimmed) continue;
          finalPiArgs.push("--extension", trimmed);
        }
        void getAppLogger()?.info("pi-process", "Extension whitelist mode enabled", {
          extensions: whitelistPaths.length,
          cwd: this.cwd,
        });
        console.log(`[PiProcess] Extension whitelist mode: ${whitelistPaths.length} extensions via -e`);
      }
    }

    let spawnCwd = this.cwd;
    let diagnosticCwd = this.cwd;
    let wslCwd: string | undefined;
    if (command.startsWith("wsl://")) {
      const distro = this.settings?.wslDistro;
      if (!distro) throw new Error("WSL distribution is unavailable for pi startup.");
      const environment = { distro };
      wslCwd = toWslLinuxPath(this.cwd, environment);
      spawnCwd = toWindowsHostPath(this.cwd, environment);
      diagnosticCwd = wslCwd;

      // WSL 下 session 路径与 -e 扩展路径都需转成 Linux 路径，否则 pi 在 distro 内打不开 Windows 路径。
      finalPiArgs = finalPiArgs.map((arg, index) => {
        const prev = finalPiArgs[index - 1];
        if (prev === "--session" || prev === "--extension" || prev === "-e") {
          // 仅转换看起来像 Windows 绝对路径的参数，避免误伤相对路径/选项值
          if (/^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\")) {
            return toWslLinuxPath(arg, environment);
          }
        }
        return arg;
      });
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

    // 打印等效命令行，方便在终端重现排查（同时写入日志文件供事后审计）
    console.log('[PiProcess] spawn等效命令:', [invocation.command, ...finalArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' '));
    console.log('[PiProcess] spawn参数:', JSON.stringify({ command: invocation.command, shell: invocation.shell, cwd: spawnCwd, wslCwd: diagnosticCwd, argsCount: finalArgs.length }));
    void getAppLogger()?.debug("pi-process", "Pi process spawn", {
      command: invocation.command,
      argsCount: finalArgs.length,
      cwd: spawnCwd,
      shell: invocation.shell,
    });

    // 安全管理：把策略快照路径 + 会话身份注入 pi 子进程环境。
    // - securitySnapshotPath 是真实 Windows 路径（扩展需 fs 读取），WSL 下必须转成 /mnt/c/...，
    //   否则 pi 在 distro 内打不开。
    // - securitySessionId 是不透明身份 key（SessionRecord.id：新会话为 UUID，历史会话为文件路径），
    //   扩展仅用它做 sessionLevels 字典查表，从不 fs 打开——任何模式都原样注入，绝不能做路径转换：
    //   UUID 既非 UNC/盘符/绝对 Linux 路径，喂给 toWslLinuxPath 会抛 INVALID_WSL_PATH，
    //   导致 WSL 下临时会话（deckSessionId=UUID、无 sessionPath 兜底）在 spawn 前就崩、起不来。
    // 会话级代理覆盖：先按单会话开关改写设置（on/off），再走 createProcessEnv 注入标准代理 env。
    const effectiveSettings = applyPiProxyMode(this.settings, this.options.proxyOverride);
    if (this.options.proxyOverride === "on" && this.settings && !this.settings.piProxyUrl.trim()) {
      // on 但全局 URL 为空：applyPiProxyEnv 会因空 URL 直接放行（直连），留日志便于排查。
      void getAppLogger()?.warn("pi-process", "Session proxy override 'on' but global proxy URL is empty: falling back to direct", {
        sessionKey: this.options.securitySessionId,
      });
    }
    const env = this.locator.createProcessEnv(effectiveSettings, invocation.pathPrefix, invocation.wsl);
    if (this.options.securitySnapshotPath) {
      env.PIDECK_SECURITY_CONFIG = command.startsWith("wsl://")
        ? toWslLinuxPath(this.options.securitySnapshotPath, { distro: this.settings?.wslDistro ?? "" })
        : this.options.securitySnapshotPath;
    }
    if (this.options.securitySessionId) {
      env.PIDECK_SESSION_ID = this.options.securitySessionId;
    }
    // 飞书绑定会话：ask_question 换成禁用提示版（扩展读取此标记，纯标志位无需路径转换）
    if (this.options.feishuLinked) {
      env.PIDECK_FEISHU_LINKED = "1";
    }
    // 会话自动标题由 PiDeck 内置扩展在 agent_settled 后独立调用模型；
    // 显式注入 0/1，避免继承宿主环境中的同名变量。设置变更对新建/重启 Agent 生效。
    env.PIDECK_AUTO_SESSION_TITLE = this.settings?.autoSessionTitle === false ? "0" : "1";

    // 每个 agent 绑定独立 cwd，确保 pi 自己发现项目级 AGENTS.md、settings 和 session 分组。
    // 打包后的 Electron 不一定继承用户终端 PATH；这里补齐跨平台 Node 工具链常见 bin 目录，尽量让已安装 pi 的用户开箱即用。
    // Windows 下通过 PiLocator.createInvocation 显式包裹含空格的 npm shim 路径，避免 cmd 拆分路径导致 agent 启动失败。
    // spawn 本身很少同步抛错（ENOENT 等多半异步 error 事件），但 cwd 非法等仍可能同步失败，必须捕获。
    try {
      this.proc = spawn(invocation.command, finalArgs, {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
        // env 已在上方合并安全门环境变量（PIDECK_SECURITY_CONFIG / PIDECK_SESSION_ID）
        // Windows：PiDeck 是无控制台的 GUI 进程，隐藏子进程窗口以免 cmd.exe 弹出控制台。
        env,
        windowsHide: true,
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

  /**
   * 子进程 pid；尚未 start 或已退出时为 undefined。
   * 供进程监控（内存查询/指标展示）使用，不持有引用之外的生命周期语义。
   */
  get pid(): number | undefined {
    return this.proc?.pid;
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
        // Windows：--version 检查同样经 cmd.exe 拉起，缺 windowsHide 会闪现控制台窗口。
        windowsHide: true,
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
