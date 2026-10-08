/**
 * cloudflared 免注册 quick tunnel 渠道：二进制定位、子进程生命周期与域名解析。
 *
 * 命令形态（quick tunnel，无需 Cloudflare 账号）：
 *   cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
 * stderr 会打印 "Your quick Tunnel has been created! Visit it at: https://xxx.trycloudflare.com"，
 * 抓到该 URL 即代表隧道建立成功。域名每次启动都会变化（quick tunnel 限制）。
 *
 * 二进制定位：PATH 逐目录扫描 + 常见安装目录兜底（winget/scoop/brew/手动安装），
 * 不 spawn shell（Windows where.exe 在精简环境可能缺席），跨平台行为一致。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebRemoteCloudflaredProtocol } from "../../../shared/types";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { AppLogger } from "../../logging/AppLogger";

/** 可注入的 spawn 实现：测试用替身驱动状态机，不拉真实子进程。 */
export type CloudflaredSpawnFn = (binary: string, args: string[]) => ChildProcessWithoutNullStreams;

/** 用户可调的隧道启动选项（来自设置项，运行中修改需重启隧道生效）。 */
export interface CloudflaredTunnelOptions {
	/** 传输协议：默认 http2（TCP 443，规避国内 UDP QoS 限速）；auto 交给 cloudflared 自行回退。 */
	protocol?: WebRemoteCloudflaredProtocol;
	/** 额外启动参数原文（空白切分，数组直传子进程）；与默认注入的同名 flag 冲突时以用户为准。 */
	extraArgs?: string;
}

/** 把用户输入的额外参数按空白切分成 argv 片段（引号无特殊语义，故不支持带空格的参数值）。 */
export function splitCloudflaredExtraArgs(text: string | undefined): string[] {
	return (text ?? "").trim().split(/\s+/).filter(Boolean);
}

/** extraArgs 中是否已包含同名 flag（--flag 或 --flag=value 形式），用于跳过默认注入避免重复。 */
function extraOverridesFlag(extra: string[], flag: string): boolean {
	return extra.some((token) => token === flag || token.startsWith(`${flag}=`));
}

/**
 * 固定 quick tunnel 启动参数。默认 --protocol http2 + --edge-ip-version 4（TCP 443 + IPv4）：
 * 国内网络对境外 UDP(QUIC 7844) 普遍 QoS 限速，且 QUIC「能连但极慢」时 cloudflared 不会自动回退；
 * 但每个人环境不同，协议/其他参数允许用户经设置项调整（同名 flag 出现在 extraArgs 时以用户为准）。
 */
export function buildCloudflaredArgs(port: number, options?: CloudflaredTunnelOptions): string[] {
	const extra = splitCloudflaredExtraArgs(options?.extraArgs);
	const args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
	const protocol = options?.protocol ?? "http2";
	if (protocol !== "auto" && !extraOverridesFlag(extra, "--protocol")) {
		args.push("--protocol", protocol);
	}
	if (!extraOverridesFlag(extra, "--edge-ip-version")) {
		args.push("--edge-ip-version", "4");
	}
	return [...args, ...extra];
}

/** 从 cloudflared 的 stderr/stdout 行里提取 quick tunnel 公网地址。 */
export function extractTryCloudflareUrl(text: string): string {
	const match = text.match(/https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.trycloudflare\.com/);
	return match ? match[0] : "";
}

/** PATH + 常见安装目录里查找 cloudflared 可执行文件；找不到返回空串。 */
export function detectCloudflaredBinary(): string {
	const exeName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
	const candidates: string[] = [];
	const pathValue = process.env.PATH || process.env.Path || "";
	for (const dir of pathValue.split(delimiter)) {
		if (dir.trim()) candidates.push(join(dir, exeName));
	}
	// 常见安装位置兜底（winget links 一般已进 PATH；以下覆盖手动安装/包管理器场景）
	if (process.platform === "win32") {
		const programDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
		for (const base of programDirs) {
			if (base) {
				candidates.push(join(base, "cloudflared", exeName));
				candidates.push(join(base, "cloudflared", exeName.replace(".exe", "") + ".exe"));
			}
		}
	} else {
		const home = homedir();
		candidates.push(join("/usr/local/bin", exeName), join("/opt/homebrew/bin", exeName), join("/usr/bin", exeName), join(home, "go", "bin", exeName), join(home, ".local", "bin", exeName));
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// 单个目录不可读（权限/不存在）不影响继续扫描
		}
	}
	return "";
}

