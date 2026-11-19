/**
 * 外网访问设置的清洗（读盘 + patch 两道入口）。
 *
 * 语义与设置页/Web 服务一致：脏值一律视为「未设置」，只有显式真值才开启有安全影响的开关。
 * 之所以独立成模块：SettingsStore 是存量巨文件（行数只准降不准升），而这一族字段的清洗规则
 * 与 shared/types/webRemoteSettings.ts 的字段定义一一对应，放一起便于核对。
 */
import type { AppSettings } from "../../shared/types";
import { normalizeRemotePublicUrl } from "../../shared/types/remoteAccess";
import { WEB_REMOTE_CLOUDFLARED_PROTOCOLS, WEB_TOKEN_EXPIRES_IN_CHOICES, isValidWebTokenShape, sanitizeCloudflaredExtraArgs, sanitizeEasyTierCliPath, sanitizeEasyTierNetworkName, sanitizeEasyTierNetworkSecret, sanitizeEasyTierPeers, sanitizeEasyTierVirtualIp } from "../../shared/types";

/**
 * 读盘：把 settings.json 里的外网访问字段清洗进 `target`。
 * 缺字段 = 老版本配置，回落到 `defaults`（默认关局域网、默认强制令牌校验）。
 */
export function applyWebRemoteSettingsFromDisk(target: AppSettings, source: Partial<AppSettings>, defaults: AppSettings): void {
	// host 脏值/旧版缺字段回落到 0.0.0.0，与默认监听所有网卡保持一致。
	target.webServiceHost = typeof source.webServiceHost === "string" ? source.webServiceHost.trim() || defaults.webServiceHost : defaults.webServiceHost;
	// 鉴权开关：旧 settings.json 缺字段或脏值回落 true，默认强制 token 校验。
	if (typeof target.webServiceRequiresAuth !== "boolean") {
		target.webServiceRequiresAuth = defaults.webServiceRequiresAuth;
	}
	// PiDeck Lite 移动端兼容：只有显式 true 才开启，缺字段/脏值一律关闭（零行为变化）。
	target.webLiteCompatEnabled = source.webLiteCompatEnabled === true;
	// 固定令牌机制：旧 JSON 无该字段 = 尚未生成，留给 WebServiceManager 首次启动生成并回写；
	// 有值则清洗为 trim 后的 8-128 可打印字符（与设置页/IPC 入口同一约束），越界视为未设置。
	const parsedToken = typeof source.webServiceToken === "string" ? source.webServiceToken.trim() : "";
	target.webServiceToken = isValidWebTokenShape(parsedToken) ? parsedToken : undefined;
	target.webServiceTokenGeneratedAt = typeof source.webServiceTokenGeneratedAt === "number" && Number.isFinite(source.webServiceTokenGeneratedAt) && source.webServiceTokenGeneratedAt > 0 ? source.webServiceTokenGeneratedAt : undefined;
	const parsedExpiresIn = source.webServiceTokenExpiresIn;
	target.webServiceTokenExpiresIn = typeof parsedExpiresIn === "number" && (WEB_TOKEN_EXPIRES_IN_CHOICES as readonly number[]).includes(parsedExpiresIn) ? parsedExpiresIn : undefined;
	const parsedProtocol = source.webRemoteCloudflaredProtocol;
	target.webRemoteCloudflaredProtocol = parsedProtocol && (WEB_REMOTE_CLOUDFLARED_PROTOCOLS as readonly string[]).includes(parsedProtocol) ? parsedProtocol : undefined;
	target.webRemoteCloudflaredExtraArgs = sanitizeCloudflaredExtraArgs(source.webRemoteCloudflaredExtraArgs) || undefined;
	// EasyTier 手动兜底 IP：严格 IPv4，脏值/历史缺字段一律视为未设置。
	target.webRemoteEasyTierIp = sanitizeEasyTierVirtualIp(source.webRemoteEasyTierIp) || undefined;
	// EasyTier CLI 路径：解压版/非默认目录安装时的显式入口，脏值视为未设置。
	target.webRemoteEasyTierCliPath = sanitizeEasyTierCliPath(source.webRemoteEasyTierCliPath) || undefined;
	// 托管网络的三个字段：缺任意一项都由 UI/主进程退回只读探测，脏值一并视为未设置。
	target.webRemoteEasyTierNetworkName = sanitizeEasyTierNetworkName(source.webRemoteEasyTierNetworkName) || undefined;
	target.webRemoteEasyTierNetworkSecret = sanitizeEasyTierNetworkSecret(source.webRemoteEasyTierNetworkSecret) || undefined;
	const parsedPeers = sanitizeEasyTierPeers(source.webRemoteEasyTierPeers);
	target.webRemoteEasyTierPeers = parsedPeers.length > 0 ? parsedPeers : undefined;
	// 自定义公网地址：只保留 origin（补 https、丢路径），脏值/历史缺字段一律视为未配置。
	target.webRemotePublicUrl = normalizeRemotePublicUrl(source.webRemotePublicUrl) || undefined;
}

