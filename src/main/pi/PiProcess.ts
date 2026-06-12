import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

  constructor(
    private readonly cwd: string,
    private readonly settings?: PiProcessSettings,
  ) {
    super();
  }

  start(sessionPath?: string) {
    if (this.proc) return this.rpc!;

    const args = ["--mode", "rpc", ...(sessionPath ? ["--session", sessionPath] : [])];
    const locator = new PiLocator();
    // 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题
    const command = locator.resolveCommand(this.settings?.customPiPath);
    const invocation = locator.createInvocation(command, args);

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
      // stderr 不属于 RPC 协议，单独暴露给 UI 的日志面板，避免污染 JSONL stdout。
      this.emit("stderr", chunk.toString("utf8"));
    });

    this.proc.on("error", error => this.emit("error", error));
    this.proc.on("exit", (code, signal) => {
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

  stop() {
    if (!this.proc) return;

    // 第一版使用进程终止保证资源释放；后续可增加 RPC abort + 优雅退出策略。
    this.proc.kill();
  }
}
