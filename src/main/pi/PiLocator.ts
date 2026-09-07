import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { app } from "electron";
import type { AppSettings, PiInstallStatus } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import {
  WSL_PI_NEGATIVE_CACHE_TTL_MS,
  WSL_PI_PROBE_TIMEOUT_MS,
  buildWslCommandMarker,
  buildWslPiExecArgs,
  buildWslPiProbeScript,
  isWslInteropPath,
  parseWslCommandMarker,
  parseWslPiProbeOutput,
  type WslPiProbeResult,
} from "../wsl/wslPiProbe";
import { decodeWslOutput } from "../wsl/wslExe";

/**
 * 进程级 WSL pi 探测缓存。
 * - command：`wsl://<distro>/<user>/<pi 绝对路径>` 标记；null = 已探测且未找到（负缓存）。
 * - nodeBinDir：与该 pi 配套的 node bin 目录；启动时前置注入 PATH，供 `#!/usr/bin/env node` 使用。
 * - at：写入时间。负缓存按 TTL 过期，避免「用户装完 pi 不重启应用就永远检测不到」。
 */
type WslCommandCacheEntry = {
  command: string | null;
  nodeBinDir: string;
  at: number;
};

const wslCommandCache = new Map<string, WslCommandCacheEntry>();
const wslCommandInflight = new Map<string, Promise<string | null>>();

function wslCommandCacheKey(distro: string, user: string): string {
  return `${distro}\0${user}`;
}

/** 测试用：每个 VM 用例自带一份模块，生产路径不要调用。 */
export function resetWslCommandCache(): void {
  wslCommandCache.clear();
  wslCommandInflight.clear();
}

type PiLocatorCopy = (
  key: MainProcessTranslationKey,
  params?: Record<string, string | number>,
) => string;

type PiProxySettings = Pick<
  AppSettings,
  "piProxyEnabled" | "piProxyUrl" | "piProxyBypass"
>;

export type PiCommandInvocation = {
  command: string;
  args: string[];
  shell: boolean;
  pathPrefix?: string;
  /**
   * Windows 下通过 cmd.exe /c 启动 .cmd shim 时，命令行里已经手动完成引号包装。
   * 必须禁止 Node 再次转义参数，否则路径中含空格会被 cmd 误解析为不存在的路径。
   */
  windowsVerbatimArguments?: boolean;
  /**
   * 当 pi 位于 WSL 中时，command 固定为 wsl.exe，args 会携带 distro/user/pi 参数。
   * 下游 PiProcess 需要用此标志决定是否把 Windows cwd 转为 Linux 路径。
   */
  wsl?: {
    distro: string;
    user: string;
    piCommand: string;
  };
};

/** Resolves the pi CLI across packaged Electron environments where shell PATH is often incomplete. */
export class PiLocator {
  constructor(
    private readonly translate: PiLocatorCopy = () => "Could not run pi CLI.",
  ) {}

  /**
   * Resolves the pi CLI across packaged Electron environments where shell PATH is often incomplete.
   * When `customPath` is provided, it takes priority over auto-detection —
   * this is the user's manually specified path from settings.
   */
  resolveCommand(customPath?: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string) {
    const normalizedCustomPath = this.normalizeCustomPath(customPath);
    // wsl:// 是显式运行目标，优先保留；普通本地路径则不能覆盖已启用的 WSL 模式，
    // 否则设置页残留的 Windows pi.cmd 会把 Agent 静默切回宿主机。
    if (normalizedCustomPath?.startsWith("wsl://")) return normalizedCustomPath;
    if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
      const wslCustomPath = this.toWslCustomPath(normalizedCustomPath, wslEnabled, wslDistro, wslUser);
      if (wslCustomPath) return wslCustomPath;
      // 热路径只读缓存：同步 WSL 探测会把关窗/设置点死。
      // 即使尚未预热或探测失败，也必须保留 WSL 边界；返回裸 `pi` 的 WSL 标记，
      // 不能回退为 Windows 的 `pi`，否则 WSL 配置下会静默执行宿主机 pi。
      const wslCommand = this.peekCachedWslCommand(wslDistro, wslUser);
      return wslCommand ?? buildWslCommandMarker(wslDistro, wslUser, "pi");
    }
    // 用户手动指定路径优先，适用于 npm/pnpm/yarn 全局安装、nvm/volta/asdf/mise 等极端情况。
    // 旧版本可能已保存 pi.ps1；Windows 现在不再调用 PowerShell shim，遇到时忽略并回退自动检测。
    // 路径已失效（文件被删 / 版本管理器切换后旧路径残留）时同样回退自动检测——否则 check()
    // 会拿着失效路径反复失败，永远不重扫，用户会看到「检测不到 pi」卡死。wsl:// 是标记串
    // 不是本地文件，existsSync 对它无意义，必须原样保留。
    if (
      normalizedCustomPath &&
      !this.isUnsupportedPowerShellShim(normalizedCustomPath) &&
      !normalizedCustomPath.startsWith("wsl://") &&
      existsSync(normalizedCustomPath)
    ) {
      return normalizedCustomPath;
    }