/**
 * patch：清洗渲染层提交的外网访问字段。空串 = 清除；非法值直接删键（不覆盖既有设置）。
 */
export function sanitizeWebRemoteSettingsPatch(patch: Partial<AppSettings>): void {
	// Lite 兼容开关：只认布尔，脏值不落盘（缺失 = 保持当前值）。
	if ("webLiteCompatEnabled" in patch && typeof patch.webLiteCompatEnabled !== "boolean") {
		delete patch.webLiteCompatEnabled;
	}
	// EasyTier 手动 IP：空串表示清除（undefined 会随 JSON 序列化消失）；非法值不覆盖既有设置。
	if ("webRemoteEasyTierIp" in patch) {
		const raw = patch.webRemoteEasyTierIp;
		const sanitized = sanitizeEasyTierVirtualIp(raw);
		if (sanitized) patch.webRemoteEasyTierIp = sanitized;
		else if (typeof raw === "string" && raw.trim() === "") patch.webRemoteEasyTierIp = undefined;
		else delete patch.webRemoteEasyTierIp;
	}
	// EasyTier CLI 路径：同一口径——空串清除，非法值不覆盖既有设置。
	if ("webRemoteEasyTierCliPath" in patch) {
		const raw = patch.webRemoteEasyTierCliPath;
		const sanitized = sanitizeEasyTierCliPath(raw);
		if (sanitized) patch.webRemoteEasyTierCliPath = sanitized;
		else if (typeof raw === "string" && raw.trim() === "") patch.webRemoteEasyTierCliPath = undefined;
		else delete patch.webRemoteEasyTierCliPath;
	}
	// 托管网络字段：空串清除，非法值不覆盖既有设置；peers 清洗后为空数组同样视为清除。
	for (const key of ["webRemoteEasyTierNetworkName", "webRemoteEasyTierNetworkSecret"] as const) {
		if (!(key in patch)) continue;
		const raw = patch[key];
		const sanitized = key === "webRemoteEasyTierNetworkName" ? sanitizeEasyTierNetworkName(raw) : sanitizeEasyTierNetworkSecret(raw);
		if (sanitized) patch[key] = sanitized;
		else if (typeof raw === "string" && raw.trim() === "") patch[key] = undefined;
		else delete patch[key];
	}
	if ("webRemoteEasyTierPeers" in patch) {
		const peers = sanitizeEasyTierPeers(patch.webRemoteEasyTierPeers);
		if (peers.length > 0) patch.webRemoteEasyTierPeers = peers;
		else if (Array.isArray(patch.webRemoteEasyTierPeers)) patch.webRemoteEasyTierPeers = undefined;
		else delete patch.webRemoteEasyTierPeers;
	}
	// 自定义公网地址：空串清除；合法地址归一为 origin 后落盘；非法值不覆盖既有设置。
	if ("webRemotePublicUrl" in patch) {
		const raw = patch.webRemotePublicUrl;
		const normalized = normalizeRemotePublicUrl(raw);
		if (normalized) patch.webRemotePublicUrl = normalized;
		else if (typeof raw === "string" && raw.trim() === "") patch.webRemotePublicUrl = undefined;
		else delete patch.webRemotePublicUrl;
	}
}
