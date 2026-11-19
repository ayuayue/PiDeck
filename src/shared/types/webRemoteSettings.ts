/**
 * 外网访问设置子契约：局域网 Web 服务、公网隧道（cloudflared）、私有组网（Tailscale/EasyTier）、
 * PiDeck Lite 移动端兼容。字段与清洗规则同源，`AppSettings` 以交叉类型并入这里。
 *
 * 拆出来的原因：settings.ts 已是存量巨文件（行数只准降不准升），这两族设置语义自成一体，
 * 直播在这里既能放字段注释，也能把配套枚举放在一起。
 */

/** cloudflared 隧道传输协议：http2 = TCP 443（默认，规避国内 UDP QoS 限速）、quic = UDP、auto = cloudflared 自行回退。 */
export const WEB_REMOTE_CLOUDFLARED_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type WebRemoteCloudflaredProtocol = (typeof WEB_REMOTE_CLOUDFLARED_PROTOCOLS)[number];

export type WebRemoteSettings = {
	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/**
	 * Web 服务监听地址。默认 0.0.0.0（绑定到所有网卡）：同网段任意主机可访问，
	 * 需配合 webServiceRequiresAuth 强制令牌校验，避免未授权调用。
	 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/**
	 * 鉴权开关。开 = 所有 /api/*（/api/health 除外）需携带访问令牌，环回地址也不例外；
	 * 默认 true，与默认 0.0.0.0 绑定配合，阻断局域网未授权访问。
	 */
	webServiceRequiresAuth: boolean;
	/**
	 * 固定访问令牌。持久化：重启服务/应用不换新，远程设备已保存的链接不失效；
	 * 缺省时首次启动自动生成并回写。可由设置页手动修改或重新生成。
	 */
	webServiceToken?: string;
	/** 令牌生成/最后修改时刻（epoch ms），过期计时的基准；不随重启重置 */
	webServiceTokenGeneratedAt?: number;
	/** 令牌有效期（ms），0 = 永不过期（默认）；从 generatedAt 起算，到期后请求 401 */
	webServiceTokenExpiresIn?: number;
	/**
	 * PiDeck Lite 移动端兼容：开启后，Lite 手机 App 可用同一地址与令牌连接，
	 * 浏览项目、会话与对话，并发送消息、切换模型与思考档位、停止/改名/删除/回答确认。
	 * `/api/state` 等冲突路径仅对 Go 默认 UA 返回 Lite 形状，浏览器不受影响。默认关闭。
	 */
	webLiteCompatEnabled?: boolean;
	/**
	 * cloudflared 隧道传输协议：http2 = TCP 443（默认，规避国内 UDP QoS 限速）、
	 * quic = UDP、auto = cloudflared 自行回退。用户环境差异大，允许调整。
	 */
	webRemoteCloudflaredProtocol?: WebRemoteCloudflaredProtocol;
	/** cloudflared 额外启动参数（空白切分后数组直传子进程，无 shell 注入面）；如 "--edge-ip-version 6" */
	webRemoteCloudflaredExtraArgs?: string;
	/**
	 * EasyTier 虚拟 IPv4 手动兜底：EasyTier GUI 默认模式不开放本地管理端口时，
	 * easytier-cli 读不到节点，由用户从客户端抄写虚拟 IP；空 = 不启用手动地址。
	 */
	webRemoteEasyTierIp?: string;
	/**
	 * 用户指定的 easytier-cli 可执行文件路径（解压版 CLI / 非默认目录安装时自动检测可能找不到）；
	 * 空 = 只用自动检测。填写后优先使用该路径。
	 */
	webRemoteEasyTierCliPath?: string;
	/**
	 * 由 PiDeck 托管的 EasyTier 网络标识。三者齐备时组件接管 core 的启动与配置生成，
	 * 缺任意一项都退回只读探测（网络仍由用户自己的客户端管理）。
	 */
	webRemoteEasyTierNetworkName?: string;
	/** 由 PiDeck 托管的 EasyTier 网络密钥；明文存储，仅在本机 settings.json 中，不经 Web API 投影。 */
	webRemoteEasyTierNetworkSecret?: string;
	/** 共享节点列表（tcp/udp/ws/wss 等 URL）；可为空，为空时只能与局域网内节点互联。 */
	webRemoteEasyTierPeers?: string[];
	/**
	 * 自定义公网地址：用户自己用 Cloudflare Tunnel（命名隧道）/ 反向代理 / 自有域名把本机端口
	 * 映射到公网时填写，用于生成固定访问链接（不随重启变化）。只保留 origin（scheme://host[:port]），
	 * 路径/查询串会被丢弃；空 = 未配置。
	 */
	webRemotePublicUrl?: string;
};
