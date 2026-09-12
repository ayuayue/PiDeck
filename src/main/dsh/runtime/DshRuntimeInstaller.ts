/**
 * DSH runtime 安装编排（AgentRuntimeProvider 阶段 2）。
 *
 * 把「拿下载源索引 → 挑兼容版本 → 下载 → 校验 → 落位 → 广播进度」串成一条命令，
 * 供 IPC 直接调用。DshRuntimeManager 只管单个归档的落位，编排（选版本、进度换算、
 * 索引拉取）在这里，两边职责不重叠。
 *
 * 进度只有一个出口（onProgress），由 main/index.ts 决定怎么广播给渲染层——
 * 编排层不认识 BrowserWindow。
 */
import {
	selectRelease,
	type DshRuntimeReleaseIndex,
} from "../../../shared/types/dshRuntimeManifest";
import type { DshRuntimeInstallProgress } from "../../../shared/types/dshRuntime";
import { existsSync, statSync } from "node:fs";
import type { BundledDshRuntime, DshRuntimeManager } from "./DshRuntimeManager";

/** 拉取下载源索引（返回 null 表示拉不到/解析不了）。 */
export type DshRuntimeIndexFetcher = (
	url: string,
) => Promise<DshRuntimeReleaseIndex | null>;

export type DshRuntimeInstallerDeps = {
	manager: DshRuntimeManager;
	/** 下载源索引地址（settings 可覆盖为镜像）。 */
	indexUrl: () => string;
	appVersion: () => string;
	fetchIndex: DshRuntimeIndexFetcher;
	onProgress: (progress: DshRuntimeInstallProgress) => void;
	/**
	 * 随包 runtime（resources/dsh-runtime/）；undefined = 本次打包未附带。
	 * 存在且兼容时优先本地解压，跳过网络——见 installFromIndex 的说明。
	 */
	bundledRuntime?: () => BundledDshRuntime | undefined;
	log?: (scope: string, message: string, detail?: unknown) => void;
};

export type DshRuntimeCommandResult = { ok: true } | { ok: false; error: string };

/**
 * 提取错误文案。
 * 不用 `instanceof Error`：跨 realm（如 Node 测试用 vm 沙箱加载本模块）时该判定
 * 恒为 false，会退化成 "Error: xxx" 这种带类名前缀的脏文案。取 message 字段
 * 在两种环境下都得到干净的一手原因（与 DshRuntimeManager 同款实现）。
 */
function errorMessage(error: unknown): string {
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(error);
}

export class DshRuntimeInstaller {
	constructor(private readonly deps: DshRuntimeInstallerDeps) {}

