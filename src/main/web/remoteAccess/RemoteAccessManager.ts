/**
 * 外网访问编排器：聚合 cloudflare quick tunnel 与 tailscale serve 两个渠道的生命周期，
 * 输出单一 RemoteAccessState 快照（渲染层只认这个形状）。
 *
 * 设计要点：
 * - 状态不持久化：cloudflare 域名每次都变、serve 配置由 tailscaled 自己持久化，
 *   本类只维护「本次会话内用户想要什么」（desired 标记），Web 服务启停/换端口时据此收敛。
 * - 所有方法不向 IPC 抛裸异常：可预期失败以返回值/状态里的 error 字段表达。
 * - 渠道是 Web 服务的附属：Web 服务停止时两个渠道一并收口（隧道杀进程、serve 摘除）。
 */
import type { AppLogger } from "../../logging/AppLogger";
import type { RemoteAccessState, RemoteAccessChannelId, CloudflareTunnelState, TailscaleAccessState } from "../../../shared/types/remoteAccess";
import type { WebServiceStatusInfo } from "../../../shared/types/settings";
import { CloudflaredTunnelProcess, detectCloudflaredBinary } from "./cloudflaredTunnel";
import { TailscaleAccessReader, buildTailscaleServeUrl, detectTailscaleBinary } from "./tailscaleAccess";

export type RemoteAccessManagerDeps = {
	logger: AppLogger;
	/** Web 服务当前状态（隧道转发目标；stop/start 后由装配层调 syncWebService 收敛渠道）。 */
	getWebServiceStatus: () => WebServiceStatusInfo;
	/** 状态变化时推给渲染层（装配层接主窗口 webContents.send）。 */
	pushState: (state: RemoteAccessState) => void;
	/** 测试注入点：替换真实子进程/命令执行。 */
	tunnelFactory?: (deps: { logger: AppLogger; onEnded: (error: string) => void }) => CloudflaredTunnelProcess;
	readerFactory?: (deps: { logger: AppLogger; binary?: string }) => TailscaleAccessReader;
	/** 测试注入点：替换 PATH 探测，避免单测依赖本机安装。 */
	detectCloudflared?: () => string;
	detectTailscale?: () => string;
};

export class RemoteAccessManager {
	private readonly logger: AppLogger;
	private readonly getWebServiceStatus: () => WebServiceStatusInfo;
	private readonly push: (state: RemoteAccessState) => void;

	// ── cloudflare 渠道 ──
	private cloudflare: CloudflareTunnelState = { binaryAvailable: false, binaryPath: "", running: false, starting: false, publicUrl: "", error: "" };
	private tunnel: CloudflaredTunnelProcess | null = null;
	/** 本次会话内用户是否想要隧道开着（Web 服务重启/换端口后据此自动重建）。 */
	private cloudflareDesired = false;
	/** 用户已请求停止：吞掉 in-flight start 的「意外退出」错误。 */
	private cloudflareStopRequested = false;

	// ── tailscale 渠道 ──
	private tailscale: TailscaleAccessState = { installed: false, binaryPath: "", loggedIn: false, backendState: "", ip: "", dnsName: "", serveActive: false, serveUrl: "", error: "" };
	private reader: TailscaleAccessReader | null = null;
	/** 用户/启动探测认定的 serve 意图（Web 服务换端口后据此重指）。 */
	private serveDesired = false;

	private disposed = false;

	constructor(deps: RemoteAccessManagerDeps) {
		this.logger = deps.logger;
		this.getWebServiceStatus = deps.getWebServiceStatus;
		this.push = deps.pushState;
		// 生产用真实实现；测试可注入 stub。可选参数必须在此处兑付，避免每个调用点判空。
		this.tunnelFactory = deps.tunnelFactory ?? ((d) => new CloudflaredTunnelProcess(d));
		this.readerFactory = deps.readerFactory ?? ((d) => new TailscaleAccessReader(d));
		this.detectCloudflared = deps.detectCloudflared ?? detectCloudflaredBinary;
		this.detectTailscale = deps.detectTailscale ?? detectTailscaleBinary;
	}

	private readonly tunnelFactory: (deps: { logger: AppLogger; onEnded: (error: string) => void }) => CloudflaredTunnelProcess;
	private readonly readerFactory: (deps: { logger: AppLogger; binary?: string }) => TailscaleAccessReader;
	private readonly detectCloudflared: () => string;
	private readonly detectTailscale: () => string;

	/** 当前聚合状态（纯读，不改内部状态）。 */
	getState(): RemoteAccessState {
		const web = this.getWebServiceStatus();
		return {
			webRunning: web.running,
			webPort: web.port,
			webToken: web.token,
			webRequiresAuth: web.requiresAuth,
			cloudflare: { ...this.cloudflare },
			tailscale: { ...this.tailscale },
		};
	}

	private emit() {
		if (!this.disposed) this.push(this.getState());
	}

