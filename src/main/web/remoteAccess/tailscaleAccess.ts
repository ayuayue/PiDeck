/**
 * tailscale 渠道：CLI 定位、登录/在线状态解析、serve HTTPS 入口管理。
 *
 * 数据来源与命令（均为只读或幂等操作，参数数组传递、不经 shell）：
 * - `tailscale status --json` → BackendState / Self.TailscaleIPs / Self.DNSName
 * - `tailscale serve --bg http://127.0.0.1:<port>` → 建立固定 https 入口（配置由 tailscaled 持久化）
 * - `tailscale serve off` → 关闭本机全部 serve 入口（PiDeck 简化语义：整机托管）
 *
 * serve 需要 tailnet 开启 MagicDNS + HTTPS 证书；未开启时命令会失败，
 * 错误原文透传给渲染层，由操作指南引导用户到管理台开启。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { AppLogger } from "../../logging/AppLogger";

const execFileAsync = promisify(execFile);

/** status --json 中渲染层关心的最小字段子集（宽松解析：多余字段忽略）。 */
export type TailscaleStatusJson = {
	BackendState?: string;
	Self?: {
		Online?: boolean;
		TailscaleIPs?: string[];
		DNSName?: string;
	};
};

/** 可注入的命令执行器：测试用替身返回构造好的 status JSON，不跑真实 CLI。 */
export type TailscaleCommandFn = (args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

/** 定位 tailscale CLI：PATH + 各平台官方安装目录兜底；找不到返回空串。 */
export function detectTailscaleBinary(): string {
	const exeName = "tailscale" + (process.platform === "win32" ? ".exe" : "");
	const candidates: string[] = [];
	const pathValue = process.env.PATH || process.env.Path || "";
	for (const dir of pathValue.split(delimiter)) {
		if (dir.trim()) candidates.push(join(dir, exeName));
	}
	if (process.platform === "win32") {
		// Windows 官方安装器默认目录（x64/x86）
		for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
			if (base) candidates.push(join(base, "Tailscale", exeName), join(base, "Tailscale IPN", exeName));
		}
	} else if (process.platform === "darwin") {
		candidates.push(join("/Applications/Tailscale.app/Contents/MacOS", "Tailscale"), join("/usr/local/bin", exeName), join("/opt/homebrew/bin", exeName));
	} else {
		candidates.push(join("/usr/bin", exeName), join("/usr/local/bin", exeName), join("/usr/sbin", exeName), join(homedir(), ".local", "bin", exeName));
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// 单目录不可读不影响继续
		}
	}
	return "";
}

/** 解析 status --json：提炼登录态、虚拟 IPv4 与 MagicDNS 机器名。 */
export function parseTailscaleStatus(json: TailscaleStatusJson): { loggedIn: boolean; backendState: string; ip: string; dnsName: string } {
	const backendState = typeof json.BackendState === "string" ? json.BackendState : "";
	const loggedIn = backendState === "Running";
	// TailscaleIPs[0] 是 IPv4（100.x.y.z），[1] 是 IPv6ULA；只取 v4 供直连 URL 使用
	const ip = loggedIn && Array.isArray(json.Self?.TailscaleIPs) ? (json.Self.TailscaleIPs.find((item) => item.includes(".")) ?? "") : "";
	const rawDns = typeof json.Self?.DNSName === "string" ? json.Self.DNSName : "";
	return { loggedIn, backendState, ip, dnsName: rawDns.replace(/\.$/, "") };
}

/**
 * 判断 serve 状态 JSON 是否已把 443 入口指向本应用端口。
 * serve status 的形状随版本有差异（TLS/HTTPS 树、嵌套 mount），用「全文包含目标回源地址」
 * 做宽松判定，避免绑定某一版本的内部结构。
 */
export function serveStatusTargetsPort(statusText: string, port: number): boolean {
	if (!statusText.trim()) return false;
	try {
		const parsed = JSON.parse(statusText);
		return JSON.stringify(parsed).includes(`127.0.0.1:${port}`);
	} catch {
		return false;
	}
}

/** serve 入口的完整 https 地址（不带尾斜杠、不带 token）。 */
export function buildTailscaleServeUrl(dnsName: string): string {
	return dnsName ? `https://${dnsName}` : "";
}

/** 默认命令执行器：execFile 走数组参数；Windows 下 tailscale CLI 需要接收 UAC 提权标记的变体不存在，普通 exec 即可。 */
function defaultCommandFn(binary: string): TailscaleCommandFn {
	return (args, options) =>
		execFileAsync(binary, args, {
			windowsHide: true,
			timeout: options?.timeoutMs ?? 15_000,
			maxBuffer: 1024 * 1024,
		});
}

/**
 * tailscale 渠道读取器：每次调用都是即时探测（无缓存），RemoteAccessManager 负责聚合与推送。
 * 所有方法都不抛异常——探测失败以 error 字段返回，UI 永远能拿到可渲染的状态。
 */
export class TailscaleAccessReader {
	private readonly command: TailscaleCommandFn;

	constructor(
		private readonly deps: {
			logger: AppLogger;
			binary?: string;
			commandFn?: TailscaleCommandFn;
		},
	) {
		this.command = deps.commandFn ?? defaultCommandFn(deps.binary ?? "tailscale");
	}

	async probeStatus(): Promise<{ loggedIn: boolean; backendState: string; ip: string; dnsName: string; error: string }> {
		try {
			const { stdout } = await this.command(["status", "--json"], { timeoutMs: 10_000 });
			const parsed = parseTailscaleStatus(JSON.parse(stdout) as TailscaleStatusJson);
			return { ...parsed, error: "" };
		} catch (error) {
			// 未登录/守护进程未启动时 CLI 以非零码退出，消息本身可读，直接透传
			const message = error instanceof Error ? error.message : String(error);
			this.deps.logger.warn("web-remote", "tailscale status probe failed", { error: message });
			return { loggedIn: false, backendState: "", ip: "", dnsName: "", error: message };
		}
	}

	/** 查询 443 serve 入口当前是否指向给定端口（读失败视为未指向）。 */
	async probeServe(port: number): Promise<boolean> {
		try {
			const { stdout } = await this.command(["serve", "status", "--json"], { timeoutMs: 10_000 });
			return serveStatusTargetsPort(stdout, port);
		} catch {
			return false;
		}
	}

	/**
	 * 启用 serve：把 https 入口指向 127.0.0.1:port。
	 * `--bg` 让 serve 在后台常驻（配置存进 tailscaled，与本应用生命周期解耦）。
	 */
	async startServe(port: number): Promise<void> {
		await this.command(["serve", "--bg", `http://127.0.0.1:${port}`], { timeoutMs: 20_000 });
	}

	/** 停用 serve（整机关闭；PiDeck 是这台机器上 serve 的唯一管理者这一简化假设记录在操作指南里）。 */
	async stopServe(): Promise<void> {
		await this.command(["serve", "off"], { timeoutMs: 10_000 });
	}
}

/** 供测试注入的 spawn 引用（避免模块顶层绑定 node:child_process 造成沙箱不可替换）。 */
export const tailscaleSpawnRef = { spawn };
