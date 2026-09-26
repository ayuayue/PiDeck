// src/main/update/ChannelSwitchService.ts —— 通道切换服务主干（规格 §3：查询 → 下载（进度/校验）→ 启动安装器并退出）。
// 保持 electron-free：网络 fetch / 临时目录 / 启动安装器 / 退出 / 渲染层推送全部经构造期依赖注入（ipcMain 适配在 channelSwitchIpc.ts，
// 装配在 main/index.ts registerIpc()）。退出清理用 QuitCleanupRegistry 登记（index.ts 装配时传入），避免 closeToTray 吞掉裸 quit 跳过清理。

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";
import { RELEASES_URL, UPDATE_REPO, UPDATE_REPO_OWNER } from "./releaseRepo";
import { inverseChannel, selectTargetRelease, toReleaseList } from "./releaseSelection";
import type { ChannelSwitchSnapshot, TargetChannelRelease, UpdateChannel } from "../../shared/types/app";

/** GitHub Releases API 地址：仓库坐标与 macManualUpdate（任务 7）同源于 releaseRepo.ts。 */
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;

/** 安装包临时目录名（固定在系统临时目录下；退出清理与 IPC 路径白名单共用此锚点）。 */
export const INSTALLER_TEMP_DIR = "channel-switch-installer";

/** 任意错误 → 可读消息（IPC 结构化错误复用）。 */
export function toChannelSwitchErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface ChannelSwitchServiceDeps {
	/** 当前构建通道（编译期固定）：查询目标 = inverseChannel(当前通道)。 */
	currentChannel: () => UpdateChannel;
	/** 网络出口：主进程注入 Electron net.fetch（保持本模块无 electron import，单测可桩）。 */
	netFetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
	/** 系统临时目录根（app.getPath("temp")）。 */
	getTempDir: () => string;
	/** 启动安装器（win 用 detached spawn，其余平台 shell.openPath；装配层决定）。 */
	spawnInstaller: (filePath: string) => void;
	/** 退出应用（装配层处理 isQuitting/closeToTray 先例）。 */
	quitApp: () => void;
	/** 快照广播（主窗口 webContents.send，装配层负责窗口存活判断）。 */
	sendToRenderer: (snapshot: ChannelSwitchSnapshot) => void;
	/** 退出清理登记（QuitCleanupRegistry.register）。 */
	registerQuitCleanup: (name: string, cleanup: () => void) => void;
}

export class ChannelSwitchService {
	private snapshot: ChannelSwitchSnapshot = { phase: "idle" };
	/** 下载单飞标志：downloading 期间拒绝并发 download/query（busy 守卫见两方法）。 */
	private downloading = false;

	constructor(private readonly deps: ChannelSwitchServiceDeps) {
		// 生命周期配对：临时安装包目录在退出路径清理（用户点安装器后才 launch，正常/异常退出都不留垃圾）。
		deps.registerQuitCleanup(INSTALLER_TEMP_DIR, () => {
			try {
				rmSync(this.getInstallerDir(), { recursive: true, force: true });
			} catch (error) {
				getAppLogger()?.warn("ChannelSwitchService", "清理频道切换安装包临时目录失败", toChannelSwitchErrorMessage(error));
			}
		});
	}

	/** 安装包落盘目录：<temp>/channel-switch-installer。 */
	getInstallerDir(): string {
		return join(this.deps.getTempDir(), INSTALLER_TEMP_DIR);
	}

	/** 当前切换状态快照（channelSwitch:get-status 数据源）。 */
	getStatus(): ChannelSwitchSnapshot {
		return this.snapshot;
	}

	/**
	 * 查询反向通道最新发行物（规格 §3：stable 构建查 dev 预发布，dev 构建查 stable 正式）。
	 * 无匹配 / 网络失败：推 error 快照（附 RELEASES_URL 手动下载退化入口）并向上抛结构化错误。
	 */
	async queryTargetChannelLatest(): Promise<TargetChannelRelease> {
		// downloading 期间拒绝 query：查询会推 querying/available 快照，覆盖渲染层正在消费的下载进度。
		// 并发裁决选 busy 而非「返回下载中状态」：query 契约是网络取最新，读进行中状态走 getStatus/onStateChanged。
		if (this.downloading) {
			throw new Error("busy");
		}
		this.push({ phase: "querying" });
		try {
			const response = await this.deps.netFetch(GITHUB_RELEASES_API, {
				headers: { "User-Agent": "PiDeck-ChannelSwitchService", Accept: "application/vnd.github+json" },
			});
			if (!response.ok) {
				throw new Error(`GitHub releases API ${response.status}`);
			}
			// 网络来的 JSON 不可信：text + JSON.parse 后交给 toReleaseList 归一，再按反向通道选择。
			const raw = await response.text();
			const target = inverseChannel(this.deps.currentChannel());
			const release = selectTargetRelease(toReleaseList(JSON.parse(raw)), target, process.platform, process.arch);
			if (!release) {
				throw new Error(`目标通道（${target}）暂无可安装发行物`);
			}
			this.push({ phase: "available", target: release });
			return release;
		} catch (error) {
			const message = toChannelSwitchErrorMessage(error);
			// 手动下载退化入口：错误里始终带发布页地址（用户可浏览器直下对应安装包）。
			this.push({ phase: "error", error: `${message} — 可到发布页手动下载：${RELEASES_URL}` });
			throw error;
		}
	}

