/**
 * 外网访问（内网穿透）契约：设置页「外网访问」面板与主进程 RemoteAccessManager 的共享形状。
 *
 * 两个渠道：
 * - cloudflare：本机 cloudflared 免注册 quick tunnel（https://xxx.trycloudflare.com），
 *   手机零安装即可访问；域名每次启动都会变化，且流量经 Cloudflare 中转，必须保持 token 鉴权。
 * - tailscale：本机已登录的 tailscale 组网；直连地址（http://100.x.y.z:port）始终可用，
 *   serve 模式可额外提供固定 https 入口（PWA/Service Worker 需要 HTTPS）。
 *
 * 所有状态均为运行时快照，不持久化到设置：quick tunnel 域名每次都会变，
 * tailscale serve 的配置由 tailscaled 自己持久化，PiDeck 只负责反映与收口。
 */

/** 渠道标识：cloudflare = 免注册公网隧道；tailscale = 私有组网（含 serve HTTPS 入口）。 */
export type RemoteAccessChannelId = "cloudflare" | "tailscale";

/** IPC 入参守卫：白名单枚举之外的任何值都不进业务层。 */
export function isRemoteAccessChannelId(value: unknown): value is RemoteAccessChannelId {
	return value === "cloudflare" || value === "tailscale";
}

/** cloudflared quick tunnel 渠道状态。 */
export type CloudflareTunnelState = {
	/** 本机是否找到了 cloudflared 可执行文件（PATH + 常见安装目录扫描）。 */
	binaryAvailable: boolean;
	/** 检测到的二进制路径（未找到为空串；仅用于展示与日志，不含敏感信息）。 */
	binaryPath: string;
	/** 隧道子进程存活中。 */
	running: boolean;
	/** 启动中：子进程已拉起、等待 Cloudflare 分配域名。 */
	starting: boolean;
	/** 分配到的公网地址（https://xxx.trycloudflare.com，不带 token）。 */
	publicUrl: string;
	/** 最近一次错误摘要（用户可读；空串表示无错误）。 */
	error: string;
};

/** tailscale 渠道状态。 */
export type TailscaleAccessState = {
	/** 本机是否找到了 tailscale CLI。 */
	installed: boolean;
	/** CLI 路径（未找到为空串）。 */
	binaryPath: string;
	/** 已登录且 tailscaled 在线（BackendState === Running）。 */
	loggedIn: boolean;
	/** 未登录/未就绪时的后端状态原文（NeedsLogin / Starting / Stopped …），登录成功为空。 */
	backendState: string;
	/** 本机 tailscale 虚拟 IPv4（100.x.y.z；未就绪为空串）。 */
	ip: string;
	/** MagicDNS 机器名（host.tailnet.ts.net，已去掉尾点；未就绪为空串）。 */
	dnsName: string;
	/** serve HTTPS 入口是否已指向本应用 Web 服务端口。 */
	serveActive: boolean;
	/** serve 启用后的 https 入口（不带 token；未启用为空串）。 */
	serveUrl: string;
	/** 最近一次错误摘要（用户可读；空串表示无错误）。 */
	error: string;
};

/** 外网访问聚合状态：渲染层一次 invoke 拿全量，变化时经 web:remote-access-changed 推送。 */
export type RemoteAccessState = {
	/** Web 服务当前是否在运行（渠道可用的前提）。 */
	webRunning: boolean;
	/** Web 服务监听端口（隧道转发目标）。 */
	webPort: number;
	/** Web 服务本次启动的访问令牌（拼 URL 用；requiresAuth=false 时为空）。 */
	webToken: string;
	/** Web 服务是否要求 token 鉴权。 */
	webRequiresAuth: boolean;
	cloudflare: CloudflareTunnelState;
	tailscale: TailscaleAccessState;
};

/** 未探测/预览环境下的空状态：渲染层与 previewApi 复用，避免各自拼默认形状。 */
export function emptyRemoteAccessState(): RemoteAccessState {
	return {
		webRunning: false,
		webPort: 0,
		webToken: "",
		webRequiresAuth: false,
		cloudflare: { binaryAvailable: false, binaryPath: "", running: false, starting: false, publicUrl: "", error: "" },
		tailscale: { installed: false, binaryPath: "", loggedIn: false, backendState: "", ip: "", dnsName: "", serveActive: false, serveUrl: "", error: "" },
	};
}