	/**
	 * 安装与当前 app 兼容的 runtime。
	 *
	 * 优先用随包资源：它是打包时就放在 resources/ 里的同一份归档，本地解压即可，
	 * 不需要网络也不需要等下载。没有随包资源（lite 包）才走在线索引。
	 * 索引里没有兼容版本时不下载（避免下完才发现装不上，白耗几十 MB 流量）。
	 */
	async installFromIndex(): Promise<DshRuntimeCommandResult> {
		const { deps } = this;
		const bundled = deps.bundledRuntime?.();
		if (bundled) {
			// 已装且校验通过的同版本重装是纯浪费（下载几十 MB + 解压数万文件约两分钟）：
			// 直接成功返回。目录损坏/半残时 isVersionInstalled 为 false，正常走重装。
			if (deps.manager.isVersionInstalled?.(bundled.manifest.runtimeVersion)) {
				deps.log?.("dsh-runtime", "runtime already installed, skipping bundled install", {
					version: bundled.manifest.runtimeVersion,
				});
				return this.finish({ ok: true, dirName: bundled.manifest.runtimeVersion }, bundled.manifest.runtimeVersion);
			}
			deps.log?.("dsh-runtime", "installing from bundled runtime", {
				version: bundled.manifest.runtimeVersion,
			});
			deps.onProgress({
				phase: "extracting",
				percent: 10,
				runtimeVersion: bundled.manifest.runtimeVersion,
			});
			const result = await deps.manager.installFromArchive(bundled.archivePath, bundled.manifest.archiveSha256);
			return this.finish(result, bundled.manifest.runtimeVersion);
		}

		const indexUrl = deps.indexUrl();
		if (!indexUrl) {
			return this.fail("no runtime index url configured");
		}
		const index = await deps.fetchIndex(indexUrl);
		if (!index) return this.fail("runtime index unavailable");
		const release = selectRelease(index.releases ?? [], deps.appVersion());
		if (!release) {
			deps.log?.("dsh-runtime", "no compatible runtime release", { appVersion: deps.appVersion() });
			// 必须推送 error：UI 在发起安装时就切到了「下载中」，没有终止事件会一直转圈。
			return this.fail("no compatible runtime release");
		}
		// 与随包路径同一短路：目标版本已装且完整可用就不下载不落位。
		if (deps.manager.isVersionInstalled?.(release.runtimeVersion)) {
			deps.log?.("dsh-runtime", "runtime already installed, skipping download", {
				version: release.runtimeVersion,
			});
			return this.finish({ ok: true, dirName: release.runtimeVersion }, release.runtimeVersion);
		}

		deps.onProgress({ phase: "downloading", percent: 0, runtimeVersion: release.runtimeVersion });
		const result = await deps.manager.installFromUrl(release.url, release.sha256, {
			onPhase: (phase) => {
				// 各阶段的离散进度：只有 downloading 有真实字节占比（见 onDownloadProgress）。
				const percent = phase === "downloading" ? 0 : phase === "verifying" ? 75 : phase === "extracting" ? 85 : 95;
				deps.onProgress({ phase, percent, runtimeVersion: release.runtimeVersion });
			},
			onDownloadProgress: (received, total) => {
				// 下载阶段映射到 0-70%，给后续校验/解压留出力度感。
				const ratio = total && total > 0 ? received / total : 0;
				deps.onProgress({
					phase: "downloading",
					percent: Math.min(70, Math.round(ratio * 70)),
					runtimeVersion: release.runtimeVersion,
				});
			},
		});
		return this.finish(result, release.runtimeVersion);
	}

	/**
	 * 手动导入本地 runtime（离线/镜像不可达的兜底；路径由文件对话框给出）。
	 * 支持两种来源：.tgz 归档（走解压落位）与已解压的 runtime 目录（直接校验复制）。
	 */
	async installFromLocalFile(filePath: string): Promise<DshRuntimeCommandResult> {
		this.deps.onProgress({ phase: "verifying", percent: 0 });
		// 本地导入没有下载源索引，因此拿不到期望 sha256 —— 校验职责落在归档/目录内的
		// manifest（schema + 兼容区间 + 关键包齐全），足以挡住「拿错文件」。
		const isDirectory = existsSync(filePath) && statSync(filePath).isDirectory();
		const result = isDirectory
			? await this.deps.manager.installFromDirectory(filePath)
			: await this.deps.manager.installFromArchive(filePath);
		return this.finish(result, result.ok ? result.manifest.runtimeVersion : undefined);
	}

	/** 卸载当前启用的 runtime（卸载后状态服务会退回 notInstalled）。 */
	async uninstall(): Promise<DshRuntimeCommandResult> {
		const active = this.deps.manager.resolveActive();
		if (!active) return { ok: false, error: "no runtime installed" };
		try {
			await this.deps.manager.uninstall(active.dirName);
			return { ok: true };
		} catch (error) {
			// manager.uninstall 在重试耗尽（文件被持续占用，如 DSH host 未停、杀软锁句柄）
			// 后抛错；这里收口成结构化结果，IPC 边界不再裸抛异常，渲染层弹窗会显示
			// 友好错误而不是「未处理异常」。
			const message = errorMessage(error);
			this.deps.log?.("dsh-runtime", "runtime uninstall failed", {
				dirName: active.dirName,
				error: message,
			});
			return { ok: false, error: message };
		}
	}

	/** 失败出口：推送 error 进度（让 UI 收起进度条）再返回结果。 */
	private fail(error: string): DshRuntimeCommandResult {
		return this.finish({ ok: false, error });
	}

	private finish(
		result: { ok: true; dirName: string } | { ok: false; error: string },
		runtimeVersion?: string,
	): DshRuntimeCommandResult {
		if (result.ok) {
			this.deps.onProgress({ phase: "done", percent: 100, runtimeVersion });
			return { ok: true };
		}
		this.deps.onProgress({ phase: "error", percent: 100, runtimeVersion, error: result.error });
		return { ok: false, error: result.error };
	}
}
