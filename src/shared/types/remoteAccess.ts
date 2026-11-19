/**
 * 外网访问（内网穿透）契约：设置页「外网访问」面板与主进程 RemoteAccessManager 的共享形状。
 *
 * 三个可启停渠道 + 一个纯链接渠道：
 * - cloudflare：本机 cloudflared 免注册 quick tunnel（https://xxx.trycloudflare.com），
 *   手机零安装即可访问；域名每次启动都会变化，且流量经 Cloudflare 中转，必须保持 token 鉴权。
 * - tailscale：本机已登录的 tailscale 组网；直连地址（http://100.x.y.z:port）始终可用，
 *   serve 模式可额外提供固定 https 入口（PWA/Service Worker 需要 HTTPS）。
 * - easytier：本机已运行的 EasyTier P2P 组网；只读渠道，PiDeck 不启动/停止网络，
 *   只读取本地节点虚拟 IP 并生成直连地址（http://<virtual-ip>:port）。
 * - 自定义公网地址：用户自己用 Cloudflare Tunnel（命名隧道）/ 反向代理 / 自有域名把本机端口
 *   映射到公网时填写；PiDeck 不管理该隧道，只用它生成固定访问链接（重启不变）。
 *
 * 所有状态均为运行时快照，不持久化到设置：quick tunnel 域名每次都会变，
 * tailscale serve 的配置由 tailscaled 自己持久化，PiDeck 只负责反映与收口；
 * 自定义公网地址是用户填写的配置，持久化在设置里，只有拼接出的链接随 token 变化。
 */

/**
 * 规范化用户填写的自定义公网地址，返回 `scheme://host[:port]`。
 *
 * 规则（与 PiDeck Lite 的 remote_public.go 对齐）：
 * - 空/非字符串 → ""；
 * - 没有 scheme 时补 `https://`（用户常只贴域名）；
 * - 只接受 http/https，其余协议一律拒绝；
 * - 丢弃 path/query/hash/userinfo：转发层把本应用的 API 挂在根上，
 *   带路径的地址只会拼出坏链接；同时避免把凭据/查询串带进二维码。
 */
export function normalizeRemotePublicUrl(raw: unknown): string {
	if (typeof raw !== "string") return "";
	let text = raw.trim();
	if (!text) return "";
	if (!text.includes("://")) text = `https://${text}`;
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return "";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
	if (!parsed.hostname) return "";
	return `${parsed.protocol}//${parsed.host}`;
}

/**
 * 可启停渠道标识：cloudflare = 免注册公网隧道；tailscale = 私有组网（含 serve HTTPS 入口）；
 * easytier = 本机 EasyTier core（PiDeck 托管时经系统服务启停，未托管时启停是空操作）。
 */
export type RemoteAccessChannelId = "cloudflare" | "tailscale" | "easytier";

/** IPC 入参守卫：白名单枚举之外的任何值都不进业务层。 */
export function isRemoteAccessChannelId(value: unknown): value is RemoteAccessChannelId {
	return value === "cloudflare" || value === "tailscale" || value === "easytier";
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

/**
 * EasyTier 渠道状态。
 * 两种模式：托管（网络名/密钥齐备，PiDeck 生成配置并经系统服务启停）与只读（网络由用户自己的客户端管理）。
 */
export type EasyTierAccessState = {
	/** 本机是否找到了 easytier-cli（自动读取虚拟 IP 用；找不到时仍可手动填写）。 */
	installed: boolean;
	/** CLI 路径（未找到为空串）。 */
	binaryPath: string;
	/** 本机是否找到了 easytier-core（托管模式启动用；只有 CLI 时为 false）。 */
	coreAvailable: boolean;
	/** 托管配置是否齐备（网络名 + 密钥都填了）。 */
	configPresent: boolean;
	/** 本机是否已安装 easytier 系统服务。 */
	serviceInstalled: boolean;
	/** 系统服务是否处于运行中。 */
	serviceRunning: boolean;
	/** CLI 能否读到运行中的本地 EasyTier 节点。 */
	running: boolean;
	/** EasyTier 虚拟 IPv4（自动检测或手动填写；不带 CIDR；未知为空串）。 */
	ip: string;
	/** 节点名（自动检测到时可用）。 */
	hostname: string;
	/** EasyTier core 版本（自动检测到时可用）。 */
	version: string;
	/** ip 来源：cli = CLI 自动读取；manual = 用户手动填写。 */
	ipSource: "cli" | "manual" | "";
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
	easytier: EasyTierAccessState;
};

/** EasyTier 空状态：主进程未探测/预览环境共用。 */
export function emptyEasyTierAccessState(): EasyTierAccessState {
	return { installed: false, binaryPath: "", coreAvailable: false, configPresent: false, serviceInstalled: false, serviceRunning: false, running: false, ip: "", hostname: "", version: "", ipSource: "", error: "" };
}

/** 未探测/预览环境下的空状态：渲染层与 previewApi 复用，避免各自拼默认形状。 */
export function emptyRemoteAccessState(): RemoteAccessState {
	return {
		webRunning: false,
		webPort: 0,
		webToken: "",
		webRequiresAuth: false,
		cloudflare: { binaryAvailable: false, binaryPath: "", running: false, starting: false, publicUrl: "", error: "" },
		tailscale: { installed: false, binaryPath: "", loggedIn: false, backendState: "", ip: "", dnsName: "", serveActive: false, serveUrl: "", error: "" },
		easytier: emptyEasyTierAccessState(),
	};
}