	/**
	 * 下载安装包到临时目录（对外入口，含并发防护）：downloading 期间重复调用直接 busy。
	 * 两个并发下载对同一 filePath 各开 createWriteStream("w") 会交错写盘互损，
	 * digest 缺失时损坏安装包可经 ready→launch，单飞是数据完整性底线（busy 语义对齐 dataEnvImportStart）。
	 */
	async downloadInstaller(asset: TargetChannelRelease): Promise<string> {
		// busy 在任何 push 之前抛出：不写快照，进行中的下载进度不被 error 快照覆盖。
		if (this.downloading) {
			throw new Error("busy");
		}
		this.downloading = true;
		try {
			return await this.downloadInstallerLocked(asset);
		} finally {
			this.downloading = false;
		}
	}

	/**
	 * 实际下载流程（单飞前提下执行，标志由 downloadInstaller 维护）：流式写盘（读一块写一块，主进程不整包驻留内存），
	 * 进度百分比单调推送；完成后按 digestSha256（"sha256:hex"）校验，缺失则记日志跳过（规格 §3）。
	 * 返回安装包绝对路径；失败推 error 快照（保留 target）并抛错。
	 */
	private async downloadInstallerLocked(asset: TargetChannelRelease): Promise<string> {
		// 边界校验：文件名只取 basename（拒绝路径分隔/上跳），地址必须 https。
		const assetName = asset.assetName;
		if (typeof assetName !== "string" || assetName === "" || assetName.includes("/") || assetName.includes("\\") || assetName.includes("..")) {
			throw new Error(`非法安装包文件名：${String(assetName)}`);
		}
		if (typeof asset.assetUrl !== "string" || !asset.assetUrl.startsWith("https://")) {
			throw new Error(`非法下载地址：${String(asset.assetUrl)}`);
		}
		this.push({ phase: "downloading", target: asset, percent: 0 });
		try {
			mkdirSync(this.getInstallerDir(), { recursive: true });
			const response = await this.deps.netFetch(asset.assetUrl);
			if (!response.ok) {
				throw new Error(`安装包下载失败：HTTP ${response.status}`);
			}
			const body = response.body;
			if (!body) {
				throw new Error("安装包下载失败：响应无内容体");
			}
			const total = Number(response.headers.get("content-length") ?? "");
			const hash = createHash("sha256");
			const filePath = join(this.getInstallerDir(), assetName);
			const stream = createWriteStream(filePath);
			let received = 0;
			let lastPercent = 0;
			try {
				const reader = body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value) continue;
					hash.update(value);
					received += value.byteLength;
					// 背压处理：写缓冲满时等 drain，避免大安装包把主进程内存顶高。
					if (!stream.write(value)) {
						await once(stream, "drain");
					}
					if (Number.isFinite(total) && total > 0) {
						const percent = Math.min(99, Math.floor((received / total) * 100));
						if (percent > lastPercent) {
							lastPercent = percent;
							this.push({ phase: "downloading", target: asset, percent });
						}
					}
				}
				await new Promise<void>((resolveStream, rejectStream) => {
					stream.once("error", rejectStream);
					stream.end(() => resolveStream());
				});
			} finally {
				stream.destroy();
			}
			// 完整性校验：GitHub API 的 digest 形如 "sha256:hex"（可选字段）；缺失则记日志跳过（规格 §3）。能提取 hex 就比对，非 sha256 前缀报格式错。
			if (asset.digestSha256) {
				const digestHex = asset.digestSha256.trim().toLowerCase().startsWith("sha256:") ? asset.digestSha256.trim().toLowerCase().slice("sha256:".length) : null;
				if (digestHex === null) {
					throw new Error(`安装包 digest 格式无法识别：${asset.digestSha256}`);
				}
				const actual = hash.digest("hex");
				if (actual !== digestHex) {
					throw new Error(`安装包 digest mismatch：期望 ${digestHex}，实际 sha256:${actual}`);
				}
			} else {
				getAppLogger()?.info("ChannelSwitchService", "发行物未提供 digest，跳过完整性校验", assetName);
			}
			this.push({ phase: "ready", target: asset, percent: 100, installerPath: filePath });
			return filePath;
		} catch (error) {
			this.push({ phase: "error", target: asset, error: toChannelSwitchErrorMessage(error) });
			throw error;
		}
	}

	/** 启动安装器并退出应用（规格 §3：任务 7 的确认对话框负责发起前确认）。 */
	launchInstaller(filePath: string): void {
		this.deps.spawnInstaller(filePath);
		this.deps.quitApp();
	}

	/** 快照单写点：本地状态与渲染层广播始终一致。 */
	private push(next: ChannelSwitchSnapshot): void {
		this.snapshot = next;
		this.deps.sendToRenderer(next);
	}
}