/**
 * 单个 quick tunnel 子进程的封装：启动 → 等待域名（超时报错）→ 存活监控 → 停止。
 * 退出/错误通过 onEnded 回调上抛给 RemoteAccessManager 统一改状态。
 */
export class CloudflaredTunnelProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	/** 已停止标记：用户主动 stop 后的 exit 事件不再当作异常上报。 */
	private stopping = false;

	constructor(
		private readonly deps: {
			logger: AppLogger;
			spawnFn?: CloudflaredSpawnFn;
			/** 子进程意外退出/启动失败时回调（主动 stop 不触发）。 */
			onEnded: (error: string) => void;
		},
	) {}

	get running(): boolean {
		return this.child !== null && this.child.exitCode === null && !this.child.killed;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** 启动隧道并等待 Cloudflare 分配域名；失败抛出用户可读错误。options 来自设置项，见 buildCloudflaredArgs。 */
	async start(binary: string, port: number, options?: CloudflaredTunnelOptions): Promise<string> {
		const args = buildCloudflaredArgs(port, options);
		const spawnFn = this.deps.spawnFn ?? ((bin, argv) => spawn(bin, argv, { windowsHide: true }) as ChildProcessWithoutNullStreams);
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawnFn(binary, args);
		} catch (error) {
			throw new Error(`cloudflared 启动失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.child = child;
		this.stopping = false;
		this.deps.logger.info("web-remote", "cloudflared quick tunnel started", { binary, port, pid: child.pid });

		const publicUrl = await this.waitForUrl(child);
		if (!this.running) {
			// 等待域名期间进程已退出：waitForUrl 会抛错，此处兜底防御
			throw new Error("cloudflared 启动后立即退出，请检查网络后重试");
		}
		return publicUrl;
	}

	/** 从子进程输出里等 quick tunnel 地址；30 秒拿不到视为失败（Cloudflare 侧偶发慢）。 */
	private waitForUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let buffer = "";
			let settled = false;
			const finish = (error: Error | null, url?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(url as string);
			};
			const onChunk = (chunk: Buffer | string) => {
				if (settled) return;
				buffer += chunk.toString();
				// 输出量有界：quick tunnel 地址总在前几 KB；异常刷屏也不无限累积
				if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
				const url = extractTryCloudflareUrl(buffer);
				if (url) finish(null, url);
			};
			child.stdout.on("data", onChunk);
			child.stderr.on("data", onChunk);
			child.on("error", (error) => finish(new Error(`cloudflared 进程错误: ${error.message}`)));
			child.on("exit", (code, signal) => {
				if (settled) return;
				finish(new Error(`cloudflared 意外退出（code=${code} signal=${signal}），请检查网络或重新安装后重试`));
			});
			const timer = setTimeout(() => {
				finish(new Error("等待 Cloudflare 分配隧道地址超时（30 秒），请检查网络后重试"));
			}, 30_000);
		});
	}

	/**
	 * 停止子进程。Windows 用 taskkill /T 连带边缘连接线程一起清，避免孤儿进程占着隧道；
	 * unix 直接 SIGTERM。stop 是幂等的：进程已死/未启动都安全返回。
	 */
	stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) {
			this.child = null;
			return Promise.resolve();
		}
		this.stopping = true;
		this.deps.logger.info("web-remote", "cloudflared quick tunnel stopping", { pid: child.pid });
		return new Promise((resolve) => {
			const done = () => {
				this.child = null;
				resolve();
			};
			child.once("exit", done);
			if (process.platform === "win32" && child.pid) {
				// taskkill 树杀：cloudflared 会 spawn 辅助子进程，单 kill 会留孤儿
				const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
				killer.on("error", () => {
					child.kill();
				});
				killer.on("exit", () => {
					/* exit 事件由 child 的 exit 监听统一收口 */
				});
			} else {
				try {
					child.kill("SIGTERM");
				} catch {
					done();
				}
			}
			// 兜底：3 秒后无论杀没杀干净都释放状态（调用方继续走）
			setTimeout(done, 3_000).unref?.();
		});
	}

	/** 子进程 exit/error 事件的存活上报入口（由 RemoteAccessManager 在 start 成功后挂载）。 */
	attachLifecycleWatch(onUnexpectedEnd: (error: string) => void): void {
		const child = this.child;
		if (!child) return;
		child.on("exit", (code, signal) => {
			if (this.stopping) return;
			this.child = null;
			onUnexpectedEnd(`cloudflared 隧道已断开（code=${code} signal=${signal}）`);
		});
		child.on("error", (error) => {
			if (this.stopping) return;
			this.child = null;
			onUnexpectedEnd(`cloudflared 进程错误: ${error.message}`);
		});
	}
}
