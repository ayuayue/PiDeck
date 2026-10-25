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
import { compareSemver, resolveDshRuntimeReleaseUrl, selectRelease, type DshRuntimeReleaseIndex } from "../../../shared/types/dshRuntimeManifest";
import type { DshRuntimeInstallProgress } from "../../../shared/types/dshRuntime";
import type { UpdateSourceId } from "../../../shared/types/settings";
import { existsSync, statSync } from "node:fs";
import type { BundledDshRuntime, DshRuntimeManager } from "./DshRuntimeManager";

/**
 * 「拿不到配套版本」的错误码前缀（后接 `required=<声明版本> available=<索引里的版本列表>`）。
 * 装配层按此前缀翻译成用户可读文案（main/index.ts 的 dshRuntimeErrorCopy），
 * 因此格式是契约：改动要同步 tests/dshRuntimeInstaller.test.mjs。
 */
export const DSH_RUNTIME_VERSION_UNAVAILABLE_PREFIX = "runtime version unavailable: ";

/** 拼配套版本缺失的错误码；available 是发布源/随包资源里实际存在的版本（逗号分隔）。 */
function versionUnavailableError(required: string, available: readonly string[]): string {
	return `${DSH_RUNTIME_VERSION_UNAVAILABLE_PREFIX}required=${required} available=${available.join(",")}`;
}

/** 拉取下载源索引（返回 null 表示拉不到/解析不了）。 */
export type DshRuntimeIndexFetcher = (url: string) => Promise<DshRuntimeReleaseIndex | null>;

export type DshRuntimeInstallerDeps = {
	manager: DshRuntimeManager;
	/** 下载源索引地址（settings 可覆盖为镜像）。 */
	indexUrl: () => string;
	/** 当前更新源：用于把索引里的归档文件名改写成 latest 资产 URL。 */
	updateSource?: () => UpdateSourceId;
	/** runtime 索引对应的应用 Release tag；省略时使用 latest。 */
	releaseTag?: () => string | undefined;
	appVersion: () => string;
	/**
	 * 本版本 app 配套的 dsh 版本（package.json 声明）。状态服务按它做硬门控，
	 * 所以安装必须精确命中：缺了这层比对，索引里只有旧版时 installer 会把旧版
	 * 判成「已装、跳过下载」并返回成功，UI 于是「点安装毫无反应」（2026-10 事故）。
	 * undefined = 调用方没给声明版本，退回旧的兼容区间择优（宁缺毋滥）。
	 */
	declaredVersion?: () => string | undefined;
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
	 * 安装与当前 app 配套的 runtime。
	 *
	 * 官方 dev/lite 路径不依赖 app 内部 node_modules：默认从与应用 Release 同源的索引
	 * 下载。只有显式 full/存量包注入 bundledRuntime 时才本地解压，作为离线与旧包兼容兜底。
	 * 挑版本以 package.json 声明的配套版本为准（见 deps.declaredVersion），没有配套版本
	 * 时直接失败——既不下载不相干的版本（避免下完才发现装不上，白耗几十 MB 流量），
	 * 也不把「已装的不配套版本」当成功返回。
	 */
	async installFromIndex(): Promise<DshRuntimeCommandResult> {
		const { deps } = this;
		const declared = deps.declaredVersion?.()?.trim() || undefined;
		const bundled = deps.bundledRuntime?.();
		if (bundled) {
			// 随包版本必须就是配套版本：装了不相等的版本，状态服务仍判 outdated，
			// 用户看到「安装成功但还是一张安装引导卡」。
			if (declared && compareSemver(bundled.manifest.runtimeVersion, declared) !== 0) {
				return this.fail(versionUnavailableError(declared, [bundled.manifest.runtimeVersion]));
			}
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
		const releases = index.releases ?? [];
		const release = selectRelease(releases, deps.appVersion(), declared);
		if (!release) {
			deps.log?.("dsh-runtime", "no compatible runtime release", { appVersion: deps.appVersion(), declared });
			// 区分两种「挑不到版本」：区间不兼容 vs 发布源里根本没有配套版本。
			// 后者是发版侧问题（app 已升 dsh 声明但 runtime 资产没发），必须报出来，
			// 不能退回「装兼容区间里的最新版」——那正是假成功的来源。
			if (declared && selectRelease(releases, deps.appVersion())) {
				return this.fail(
					versionUnavailableError(
						declared,
						releases.map((entry) => entry.runtimeVersion),
					),
				);
			}
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
		// 索引条目的 url 可能只是归档文件名占位；客户端按 updateSource 改写为
		// 当前 latest 应用 Release 资产。file:// / 本地路径保持原样（离线验证）。
		const archiveUrl = resolveDshRuntimeReleaseUrl(release, deps.updateSource?.() ?? "atomgit", process.platform, process.arch, deps.releaseTag?.());
		const result = await deps.manager.installFromUrl(archiveUrl, release.sha256, {
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
		const result = isDirectory ? await this.deps.manager.installFromDirectory(filePath) : await this.deps.manager.installFromArchive(filePath);
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

	private finish(result: { ok: true; dirName: string } | { ok: false; error: string }, runtimeVersion?: string): DshRuntimeCommandResult {
		if (result.ok) {
			this.deps.onProgress({ phase: "done", percent: 100, runtimeVersion });
			return { ok: true };
		}
		this.deps.onProgress({ phase: "error", percent: 100, runtimeVersion, error: result.error });
		return { ok: false, error: result.error };
	}
}
