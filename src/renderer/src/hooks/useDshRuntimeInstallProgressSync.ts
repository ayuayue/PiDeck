/**
 * DSH runtime 安装进度同步（App 挂载一份）。
 *
 * 订阅 dsh-runtime:install-progress 推送写入 dshInstallProgressAtom，其余组件
 * （DshRuntimeSection）只读 atom——切配置分页/关弹窗都不会丢进度（订阅常驻 App，
 * 不随 DshRuntimeSection 卸载）。
 *
 * 完成/失败在此统一弹全局 toast：安装往往在「设置弹窗」里发起，用户可能已切回主
 * 窗口，进度条看不见，只有 toast 能告知结果。
 */
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { dshInstallProgressAtom } from "../atoms/dsh-atoms";
import type { DshRuntimeInstallPhase } from "../../../shared/types/dshRuntime";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

export function useDshRuntimeInstallProgressSync(): void {
	const setProgress = useSetAtom(dshInstallProgressAtom);
	// 上一帧 phase：只在「进入 done/error」时弹一次 toast，避免重复推送刷屏。
	const prevPhaseRef = useRef<DshRuntimeInstallPhase | null>(null);

	useEffect(() => {
		return desktopApi.sessions.onDshRuntimeInstallProgress((progress) => {
			setProgress({
				phase: progress.phase,
				percent: progress.percent,
				error: progress.error,
			});
			if (progress.phase === prevPhaseRef.current) return;
			prevPhaseRef.current = progress.phase;
			if (progress.phase === "done") {
				showNotice(t("dsh.runtime.installed"), 4000);
			} else if (progress.phase === "error" && progress.error !== "cancelled") {
				showNotice(t("dsh.runtime.installFailed", { error: progress.error ?? "" }), 6000, "error");
			}
		});
	}, [setProgress]);
}