	/**
	 * 重新探测两个渠道的可用性（二进制、登录态、serve 指向）。
	 * 面板挂载、用户点「重新检测」、渠道启停后都会调用。
	 */
	async refresh(): Promise<RemoteAccessState> {
		// cloudflared：只做二进制定位，不动运行中的隧道
		const binaryPath = this.detectCloudflared();
		this.cloudflare.binaryPath = binaryPath;
		this.cloudflare.binaryAvailable = Boolean(binaryPath);

		// tailscale：二进制定位 + status/serve 探测（探测失败只落 error 字段）
		const tailscalePath = this.detectTailscale();
		this.tailscale.binaryPath = tailscalePath;
		this.tailscale.installed = Boolean(tailscalePath);
		if (tailscalePath) {
			this.reader = this.readerFactory({ logger: this.logger, binary: tailscalePath });
			const status = await this.reader.probeStatus();
			this.tailscale.loggedIn = status.loggedIn;
			this.tailscale.backendState = status.backendState;
			this.tailscale.ip = status.ip;
			this.tailscale.dnsName = status.dnsName;
			this.tailscale.error = status.error;
			const web = this.getWebServiceStatus();
			if (web.running && status.loggedIn) {
				const serveActive = await this.reader.probeServe(web.port);
				this.tailscale.serveActive = serveActive;
				this.tailscale.serveUrl = serveActive ? buildTailscaleServeUrl(status.dnsName) : "";
				// 认领既有 serve（上次会话留下的 tailscaled 配置），让换端口/重启能被正确管理
				if (serveActive) this.serveDesired = true;
			}
		} else {
			this.reader = null;
			this.tailscale.loggedIn = false;
			this.tailscale.ip = "";
			this.tailscale.dnsName = "";
			this.tailscale.serveActive = false;
			this.tailscale.serveUrl = "";
			this.tailscale.error = "";
		}
		this.emit();
		return this.getState();
	}

	/** 启动指定渠道；失败时把用户可读原因写进该渠道的 error 并推送。 */
	async start(channel: RemoteAccessChannelId): Promise<RemoteAccessState> {
		if (channel === "cloudflare") return this.startCloudflare();
		return this.startTailscaleServe();
	}

	/** 停用指定渠道；幂等。 */
	async stop(channel: RemoteAccessChannelId): Promise<RemoteAccessState> {
		if (channel === "cloudflare") return this.stopCloudflare();
		return this.stopTailscaleServe();
	}

	private async startCloudflare(): Promise<RemoteAccessState> {
		if (this.cloudflare.running || this.cloudflare.starting) return this.getState();
		const web = this.getWebServiceStatus();
		if (!web.running) {
			this.cloudflare.error = "请先在上方开启 Web 服务";
			this.emit();
			return this.getState();
		}
		if (!this.cloudflare.binaryPath) {
			const binaryPath = this.detectCloudflared();
			this.cloudflare.binaryPath = binaryPath;
			this.cloudflare.binaryAvailable = Boolean(binaryPath);
		}
		if (!this.cloudflare.binaryPath) {
			this.cloudflare.error = "未找到 cloudflared，请按操作指南安装后重新检测";
			this.emit();
			return this.getState();
		}

		this.cloudflareDesired = true;
		this.cloudflareStopRequested = false;
		this.cloudflare.starting = true;
		this.cloudflare.error = "";
		this.cloudflare.publicUrl = "";
		this.emit();

		const tunnel = this.tunnelFactory({ logger: this.logger, onEnded: (error) => this.handleTunnelEnded(error) });
		this.tunnel = tunnel;
		try {
			const publicUrl = await tunnel.start(this.cloudflare.binaryPath, web.port);
			if (this.disposed || tunnel !== this.tunnel) return this.getState(); // 竞态：等待期间被 stop/dispose 接管
			this.cloudflare.starting = false;
			this.cloudflare.running = true;
			this.cloudflare.publicUrl = publicUrl;
			tunnel.attachLifecycleWatch((error) => this.handleTunnelEnded(error));
			this.logger.info("web-remote", "cloudflare tunnel ready", { publicUrl });
			this.emit();
		} catch (error) {
			// 用户主动 stop 导致的退出不上报为错误
			if (tunnel === this.tunnel && !this.cloudflareStopRequested) {
				this.cloudflare.error = error instanceof Error ? error.message : String(error);
				this.logger.warn("web-remote", "cloudflare tunnel failed to start", { error: this.cloudflare.error });
			}
			this.cloudflare.starting = false;
			this.cloudflare.running = false;
			if (this.tunnel === tunnel) this.tunnel = null;
			this.emit();
		}
		return this.getState();
	}

	private async stopCloudflare(): Promise<RemoteAccessState> {
		this.cloudflareDesired = false;
		this.cloudflareStopRequested = true;
		this.cloudflare.error = "";
		this.cloudflare.publicUrl = "";
		this.cloudflare.starting = false;
		this.cloudflare.running = false;
		const tunnel = this.tunnel;
		this.tunnel = null;
		if (tunnel) await tunnel.stop();
		this.emit();
		return this.getState();
	}