    const candidates = this.getCandidates();
    const found = candidates.find(candidate => existsSync(candidate));
    if (found) return found;
    return "pi";
  }

  /**
   * 启动/设置变更时异步探测 WSL 内的 pi，结果写入进程级缓存。
   * 热路径 `resolveCommand` 只读缓存，避免同步子进程调用卡住主进程。
   * 多次调用同一 distro/user 会合并为一次 in-flight 探测。
   *
   * `force` 给用户显式重检（设置页「检测环境」/ 保存 WSL 配置 / WSL 连接验证）：
   * 忽略正、负缓存重新探测，否则负缓存 TTL 内点按钮不会有任何变化。
   */
  async warmWslCommand(
    distro?: string,
    user?: string,
    options?: { force?: boolean },
  ): Promise<string | undefined> {
    if (process.platform !== "win32" || !distro || !user) return undefined;
    const key = wslCommandCacheKey(distro, user);
    if (options?.force) wslCommandCache.delete(key);
    else {
      const cached = this.readWslCache(key);
      // null 是负缓存（已探测且没有 pi），不能当成未命中再打一轮探测。
      if (cached) return cached.command ?? undefined;
    }
    const probed = await this.probeWslCommand(distro, user);
    return probed ?? undefined;
  }

  /**
   * 读缓存并套用负缓存 TTL。
   * undefined = 未命中或负缓存已过期（需重探）；有对象 = 命中（含「确认没装」的 null）。
   *
   * 正缓存不设 TTL：热路径上过期会回退到宿主机 pi（比多等一次探测危险得多）；
   * 版本管理器切版本/卸载等失效场景由 `force`（设置变更、显式重检）覆盖。
   */
  private readWslCache(key: string): WslCommandCacheEntry | undefined {
    const cached = wslCommandCache.get(key);
    if (!cached) return undefined;
    if (cached.command === null && Date.now() - cached.at > WSL_PI_NEGATIVE_CACHE_TTL_MS) {
      wslCommandCache.delete(key);
      return undefined;
    }
    return cached;
  }

  getSearchDirs() {
    const home = app.getPath("home");
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    // mise 数据目录可被 MISE_DATA_DIR 覆盖（安装目录可再被 MISE_INSTALL_PATH 覆盖）。
    // 只扫硬编码默认目录会漏掉自定义安装（如 D:\mise-data），且非 Windows 默认是
    // ~/.local/share/mise 而非 AppData；npm 全局 bin（pi.cmd）默认就装在
    // <mise 数据目录>/installs/node/<version>/ 下，与 node.exe 同目录。
    const miseDataDir = process.env.MISE_DATA_DIR || (
      process.platform === "win32"
        ? join(localAppData, "mise")
        : join(home, ".local", "share", "mise")
    );
    const miseInstallsDir = process.env.MISE_INSTALL_PATH || join(miseDataDir, "installs");
    const dirs = [
      ...this.pathDirs(),
      join(appData, "npm"),
      join(localAppData, "pnpm"),
      join(localAppData, "Yarn", "bin"),
      join(localAppData, "Volta", "bin"),
      join(miseDataDir, "shims"),
      ...this.listChildDirs(join(miseInstallsDir, "node")),
      // Windows fnm：node 与 npm 全局 bin（pi.cmd）同在
      // %LOCALAPPDATA%\fnm\node-versions\<ver>\installation，macOS 分支已有等价兜底。
      // Scoop：shims 目录放 scoop 装的 app shim；nodejs 的 npm prefix 默认是
      // apps\nodejs\current（全局包装在该目录，node.exe 同目录）。
      ...(process.platform === "win32"
        ? [
            ...this.listChildDirs(join(localAppData, "fnm", "node-versions")).map(dir =>
              join(dir, "installation"),
            ),
            join(home, "scoop", "shims"),
            join(home, "scoop", "apps", "nodejs", "current"),
          ]
        : []),
      join(home, ".bun", "bin"),
      join(home, ".deno", "bin"),
      join(home, ".local", "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".nvm", "current", "bin"),
      ...this.listChildDirs(join(home, ".nvm", "versions", "node")).map(dir => join(dir, "bin")),
      join(home, ".asdf", "shims"),
      join(home, ".volta", "bin"),
      // macOS GUI 启动（Dock/Finder）经常拿不到终端里的 Homebrew PATH。
      // Apple Silicon 默认 /opt/homebrew，Intel 常见 /usr/local；两者都扫一遍，
      // 避免 M4 上 pi 装在 brew 里却被桌面端判定“未安装/启动失败”。
      ...(process.platform === "darwin"
        ? [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            join(home, "Library", "pnpm"),
            join(home, ".fnm", "current", "bin"),
            ...this.listChildDirs(join(home, ".fnm", "node-versions")).map((dir) =>
              join(dir, "installation", "bin"),
            ),
          ]
        : []),
      // Linux 常见全局 bin，同样覆盖“桌面启动 PATH 不完整”的场景。
      ...(process.platform === "linux" ? ["/usr/local/bin", "/usr/bin"] : []),
    ];

    // These directories only locate an existing pi installation; pi itself is not bundled yet.
    return [...new Set(dirs.filter(Boolean))];
  }

  createProcessEnv(settings?: PiProxySettings, pathPrefix?: string, wsl?: PiCommandInvocation["wsl"]) {
    if (wsl) {
      // WSL 模式：保留原始 PATH 以便找到 wsl.exe（在 System32 中），
      // 同时注入代理环境变量（wsl.exe 子进程通过 Windows 网络栈访问外网）。
      const pathValue = pathPrefix || process.env.PATH || process.env.Path || "";
      const base = this.sanitizePiChildEnv({
        ...process.env,
        // Windows cmd 读 Path；部分宿主只改 PATH 会导致 .cmd shim 找不到 node
        PATH: pathValue,
        ...(process.platform === "win32" ? { Path: pathValue } : {}),
      });
      return this.applyPiProxyEnv(base, settings);
    }
    const searchDirs = pathPrefix
      ? [pathPrefix, ...this.getSearchDirs().filter(dir => dir !== pathPrefix)]
      : this.getSearchDirs();
    const pathValue = searchDirs.join(delimiter);
    const env = this.sanitizePiChildEnv({
      ...process.env,
      PATH: pathValue,
      // 同步 Path：Windows 下 Node 对 env 键大小写不敏感，但显式双写更稳
      ...(process.platform === "win32" ? { Path: pathValue } : {}),
    });

    return this.applyPiProxyEnv(env, settings);
  }

  /**
   * 给 pi 子进程消毒 Electron 宿主环境。
   * 桌面端主进程 env 常带 ELECTRON_* / 可能含 electron 注入的 NODE_OPTIONS；
   * 原样继承后 jiti 加载扩展或子进程行为可能与终端 CLI 不一致。
   */
  sanitizePiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next: NodeJS.ProcessEnv = { ...env };

    for (const key of Object.keys(next)) {
      if (key.startsWith("ELECTRON_") || key === "ELECTRON_RUN_AS_NODE") {
        delete next[key];
        continue;
      }
      if (key.startsWith("CHROME_") || key.startsWith("GOOGLE_API_")) {
        delete next[key];
      }
    }

    const nodeOptions = next.NODE_OPTIONS;
    if (typeof nodeOptions === "string" && nodeOptions.trim()) {
      const cleaned = nodeOptions
        .split(/\s+/)
        .filter((token) => {
          if (!token) return false;
          const lower = token.toLowerCase();
          return !(
            lower.includes("electron") ||
            lower.includes("asar") ||
            lower.includes("app.asar") ||
            lower.includes("electron-vite")
          );
        })
        .join(" ")
        .trim();
      if (cleaned) next.NODE_OPTIONS = cleaned;
      else delete next.NODE_OPTIONS;
    }

    return next;
  }

  createInvocation(command: string, args: string[], options: { wslCwd?: string } = {}): PiCommandInvocation {
    // WSL 模式：command 为 "wsl://<distro>/<user>/<pi 绝对路径>" 形式的标记
    if (command.startsWith("wsl://")) {
      const parsed = this.parseWslUrl(command);
      if (!parsed) return { command, args, shell: false };
      const { distro, user, piCommand } = parsed;
      const wslExe = this.resolveWslExe();
      // 与 checkWslCommand 共用 buildWslPiExecArgs：探测通过即意味着能启动。
      const wslArgs = buildWslPiExecArgs({
        distro,
        user,
        piCommand,
        nodeBinDir: this.peekCachedWslNodeBinDir(distro, user, piCommand),
        wslCwd: options.wslCwd,
        args,
      });
      return {
        command: wslExe.command,
        args: wslArgs,
        shell: wslExe.shell,
        wsl: { distro, user, piCommand },
      };
    }

    // JS 源文件（.js/.mjs/.cjs）通常无 shebang/可执行位，不能直接 execve 或被 cmd
    // 关联执行；统一改用 node 启动，兼容用户通过 alias "node /path/pi.js" 方式安装
    // pi 的场景（#169）。仅对实际指向 .js 文件的路径生效，不误拦裸命令名 "pi"。
    if (/\.(?:m?js|cjs)$/i.test(command) && existsSync(command)) {
      const nodeBin = process.platform === "win32" ? "node.exe" : "node";
      return {
        command: nodeBin,
        args: [command, ...args],
        shell: false,
        // JS 文件同目录一般没有 node；靠 createProcessEnv 的搜索目录解析 node。
        pathPrefix: this.getCommandBinDir(command),
      };
    }

    if (process.platform !== "win32") {
      return { command, args, shell: false, pathPrefix: this.getCommandBinDir(command) };
    }

    // Windows 仅支持 .cmd/.exe/裸命令，不再走 PowerShell .ps1。
    // npm/yarn/pnpm 生成的 pi.ps1 与 pi.cmd 指向同一个包入口，但 PowerShell 的执行策略、编码和引号规则更复杂；
    // 对桌面端来说，统一使用 cmd shim 能减少检测与 agent 启动路径差异。
    // Windows npm 全局命令通常是 .cmd shim；当命令路径本身需要引号时，cmd /s /c
    // 需要额外一层外引号才能正确解析用户名含空格的路径；不需要引号的路径不能套外层引号，
    // 否则 cmd 会把 `C:\...\pi.cmd --version` 整段当作命令名。
    const innerCommand = [command, ...args]
      .map((part) => this.quoteCmdArgument(part))
      .join(" ");
    const commandLine = this.needsCmdQuote(command) ? `"${innerCommand}"` : innerCommand;
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      shell: false,
      pathPrefix: this.getCommandBinDir(command),
      // 关键：cmd /c 的最后一个参数是完整命令行，里面的引号由 quoteCmdArgument/control 逻辑维护。
      // 若让 Node 再转义一次，`D:\\foo bar\\pi.cmd` 会变成 cmd 无法识别的路径。
      windowsVerbatimArguments: true,
    };
  }

  private applyPiProxyEnv(
    env: NodeJS.ProcessEnv,
    settings?: PiProxySettings,
  ) {
    if (!settings?.piProxyEnabled) return env;
    const proxyUrl = settings.piProxyUrl.trim();
    if (!proxyUrl) return env;
    const bypass = settings.piProxyBypass.trim();

    // 这里只给 pi agent 子进程注入标准代理环境变量，避免误影响 desktop 自身的更新、外链和配置管理请求。
    return {
      ...env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      ...(bypass ? { NO_PROXY: bypass, no_proxy: bypass } : {}),
    };
  }

  /**
   * 验证用户手动输入的 pi 路径是否可用。
   * 直接对给定路径执行 --version，绕过 getCandidates 的目录扫描，
   * 适用于用户从终端复制完整路径（如 D:\nodejs\pi.cmd）后手动粘贴的场景。
   */
  async validateCustomPath(
    customPath: string,
    wslEnabled?: boolean,
    wslDistro?: string,
    wslUser?: string,
  ): Promise<PiInstallStatus> {
    const normalized = this.normalizeCustomPath(customPath);
    const command = this.toWslCustomPath(normalized, wslEnabled, wslDistro, wslUser) ?? normalized;
    if (!command) {
      return { installed: false, searchedDirs: [], error: this.translate("mainPi.pathRequired") };
    }
    if (this.isUnsupportedPowerShellShim(command)) return this.unsupportedPowerShellStatus(command);
    if (command.startsWith("wsl://")) {
      const parsed = this.parseWslUrl(command);
      if (!parsed) return { installed: false, searchedDirs: [], error: this.translate("mainPi.invalidWslUrl") };
      const status = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
      // 设置页继续保存用户输入的 Linux 路径；下次启动由 resolveCommand 再转成 wsl:// 标记。
      return { ...status, command: normalized };
    }
    return this.runCheck(command, []);
  }

  async check(
    customPath?: string,
    wslEnabled?: boolean,
    wslDistro?: string,
    wslUser?: string,
    options?: { forceWslProbe?: boolean },
  ): Promise<PiInstallStatus> {
    const normalizedCustomPath = this.normalizeCustomPath(customPath);
    if (
      normalizedCustomPath &&
      this.isUnsupportedPowerShellShim(normalizedCustomPath) &&
      !(wslEnabled && process.platform === "win32" && wslDistro && wslUser)
    ) {
      return this.unsupportedPowerShellStatus(normalizedCustomPath, this.getSearchDirs());
    }
    // 设置页检测可以等 WSL 探测：缓存未命中时先异步探测，再 resolve，避免热路径同步子进程。
    if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
      await this.warmWslCommand(wslDistro, wslUser, { force: options?.forceWslProbe });
    }
    const command = this.resolveCommand(customPath, wslEnabled, wslDistro, wslUser);
    const searchedDirs = this.getSearchDirs();

    if (command.startsWith("wsl://")) {
      const parsed = this.parseWslUrl(command);
      if (!parsed) return { installed: false, command, searchedDirs: [], error: this.translate("mainPi.invalidWslUrl") };
      const wslStatus = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
      return {
        ...wslStatus,
        command: `wsl -d ${parsed.distro} -u ${parsed.user} ${parsed.piCommand}`,
        searchedDirs: [],
      };
    }

    return this.runCheck(command, searchedDirs);
  }

  /**
   * 专给设置页「WSL 连接验证」用的 WSL pi 检测：强制重探 + 返回解析出的 Linux 绝对路径。
   *
   * 不复用 `check()` 是因为它未命中时会回退到宿主机候选（Windows pi），
   * 验证场景要的是「这个 distro + 这个用户里到底有没有能跑的 pi」。
   */
  async checkWslInstallation(
    distro: string,
    user: string,
    options?: { force?: boolean },
  ): Promise<PiInstallStatus> {
    if (process.platform !== "win32" || !distro || !user) {
      return { installed: false, searchedDirs: [] };
    }
    const marker = await this.warmWslCommand(distro, user, options);
    if (!marker) return { installed: false, searchedDirs: [] };
    const parsed = this.parseWslUrl(marker);
    if (!parsed) return { installed: false, searchedDirs: [] };
    const status = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
    return {
      ...status,
      command: `wsl -d ${parsed.distro} -u ${parsed.user} ${parsed.piCommand}`,
      piPath: parsed.piCommand,
    };
  }

  /**
   * 归一化用户粘贴的路径：去除首尾引号，兼容 JSON 风格双反斜杠，并在 Windows 下优先补全同目录 pi.cmd。
   * 这样 UI 校验、settings 保存和 agent 启动都使用同一条路径规则，避免不同入口行为不一致。
   */
  normalizeCustomPath(rawPath?: string) {
    let value = rawPath?.trim() ?? "";
    if (!value) return "";

    const quotePairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"]];
    let stripped = true;
    while (stripped && value.length >= 2) {
      stripped = false;
      for (const [left, right] of quotePairs) {
        if (value.startsWith(left) && value.endsWith(right)) {
          value = value.slice(left.length, -right.length).trim();
          stripped = true;
        }
      }
    }

    if (process.platform === "win32") {
      // 用户从 JSON/日志里复制时可能得到 D:\\foo\\pi.cmd；只在疑似 Windows 盘符/UNC 路径时折叠双反斜杠。
      if (/^(?:[a-zA-Z]:\\\\|\\\\\\\\)/.test(value)) {
        value = value.replace(/\\\\/g, "\\");
      }

      // npm 有时同时生成无扩展名脚本和 .cmd；Windows 启动 agent 时优先使用 .cmd shim，
      // 可避免裸 `pi` 被当作 shell 内部命令或文本文件处理。
      if (!extname(value)) {
        const cmdCandidate = `${value}.cmd`;
        if (existsSync(cmdCandidate)) return cmdCandidate;
        const exeCandidate = `${value}.exe`;
        if (existsSync(exeCandidate)) return exeCandidate;
      }
    }

    return value;
  }

  private isUnsupportedPowerShellShim(command: string) {
    return process.platform === "win32" && command.trim().toLowerCase().endsWith(".ps1");
  }

  /** 用户粘贴的 Linux 绝对路径在 WSL 模式下包装成内部 wsl:// 标记。双斜杠保留命令自身的首 `/`。 */
  private toWslCustomPath(
    command: string,
    wslEnabled?: boolean,
    wslDistro?: string,
    wslUser?: string,
  ): string | null {
    if (
      !command ||
      !wslEnabled ||
      process.platform !== "win32" ||
      !wslDistro ||
      !wslUser ||
      !command.startsWith("/") ||
      isWslInteropPath(command)
    ) {
      return null;
    }
    return buildWslCommandMarker(wslDistro, wslUser, command);
  }

  private unsupportedPowerShellStatus(
    command: string,
    searchedDirs: string[] = [],
  ): PiInstallStatus {
    return {
      installed: false,
      command,
      searchedDirs,
      error: this.translate("mainPi.powershellUnsupported"),
    };
  }

  /**
   * 执行 --version 轻量健康检查：验证可执行文件发现和 Node shim 启动是否正常。
   * validateCustomPath 和 check 共用此方法，仅 searchedDirs 有差异：
   * - validateCustomPath: searchedDirs 为空（用户已手动指定路径）
   * - check: searchedDirs 为自动扫描的目录列表
   *
   * 使用 encoding: 'buffer' 避免 Windows 中文环境下 stderr 的 GBK 输出被 utf8 错误解码导致乱码。
   */
  private async runCheck(command: string, searchedDirs: string[]): Promise<PiInstallStatus> {
    return new Promise(resolve => {
      const invocation = this.createInvocation(command, ["--version"]);
      execFile(invocation.command, invocation.args, {
        env: this.createProcessEnv(undefined, invocation.pathPrefix, invocation.wsl),
        shell: invocation.shell,
        windowsHide: true,
        timeout: 8_000,
        encoding: 'buffer',
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }, (error, stdout, stderr) => {
        if (error) {
          // 优先使用 stderr 中的实际错误信息（如"系统找不到指定的文件"），
          // 并处理 Windows GBK 编码问题。兜底用 error.message 但去掉冗余的命令行前缀。
          const stderrText = this.decodeBuffer(stderr);
          const stdoutText = this.decodeBuffer(stdout);
          const raw = stderrText || this.cleanExecError(error.message);
          // 仅命令行本身没有诊断价值时，补上 exit code / timeout，方便区分 PATH 与真失败
          const errObj = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
          console.error("[PiLocator] pi CLI check failed", {
            command,
            error: raw,
            stderr: stderrText || undefined,
            stdout: stdoutText || undefined,
            exitCode: errObj.code,
            killed: errObj.killed,
            invocation: {
              command: invocation.command,
              args: invocation.args,
              pathPrefix: invocation.pathPrefix,
            },
          });
          resolve({ installed: false, command, searchedDirs, error: this.translate("mainPi.checkFailed") });
          return;
        }

        const version = this.decodeBuffer(stdout).trim();
        resolve({ installed: true, command, searchedDirs, version });
      });
    });
  }

  /**
   * wsl.exe 完整路径（优先绝对路径，fopen 失败时回退到 PATH）。
   * 32 位进程在 64 位 Windows 上访问 System32 会被文件系统重定向，
   * Sysnative 别名可绕过；若均不可用则通过 shell PATH 查找。
   */
  private resolveWslExe(): { command: string; shell: boolean } {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    // 尝试真实 System32（通过 Sysnative 处理 32-bit 重定向）
    const candidates = process.arch === "ia32"
      ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")]
      : [join(systemRoot, "System32", "wsl.exe")];
    for (const candidate of candidates) {
      const ok = existsSync(candidate);
      console.log('[PiLocator] resolveWslExe candidate:', candidate, 'exists:', ok);
      if (ok) return { command: candidate, shell: false };
    }
    // 绝对路径均不存在：让 CreateProcess/Node 直接通过 PATH 查找 wsl.exe。
    // 不能打开 shell：distro/user/cwd 都来自设置，shell fallback 会引入命令注入。
    console.log('[PiLocator] resolveWslExe fallback: PATH lookup with shell disabled');
    return { command: "wsl", shell: false };
  }
  /** @deprecated 使用 resolveWslExe() 代替，支持 PATH 回退 */
  private get wslExePath(): string {
    return this.resolveWslExe().command;
  }

  /**
   * 解析 "wsl://<distro>/<user>/<piCommand>" 格式的标记。
   * piCommand 现在是绝对 Linux 路径（带斜杠），解析规则集中在 wslPiProbe，与构造侧对称。
   */
  private parseWslUrl(url: string): { distro: string; user: string; piCommand: string } | null {
    return parseWslCommandMarker(url);
  }

  private peekCachedWslCommand(distro: string, user: string): string | undefined {
    return this.readWslCache(wslCommandCacheKey(distro, user))?.command ?? undefined;
  }

  /**
   * 取探测阶段拿到的 node bin 目录。
   * 只在标记与缓存命中的是同一个 pi 时才套用：用户手动指定的路径（如另一个 node 版本
   * 下的 pi）不得继承探测缓存，否则会把错的 node 前置到 PATH。
   * 未命中时返回 undefined，由 buildWslPiExecArgs 从 pi 绝对路径推导同目录。
   */
  private peekCachedWslNodeBinDir(
    distro: string,
    user: string,
    piCommand: string,
  ): string | undefined {
    const entry = this.readWslCache(wslCommandCacheKey(distro, user));
    if (!entry?.command) return undefined;
    if (entry.command !== buildWslCommandMarker(distro, user, piCommand)) return undefined;
    return entry.nodeBinDir || undefined;
  }

  /**
   * 异步探测 WSL 内的 pi，结果写入进程级缓存（含负缓存）。
   *
   * 不能用 `which pi`：wsl.exe 不带登录/交互标记跑命令，nvm/fnm 等写在 `~/.bashrc`
   * 交互守卫之后的 PATH 注入不会生效，必然找不到。探测改走 `wslPiProbe` 分层脚本，
   * 并缓存**绝对路径 + node bin 目录**，使「探测结果」与「启动参数」同源。
   * 禁止回到 execFileSync：超时会把 Electron 主进程事件循环堵住。
   */
  private probeWslCommand(distro: string, user: string): Promise<string | null> {
    const key = wslCommandCacheKey(distro, user);
    const cached = this.readWslCache(key);
    if (cached) return Promise.resolve(cached.command);
    const inflight = wslCommandInflight.get(key);
    if (inflight) return inflight;

    const task = this.runWslPiProbe(distro, user)
      .then((result) => {
        const command = result ? buildWslCommandMarker(distro, user, result.piPath) : null;
        wslCommandCache.set(key, {
          command,
          nodeBinDir: result?.nodeBinDir ?? "",
          at: Date.now(),
        });
        return command;
      })
      .finally(() => {
        wslCommandInflight.delete(key);
      });

    wslCommandInflight.set(key, task);
    return task;
  }

  /**
   * 跑一次探测脚本。优先 `/bin/bash -lic`（交互登录 shell，PATH 含版本管理器注入）；
   * 只有 spawn 本身失败（如 distro 里没有 bash）才降级到 `/bin/sh -c`，
   * 后者仍覆盖已知安装目录 glob 与包管理器 prefix。
   * 「脚本跑通但没找到」不重试，避免未装 pi 的用户白等一轮 WSL 往返。
   */
  private async runWslPiProbe(distro: string, user: string): Promise<WslPiProbeResult | null> {
    const script = buildWslPiProbeScript();
    const shells: Array<{ shell: string; flags: string[] }> = [
      { shell: "/bin/bash", flags: ["-lic"] },
      { shell: "/bin/sh", flags: ["-c"] },
    ];
    for (const candidate of shells) {
      const output = await this.execWslProbe(distro, user, candidate.shell, candidate.flags, script);
      if (output === null) continue;
      return parseWslPiProbeOutput(output);
    }
    return null;
  }

  /** 执行探测脚本；返回 null 表示 spawn/执行失败（区别于「跑通但没找到」的空输出）。 */
  private execWslProbe(
    distro: string,
    user: string,
    shell: string,
    flags: string[],
    script: string,
  ): Promise<string | null> {
    const wslExe = this.resolveWslExe();
    return new Promise((resolve) => {
      const child = execFile(
        wslExe.command,
        ["-d", distro, "-u", user, "-e", shell, ...flags, script],
        {
          // Keep bytes until decodeWslOutput; wsl.exe may emit UTF-16LE on
          // older Windows builds and decoding as UTF-8 first loses non-ASCII paths.
          encoding: "buffer",
          timeout: WSL_PI_PROBE_TIMEOUT_MS,
          windowsHide: true,
          shell: wslExe.shell,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            // 不区分错误类型：调用端会降级到 /bin/sh 重试，最终只是「未检测到」。
            // 但必须留痕，否则只能从 UI 的「未检测到」倒推是 WSL 探测链哪一环挂了。
            console.error("[PiLocator] WSL pi probe failed", { shell, error: error.message });
            resolve(null);
            return;
          }
          resolve(decodeWslOutput(stdout));
        },
      );
      // stdin 必须关：交互 shell 的 rc 里一句 `read` 就能把探测挂到超时。
      child.stdin?.end();
    });
  }

  /**
   * 在 WSL 里验证一个已解析的 pi 命令。
   * 参数组装必须与 createInvocation 同函数（buildWslPiExecArgs）：
   * 否则会出现「--version 能跑但启动失败」或反过来的不对称，用户看到的就是「检测不到 / 启动不了」。
   */
  private checkWslCommand(distro: string, user: string, piCommand: string): Promise<PiInstallStatus> {
    return new Promise(resolve => {
      const wslExe = this.resolveWslExe();
      const wslArgs = buildWslPiExecArgs({
        distro,
        user,
        piCommand,
        nodeBinDir: this.peekCachedWslNodeBinDir(distro, user, piCommand),
        args: ["--version"],
      });
      const child = execFile(wslExe.command, wslArgs, {
        env: this.createProcessEnv(undefined, undefined, { distro, user, piCommand }),
        shell: wslExe.shell,
        windowsHide: true,
        timeout: WSL_PI_PROBE_TIMEOUT_MS,
        // Decode the raw bytes ourselves so UTF-16LE output is not corrupted
        // before decodeWslOutput gets a chance to inspect it.
        encoding: "buffer",
      }, (error, stdout, stderr) => {
        if (error) {
          const raw = decodeWslOutput(stderr).trim() || this.cleanExecError(error.message);
          console.error("[PiLocator] WSL pi CLI check failed", { piCommand, error: raw });
          resolve({ installed: false, searchedDirs: [], error: this.translate("mainPi.checkFailed") });
          return;
        }
        resolve({ installed: true, command: `wsl -d ${distro} -u ${user} ${piCommand}`, version: decodeWslOutput(stdout).trim(), searchedDirs: [] });
      });
      // pi 的 RPC 模式靠 stdin 通信，但 --version 不需要；提前关闭避免子进程等输入。
      child.stdin?.end();
    });
  }

  private decodeBuffer(buf: Buffer | null): string {
    if (!buf || buf.length === 0) return '';
    const utf8 = buf.toString('utf8');
    // UTF-8 解码后不含 Unicode 替换字符（\ufffd），说明解码正确
    if (!utf8.includes('\ufffd')) return utf8;
    // Windows 中文环境下，cmd/powershell 的错误输出通常是 GBK (codepage 936)
    try {
      return new TextDecoder('gbk', { fatal: false }).decode(buf);
    } catch {
      // 极少数环境不支持 gbk TextDecoder（如某些精简 Node.js），保留原始字节
      return buf.toString('latin1');
    }
  }

  /**
   * 清理 execFile 默认错误消息，去掉冗余的 "Command failed: ..." 命令行前缀，
   * 只保留有意义的错误描述。
   */
  private cleanExecError(message: string): string {
    // Node.js execFile 错误格式："Command failed: powershell.exe ..."
    // 去掉前缀，只保留后半段或返回简洁提示
    const cleaned = message.replace(/^Command failed:\s*/i, '').trim();
    // 如果去掉前缀后仍是完整命令行（太长），截断为友好提示
    if (cleaned.length > 120) {
      return cleaned.slice(0, 100) + '…';
    }
    return cleaned;
  }

  private quoteCmdArgument(value: string) {
    if (!this.needsCmdQuote(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  }

  private needsCmdQuote(value: string) {
    return /[\s&()\[\]{}^=;!'+,`~|<>]/.test(value);
  }

  private getCommandBinDir(command: string) {
    if (!/[\\/]/.test(command) || !existsSync(command)) return undefined;
    const binDir = dirname(command);
    // npm/nvm/asdf/mise shims resolve Node through env/PATH. Prepending the shim's own
    // bin directory keeps that lookup on the Node version that installed pi, instead
    // of a different Node inherited from Finder/Explorer/Electron.
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    return existsSync(join(binDir, nodeName)) ? binDir : undefined;
  }

  private getCandidates() {
    // Windows 不再自动检测 pi.ps1：PowerShell shim 与 .cmd 指向同一入口，但执行策略/编码/引号规则更复杂。
    // Linux 另追加 pi.js/pi.mjs/pi.cjs：部分用户通过 alias "node /path/pi.js" 直接运行 JS 源文件而非
    // npm 装出的 shim（#169）；pi 排在前，存在标准 shim 时仍优先命中，不会被同名 JS 误拦。
    const names = process.platform === "win32"
      ? ["pi.cmd", "pi.exe", "pi"]
      : ["pi", "pi.js", "pi.mjs", "pi.cjs"];
    return this.getSearchDirs().flatMap(dir => names.map(name => join(dir, name)));
  }

  private pathDirs() {
    const fromEnv = process.env.PATH ?? process.env.Path ?? "";
    const fromShell = this.readLoginShellPath();
    return [...fromEnv.split(delimiter), ...fromShell.split(delimiter)].filter(Boolean);
  }

  private readLoginShellPath() {
    try {
      if (process.platform === "win32") {
        // Windows 检测链路不再依赖 PowerShell；Explorer 启动的 Electron 通常已经拿到系统合并 PATH，
        // 其他包管理器特殊路径由 getSearchDirs 和用户手动输入兜底。
        return "";
      }
      return execFileSync("/bin/sh", ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      return "";
    }
  }

  private listChildDirs(parent: string) {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(parent, entry.name));
    } catch {
      return [];
    }
  }
}
