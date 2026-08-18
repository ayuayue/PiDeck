import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { app } from "electron";
import type { AppSettings, PiInstallStatus } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

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
    // wsl:// 是显式的运行目标，优先保留；普通本地路径则不能覆盖已启用的 WSL
    // 模式，否则设置页残留的 Windows pi.cmd 会把 Agent 静默切回宿主机。
    if (normalizedCustomPath?.startsWith("wsl://")) return normalizedCustomPath;
    if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
      const wslCustomPath = this.toWslCustomPath(normalizedCustomPath, wslEnabled, wslDistro, wslUser);
      if (wslCustomPath) return wslCustomPath;
      const wslCommand = this.resolveWslCommand(wslDistro, wslUser);
      if (wslCommand) return wslCommand;
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
    // WSL 模式：command 为 "wsl://<distro>/<user>/pi" 形式的标记
    if (command.startsWith("wsl://")) {
      const parsed = this.parseWslUrl(command);
      if (!parsed) return { command, args, shell: false };
      const { distro, user, piCommand } = parsed;
      const wslExe = this.resolveWslExe();
      const wslArgs = [
        "-d", distro,
        "-u", user,
        ...(options.wslCwd ? ["--cd", options.wslCwd] : []),
        piCommand,
        ...args,
      ];
      console.log('[PiLocator] WSL invocation:', wslExe.command, wslArgs.join(' '), 'shell:', wslExe.shell);
      return {
        command: wslExe.command,
        args: wslArgs,
        shell: wslExe.shell,
        wsl: { distro, user, piCommand },
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
      // Keep the user's Linux path as the persisted custom setting. `resolveCommand()`
      // converts it to the internal wsl:// marker on the next launch, while the settings
      // UI continues to show the path the user entered instead of an internal URL.
      return { ...status, command: normalized };
    }
    return this.runCheck(command, []);
  }

  async check(customPath?: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string): Promise<PiInstallStatus> {
    const normalizedCustomPath = this.normalizeCustomPath(customPath);
    if (
      normalizedCustomPath &&
      this.isUnsupportedPowerShellShim(normalizedCustomPath) &&
      !(wslEnabled && process.platform === "win32" && wslDistro && wslUser)
    ) {
      return this.unsupportedPowerShellStatus(normalizedCustomPath, this.getSearchDirs());
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
      !command.startsWith("/")
    ) {
      return null;
    }
    // 双斜杠是有意保留的：URL 的分隔符之后还要保留 Linux 命令的首个 `/`。
    return `wsl://${wslDistro}/${wslUser}/${command}`;
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
   * 尝试在 WSL 中检测 pi 是否可用。
   * 返回 "wsl://<distro>/<user>/pi" 标记字符串，供 resolveCommand/createInvocation 识别。
   */
  /**
   * wsl.exe 完整路径。32 位进程在 64 位 Windows 上访问 System32 会被文件系统重定向到
   * SysWOW64，而 wsl.exe 仅存在于真实 System32 中。使用 Sysnative 别名绕过重定向。
   */
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
    // 绝对路径均不存在：通过 cmd.exe PATH 查找 wsl.exe
    console.log('[PiLocator] resolveWslExe fallback: shell mode with "wsl"');
    return { command: "wsl", shell: true };
  }
  /** @deprecated 使用 resolveWslExe() 代替，支持 PATH 回退 */
  private get wslExePath(): string {
    return this.resolveWslExe().command;
  }

  /**
   * 解析 "wsl://<distro>/<user>/<piCommand>" 格式的 URL。
   * 使用正则代替 .split("/") 避免 wsl:// 的双斜杠产生空字符串元素导致解析错位。
   */
  private parseWslUrl(url: string): { distro: string; user: string; piCommand: string } | null {
    const match = url.match(/^wsl:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return { distro: match[1], user: match[2], piCommand: match[3] };
  }

  private resolveWslCommand(distro: string, user: string): string | undefined {
    try {
      const wslExe = this.resolveWslExe();
      const wslArgs = ["-d", distro, "-u", user, "which", "pi"];
      const result = execFileSync(wslExe.command, wslArgs, {
        encoding: "utf8",
        timeout: 8_000,
        windowsHide: true,
        shell: wslExe.shell,
      }).trim();
      if (result && result.length > 0 && !result.includes("not found")) {
        return `wsl://${distro}/${user}/pi`;
      }
    } catch {
      // WSL 不可用或未安装 pi，静默忽略，回退到普通 "pi"
    }
    return undefined;
  }

  private checkWslCommand(distro: string, user: string, piCommand: string): Promise<PiInstallStatus> {
    return new Promise(resolve => {
      const wslExe = this.resolveWslExe();
      const wslArgs = ["-d", distro, "-u", user, piCommand, "--version"];
      execFile(wslExe.command, wslArgs, {
        env: this.createProcessEnv(undefined, undefined, { distro, user, piCommand }),
        shell: wslExe.shell,
        windowsHide: true,
        timeout: 8_000,
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        if (error) {
          const raw = stderr?.trim() || this.cleanExecError(error.message);
          console.error("[PiLocator] WSL pi CLI check failed", { error: raw });
          resolve({ installed: false, searchedDirs: [], error: this.translate("mainPi.checkFailed") });
          return;
        }
        resolve({ installed: true, command: `wsl -d ${distro} -u ${user} ${piCommand}`, version: stdout.trim(), searchedDirs: [] });
      });
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
    const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
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
