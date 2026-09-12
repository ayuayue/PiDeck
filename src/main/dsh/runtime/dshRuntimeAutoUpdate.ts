/**
 * DSH runtime 启动期自动更新（打包态）。
 *
 * 背景：runtime manifest 的 maxAppVersion 常为空 = 对任何 app 版本都「兼容」，
 * resolveActive 会一直选中旧版。版本不一致时状态服务判 outdated 并硬门控 host
 * 启动，但重装此前仍需用户手动点「重新安装」。本模块把「升级 PiDeck 后首次
 * 启动」变成零操作：检测到 outdated → 走与手动重装完全相同的 installFromIndex
 * 链路（随包资源优先本地解压，其次在线索引下载）→ 成功后回收旧版本目录。
 *
 * 边界（有意不做的事）：
 * - notInstalled / broken 不自动装：用户没选过 DSH 就静默下载大体积 runtime
 *   属于越界行为，保持安装引导卡（已展示声明配套版本）由用户决定。
 * - dev 模式跳过：项目 node_modules 就是声明配套版本，不存在「旧 runtime」，
 *   且 dev 本就禁止在线下载（与 installEnabled 的语义一致）。
 * - 回收失败不回滚：旧目录删不掉只影响磁盘占用，不影响新 runtime 启用；
 *   逐个 best-effort 删除，失败记录后继续。
 */
import {
	collectRecyclableRuntimes,
	type InstalledDshRuntime,
} from "../../../shared/types/dshRuntimeManifest";
import type { DshRuntimeStatus } from "../../../shared/types/dshRuntime";

export type DshRuntimeAutoUpdateDeps = {
	/** 当前安装态快照（只读，不做缓存假设）。 */
	getStatus: () => DshRuntimeStatus;
	/** 安装完成后重探测并广播（与手动安装后的 refresh 同源）。 */
	refresh: () => DshRuntimeStatus;
	/** 安装编排（与手动「重装」按钮同一条链路）。 */
	install: () => Promise<{ ok: true } | { ok: false; error: string }>;
	/** 扫描已装版本（回收判定用）。 */
	listInstalled: () => InstalledDshRuntime[];
	/** 当前启用版本目录名（回收时保留）。 */
	resolveActiveDirName: () => string | undefined;
	/** 删除指定版本目录（失败抛错，由本模块捕获后继续）。 */
	uninstall: (dirName: string) => Promise<void>;
	/** 当前 app 版本（回收判定的兼容区间输入）。 */
	appVersion: () => string;
	/** 是否打包态；dev 直接跳过。 */
	isPackaged: () => boolean;
	/** 安装成功且状态刷新为 installed 后回调（装配层用它补拉 host 预热）。 */
	onRuntimeReady?: () => void;
	log: (scope: string, message: string, detail?: unknown) => void;
};

export type DshRuntimeAutoUpdateResult =
	| { action: "skipped"; reason: "not-packaged" | "state-not-outdated" }
	| { action: "install-failed"; error: string }
	| { action: "updated"; runtimeVersion?: string; pruned: string[]; pruneErrors: Array<{ dirName: string; error: string }> };

/** 提取错误文案（与 DshRuntimeManager 同款实现：跨 realm 下 instanceof 不可靠）。 */
function errorMessage(error: unknown): string {
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(error);
}

/**
 * 检测并自动更新不配套的 DSH runtime。幂等：state 不是 outdated 时直接跳过，
 * 装配层可以放心在每次启动调用（fire-and-forget）。
 */
export async function autoUpdateDshRuntimeIfOutdated(
	deps: DshRuntimeAutoUpdateDeps,
): Promise<DshRuntimeAutoUpdateResult> {
	// dev：项目 node_modules 即声明版本，且 dev 禁止在线下载。
	if (!deps.isPackaged()) {
		return { action: "skipped", reason: "not-packaged" };
	}
	const status = deps.getStatus();
	// 只处理 outdated（已装但与声明版本不一致）。notInstalled / broken 保持
	// 安装引导，不静默替用户做安装决定。
	if (status.state !== "outdated") {
		return { action: "skipped", reason: "state-not-outdated" };
	}
	deps.log("dsh-runtime", "runtime version mismatch detected, auto-update started", {
		installed: status.runtimeVersion,
		declared: status.declaredRuntimeVersion,
	});

	const install = await deps.install();
	if (!install.ok) {
		deps.log("dsh-runtime", "runtime auto-update install failed", { error: install.error });
		return { action: "install-failed", error: install.error };
	}

	// 安装成功后重探测：active 应切到新版本、状态回 installed 并广播给渲染层。
	const next = deps.refresh();
	if (next.state !== "installed") {
		// 理论不可达（install ok 但探测仍不可用），保守按失败上报，不做回收。
		const error = `state after install is ${next.state}`;
		deps.log("dsh-runtime", "runtime auto-update post-install probe failed", { state: next.state });
		return { action: "install-failed", error };
	}
	deps.log("dsh-runtime", "runtime auto-update installed", {
		runtimeVersion: next.runtimeVersion,
	});

	// 回收旧版本：保留当前启用目录，其余兼容版本均可删（collectRecyclableRuntimes
	// 与手动卸载后的回收判定同一条规则）。best-effort：单个目录删除失败（占用/
	// 杀软锁句柄）只记录，不阻断其余目录与就绪回调。
	const pruned: string[] = [];
	const pruneErrors: Array<{ dirName: string; error: string }> = [];
	const activeDirName = deps.resolveActiveDirName();
	const recyclable = collectRecyclableRuntimes(deps.listInstalled(), deps.appVersion(), activeDirName);
	for (const dirName of recyclable) {
		try {
			await deps.uninstall(dirName);
			pruned.push(dirName);
		} catch (error) {
			pruneErrors.push({ dirName, error: errorMessage(error) });
		}
	}
	if (pruneErrors.length > 0) {
		deps.log("dsh-runtime", "runtime auto-update prune had failures", { pruneErrors });
	}

	deps.onRuntimeReady?.();
	return { action: "updated", runtimeVersion: next.runtimeVersion, pruned, pruneErrors };
}
