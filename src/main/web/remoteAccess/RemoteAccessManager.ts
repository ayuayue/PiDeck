/**
 * 外网访问编排器：聚合 cloudflare quick tunnel、tailscale serve 与 EasyTier 只读渠道的生命周期，
 * 输出单一 RemoteAccessState 快照（渲染层只认这个形状）。
 *
 * 设计要点：
 * - 状态不持久化：cloudflare 域名每次都变、serve 配置由 tailscaled 自己持久化，
 *   本类只维护「本次会话内用户想要什么」（desired 标记），Web 服务启停/换端口时据此收敛。
 * - 所有方法不向 IPC 抛裸异常：可预期失败以返回值/状态里的 error 字段表达。
 * - cloudflare/tailscale 是 Web 服务的附属：Web 服务停止时一并收口（隧道杀进程、serve 摘除）；
 *   EasyTier 在托管模式（网络名/密钥齐备）下由 PiDeck 生成配置并经系统服务启停，
 *   未配置时退回只读探测——不随 Web 服务启停，避免误断用户自己的网络。
 */
import type { AppLogger } from "../../logging/AppLogger";
import type { RemoteAccessState, RemoteAccessChannelId, CloudflareTunnelState, TailscaleAccessState, EasyTierAccessState } from "../../../shared/types/remoteAccess";
import type { WebServiceStatusInfo } from "../../../shared/types/settings";
import { CloudflaredTunnelProcess, detectCloudflaredBinary, type CloudflaredTunnelOptions } from "./cloudflaredTunnel";
import { TailscaleAccessReader, buildTailscaleServeUrl, detectTailscaleBinary } from "./tailscaleAccess";
import { EasyTierAccessReader, detectEasyTierBinary, detectEasyTierCore, normalizeEasyTierIpv4 } from "./easytierAccess";
import { EasyTierServiceHost, buildEasyTierToml, isEasyTierConfigReady, type EasyTierManagedConfig, type EasyTierServiceInfo } from "./easytierService";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RemoteAccessManagerDeps = {
	logger: AppLogger;
	/** Web 服务当前状态（隧道转发目标；stop/start 后由装配层调 syncWebService 收敛渠道）。 */
	getWebServiceStatus: () => WebServiceStatusInfo;
	/** 状态变化时推给渲染层（装配层接主窗口 webContents.send）。 */
	pushState: (state: RemoteAccessState) => void;
	/** 读取用户设置的隧道启动选项（协议/额外参数）；每次 start 时取最新，改设置后重启隧道生效。 */
	getTunnelOptions?: () => CloudflaredTunnelOptions;
	/** 读取 EasyTier 手动兜底虚拟 IP（自动检测失败时使用）；每次探测取最新。 */
	getEasyTierManualIp?: () => string;
	/** 读取用户指定的 easytier-cli 路径（解压版/非默认目录安装）；每次探测取最新。 */
	getEasyTierCliPath?: () => string;
	/** 测试注入点：替换真实子进程/命令执行。 */
	tunnelFactory?: (deps: { logger: AppLogger; onEnded: (error: string) => void }) => CloudflaredTunnelProcess;
	readerFactory?: (deps: { logger: AppLogger; binary?: string }) => TailscaleAccessReader;
	easytierReaderFactory?: (deps: { logger: AppLogger; binary?: string; manualIp?: string }) => EasyTierAccessReader;
	/** 读取托管配置（网络名/密钥/节点/绑定 IP）；返回 null = 未配置，退回只读探测。 */
	getEasyTierConfig?: () => EasyTierManagedConfig | null;
	/** 托管配置落地路径（服务安装时 `-c` 指向它，路径一旦确定就不再变化）。 */
	getEasyTierConfigPath?: () => string;
	/** 测试注入点：替换系统服务控制。 */
	serviceHostFactory?: (deps: { logger: AppLogger; cliPath: string; corePath?: string }) => EasyTierServiceHost;
	/** 测试注入点：替换 PATH 探测，避免单测依赖本机安装。 */
	detectCloudflared?: () => string;
	detectTailscale?: () => string;
	detectEasyTier?: (preferredPath?: string) => string | Promise<string>;
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

	// ── easytier 渠道（托管或只读，取决于是否配置了网络名/密钥）──
	private easytier: EasyTierAccessState = {
		installed: false,
		binaryPath: "",
		coreAvailable: false,
		configPresent: false,
		serviceInstalled: false,
		serviceRunning: false,
		running: false,
		ip: "",
		hostname: "",
		version: "",
		ipSource: "",
		error: "",
	};
	private easytierReader: EasyTierAccessReader | null = null;
	/** 服务控制句柄：CLI 找到后才创建，配置路径由装配层注入。 */
	private serviceHost: EasyTierServiceHost | null = null;

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
		this.detectEasyTier = deps.detectEasyTier ?? detectEasyTierBinary;
		this.easytierReaderFactory = deps.easytierReaderFactory ?? ((d) => new EasyTierAccessReader(d));
		this.getTunnelOptions = deps.getTunnelOptions ?? (() => ({}));
		this.getEasyTierManualIp = deps.getEasyTierManualIp ?? (() => "");
		this.getEasyTierCliPath = deps.getEasyTierCliPath ?? (() => "");
		this.getEasyTierConfig = deps.getEasyTierConfig ?? (() => null);
		this.getEasyTierConfigPath = deps.getEasyTierConfigPath ?? (() => "");
		this.serviceHostFactory = deps.serviceHostFactory ?? ((d) => new EasyTierServiceHost(d));
	}

	private readonly tunnelFactory: (deps: { logger: AppLogger; onEnded: (error: string) => void }) => CloudflaredTunnelProcess;
	private readonly readerFactory: (deps: { logger: AppLogger; binary?: string }) => TailscaleAccessReader;
	private readonly easytierReaderFactory: (deps: { logger: AppLogger; binary?: string; manualIp?: string }) => EasyTierAccessReader;
	private readonly detectCloudflared: () => string;
	private readonly detectTailscale: () => string;
	private readonly detectEasyTier: (preferredPath?: string) => string | Promise<string>;
	private readonly getTunnelOptions: () => CloudflaredTunnelOptions;
	private readonly getEasyTierManualIp: () => string;
	private readonly getEasyTierCliPath: () => string;
	private readonly getEasyTierConfig: () => EasyTierManagedConfig | null;
	private readonly getEasyTierConfigPath: () => string;
	private readonly serviceHostFactory: (deps: { logger: AppLogger; cliPath: string; corePath?: string }) => EasyTierServiceHost;

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
			easytier: { ...this.easytier },
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
		await this.refreshEasyTier();
		this.emit();
		return this.getState();
	}

	/**
	 * EasyTier 只读探测：定位 CLI、读取运行中节点的虚拟 IP；CLI 读不到时回落到手动 IP。
	 * 不启动/停止 EasyTier 进程——网络生命周期由用户自己的客户端或系统服务管理。
	 */
	private async refreshEasyTier(): Promise<void> {
		try {
			// 用户指定的路径优先：解压版 CLI 不在 PATH、也没有卸载信息可查。
			const cliPath = this.getEasyTierCliPath().trim();
			const binaryPath = await this.detectEasyTier(cliPath);
			const manualIp = normalizeEasyTierIpv4(this.getEasyTierManualIp());
			this.easytier.binaryPath = binaryPath;
			this.easytier.installed = Boolean(binaryPath);
			// 托管相关状态：core 是否可启、配置是否齐备、系统服务是否已装/在跑。
			const corePath = binaryPath ? detectEasyTierCore(binaryPath) : "";
			this.easytier.coreAvailable = Boolean(corePath);
			this.easytier.configPresent = isEasyTierConfigReady(this.getEasyTierConfig());
			this.serviceHost = binaryPath ? this.serviceHostFactory({ logger: this.logger, cliPath: binaryPath, corePath }) : null;
			const serviceInfo: EasyTierServiceInfo = this.serviceHost ? await this.serviceHost.status() : { installed: false, running: false };
			this.easytier.serviceInstalled = serviceInfo.installed;
			this.easytier.serviceRunning = serviceInfo.running;
			if (!binaryPath) {
				this.easytierReader = null;
				this.easytier.running = false;
				this.easytier.ip = manualIp;
				this.easytier.hostname = "";
				this.easytier.version = "";
				this.easytier.ipSource = manualIp ? "manual" : "";
				// 指定了路径却仍找不到：多半是路径写错/文件被移动，直接说清楚，别让用户以为重检没生效。
				this.easytier.error = cliPath ? "指定的 easytier-cli 路径不可用，请检查路径或清空后重新检测" : "";
				return;
			}
			this.easytierReader = this.easytierReaderFactory({ logger: this.logger, binary: binaryPath, manualIp });
			const probe = await this.easytierReader.probe();
			this.easytier.running = probe.running;
			this.easytier.ip = probe.ip;
			this.easytier.hostname = probe.hostname;
			this.easytier.version = probe.version;
			this.easytier.ipSource = probe.ipSource;
			this.easytier.error = probe.error;
		} catch (error) {
			// 只读渠道的探测异常绝不能影响 Web 服务设置提交/启停；落 error 字段即可。
			this.easytier.running = false;
			this.easytier.error = error instanceof Error ? error.message : String(error);
			this.logger.warn("web-remote", "easytier refresh failed", { error: this.easytier.error });
		}
	}

	/** 启动指定渠道；失败时把用户可读原因写进该渠道的 error 并推送。 */
	/**
	 * 启动指定渠道。
	 * @param override 仅 easytier：渲染层传入的「当前草稿」配置。设置弹框里改完还没保存就点启动时，
	 * 用它覆盖已落盘的设置，避免「必须点保存才能启动」。
	 */
	async start(channel: RemoteAccessChannelId, override?: EasyTierManagedConfig | null): Promise<RemoteAccessState> {
		if (channel === "cloudflare") return this.startCloudflare();
		if (channel === "easytier") return this.startEasyTier(override);
		return this.startTailscaleServe();
	}

	/** 停用指定渠道；幂等。 */
	async stop(channel: RemoteAccessChannelId): Promise<RemoteAccessState> {
		if (channel === "cloudflare") return this.stopCloudflare();
		if (channel === "easytier") return this.stopEasyTier();
		return this.stopTailscaleServe();
	}

	/** 托管配置的 TOML 文本；未配置或路径未就绪时返回空串（Web 下载路由据此 404）。 */
	buildEasyTierConfigToml(): string {
		const config = this.getEasyTierConfig();
		if (!isEasyTierConfigReady(config)) return "";
		return buildEasyTierToml(config as EasyTierManagedConfig);
	}

	/**
	 * 启动托管网络：先落盘配置，再（必要时）安装系统服务并启动。
	 * 安装/启动需要管理员权限，会弹 UAC；配置文件路径固定，后续改配置只需重启服务。
	 */
	private async startEasyTier(override?: EasyTierManagedConfig | null): Promise<RemoteAccessState> {
		this.easytier.error = "";
		const config = override ?? this.getEasyTierConfig();
		if (!isEasyTierConfigReady(config)) {
			this.easytier.error = "请先填写网络名称与网络密钥";
			this.emit();
			return this.getState();
		}
		if (!this.easytier.installed || !this.easytier.coreAvailable) {
			this.easytier.error = this.easytier.installed ? "未找到 easytier-core，请检查 EasyTier 安装目录或指定 CLI 路径" : "未找到 easytier-cli，请先安装 EasyTier";
			this.emit();
			return this.getState();
		}
		const configPath = this.getEasyTierConfigPath();
		if (!configPath || !this.serviceHost) {
			this.easytier.error = "托管配置路径未初始化";
			this.emit();
			return this.getState();
		}
		try {
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, buildEasyTierToml(config as EasyTierManagedConfig), "utf8");
			if (!this.easytier.serviceInstalled) await this.serviceHost.install(configPath);
			// 服务已在运行时 sc start 会报「已启动」；配置写在固定路径，必须停掉再启才能让新配置生效（即可重启）。
			if (this.easytier.serviceRunning) await this.serviceHost.stop();
			await this.serviceHost.start();
			this.logger.info("web-remote", "easytier service started", { configPath });
		} catch (error) {
			this.easytier.error = error instanceof Error ? error.message : String(error);
			this.logger.warn("web-remote", "easytier start failed", { error: this.easytier.error });
		}
		await this.refreshEasyTier();
		this.emit();
		return this.getState();
	}

	/** 停止托管网络（需要管理员权限，会弹 UAC）；服务未安装时是空操作。 */
	private async stopEasyTier(): Promise<RemoteAccessState> {
		this.easytier.error = "";
		if (this.serviceHost && this.easytier.serviceInstalled) {
			try {
				await this.serviceHost.stop();
			} catch (error) {
				this.easytier.error = error instanceof Error ? error.message : String(error);
				this.logger.warn("web-remote", "easytier stop failed", { error: this.easytier.error });
			}
		}
		await this.refreshEasyTier();
		this.emit();
		return this.getState();
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
			const publicUrl = await tunnel.start(this.cloudflare.binaryPath, web.port, this.getTunnelOptions());
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
			// 启动失败必须杀掉子进程：waitForUrl 超时只是域名没拿到，cloudflared 可能仍在运行；
			// 不清理会留孤儿进程，甚至稍后自行建好隧道——公网入口存在但 UI 显示失败（幽灵暴露面）。
			// stop 幂等，被 stopCloudflare 接管过的重复调用安全。
			try {
				await tunnel.stop();
			} catch (stopError) {
				this.logger.warn("web-remote", "cloudflare tunnel cleanup after failed start", { error: stopError instanceof Error ? stopError.message : String(stopError) });
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
		// 设置保存后（含 EasyTier 手动 IP 变更）顺带刷新只读渠道，UI 无需再点一次「重新检测」。
		await this.refreshEasyTier();
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
			} catch (error) {
				// 退出路径尽力而为，失败只记日志不阻断退出
				this.logger.warn("web-remote", "tailscale serve stop failed on dispose", { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
}