	/** 隧道子进程意外退出（非用户 stop）：清运行态、上抛错误、按需重启。 */
	private handleTunnelEnded(error: string) {
		if (this.disposed || !this.cloudflare.running) return;
		this.cloudflare.running = false;
		this.cloudflare.publicUrl = "";
		this.tunnel = null;
		this.cloudflare.error = error;
		this.logger.warn("web-remote", "cloudflare tunnel ended unexpectedly", { error });
		this.emit();
	}

	private async startTailscaleServe(): Promise<RemoteAccessState> {
		const web = this.getWebServiceStatus();
		if (!web.running) {
			this.tailscale.error = "请先在上方开启 Web 服务";
			this.emit();
			return this.getState();
		}
		if (!this.reader) {
			this.tailscale.error = "未找到 tailscale，请按操作指南安装后重新检测";
			this.emit();
			return this.getState();
		}
		if (!this.tailscale.loggedIn) {
			this.tailscale.error = this.tailscale.installed ? "tailscale 尚未登录，请先在系统客户端登录" : "未找到 tailscale，请按操作指南安装后重新检测";
			this.emit();
			return this.getState();
		}
		try {
			await this.reader.startServe(web.port);
			this.serveDesired = true;
			this.tailscale.serveActive = true;
			this.tailscale.serveUrl = buildTailscaleServeUrl(this.tailscale.dnsName);
			this.tailscale.error = "";
			this.logger.info("web-remote", "tailscale serve enabled", { port: web.port, serveUrl: this.tailscale.serveUrl });
		} catch (error) {
			this.tailscale.serveActive = false;
			this.tailscale.serveUrl = "";
			this.tailscale.error = error instanceof Error ? error.message : String(error);
			this.logger.warn("web-remote", "tailscale serve enable failed", { error: this.tailscale.error });
		}
		this.emit();
		return this.getState();
	}

	private async stopTailscaleServe(): Promise<RemoteAccessState> {
		this.serveDesired = false;
		if (this.reader) {
			try {
				await this.reader.stopServe();
				this.tailscale.serveActive = false;
				this.tailscale.serveUrl = "";
				this.tailscale.error = "";
			} catch (error) {
				this.tailscale.error = error instanceof Error ? error.message : String(error);
				this.logger.warn("web-remote", "tailscale serve disable failed", { error: this.tailscale.error });
			}
		} else {
			this.tailscale.serveActive = false;
			this.tailscale.serveUrl = "";
		}
		this.emit();
		return this.getState();
	}

	/**
	 * Web 服务启停/重启后的收敛入口（装配层在 applySettings/restart/stop 后调用）：
	 * - Web 服务停了：渠道全部收口（隧道杀掉；serve 摘掉，避免线上挂 502 入口）。
	 * - 端口变了但渠道 desired：隧道重建、serve 重指。
	 */
	async syncWebService(): Promise<void> {
		if (this.disposed) return;
		const web = this.getWebServiceStatus();
		if (!web.running) {
			if (this.cloudflareDesired || this.cloudflare.running || this.cloudflare.starting) await this.stopCloudflare();
			if (this.serveDesired) {
				// 保留 desired：用户重新打开 Web 服务时自动恢复 serve
				await this.stopTailscaleServeQuiet();
				this.serveDesired = true;
			}
			this.emit();
			return;
		}
		if (this.cloudflareDesired && !this.cloudflare.running && !this.cloudflare.starting) {
			// Web 服务重启后自动恢复隧道（域名会变，UI 会拿到新地址）
			void this.startCloudflare();
		}
		if (this.serveDesired && this.tailscale.loggedIn && this.reader) {
			const serveActive = await this.reader.probeServe(web.port);
			if (!serveActive) {
				// 端口变化或 serve 丢失：重指到当前端口
				try {
					await this.reader.startServe(web.port);
					this.tailscale.serveActive = true;
					this.tailscale.serveUrl = buildTailscaleServeUrl(this.tailscale.dnsName);
				} catch (error) {
					this.tailscale.serveActive = false;
					this.tailscale.serveUrl = "";
					this.tailscale.error = error instanceof Error ? error.message : String(error);
				}
			} else {
				this.tailscale.serveActive = true;
				this.tailscale.serveUrl = buildTailscaleServeUrl(this.tailscale.dnsName);
			}
		}
		this.emit();
	}

	/** 停 serve 但保留 desired 标记（Web 服务临时关闭场景）。 */
	private async stopTailscaleServeQuiet(): Promise<void> {
		if (this.reader) {
			try {
				await this.reader.stopServe();
			} catch (error) {
				this.tailscale.error = error instanceof Error ? error.message : String(error);
			}
		}
		this.tailscale.serveActive = false;
		this.tailscale.serveUrl = "";
	}

	/** 应用退出收口：杀隧道子进程；serve 按需摘除（desired 时才动，避免误关用户自建的 serve）。 */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.cloudflareDesired = false;
		this.cloudflareStopRequested = true;
		const tunnel = this.tunnel;
		this.tunnel = null;
		if (tunnel) await tunnel.stop();
		if (this.serveDesired && this.reader) {
			try {
				await this.reader.stopServe();
			} catch {
				// 退出路径尽力而为，失败只记日志
			}
		}
	}
}
