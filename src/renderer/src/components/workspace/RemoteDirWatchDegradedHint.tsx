import { AlertTriangle } from "lucide-react";
import type { ProjectDirectoryWatchDegradation } from "../../../../shared/types/projectFiles";
import { t } from "../../i18n";

/**
 * 深层目录 watch 降级提示（P0-4 可见性）。
 *
 * 订阅预算不够时目录仍能读，但不会实时刷新；不显示这条提示就等于把「没监听」呈现成「没变化」。
 * 文案必须给出覆盖数/缺口，让用户知道有多少目录需要手动刷新，不能只说「可能不实时」。
 */
export function RemoteDirWatchDegradedHint(props: { dirWatch: ProjectDirectoryWatchDegradation | null }) {
	if (props.dirWatch === null) return null;
	const { desired, covered, dropped, code } = props.dirWatch;
	return (
		<p data-testid="remote-file-tree-watch-degraded" className="flex items-start gap-1 px-2 py-1 text-label text-muted-foreground">
			<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			{/*
			 * 失败码来自 helper 的稳定码闭集（METHOD_NOT_FOUND / PERMISSION_DENIED …），是「为什么没监听」
			 * 的真实原因；只附在已有文案后，不新增 UI 术语。计数文案本身已经说明需要手动刷新。
			 */}
			<span>
				{t("project.remote.dirWatchDegraded", { desired, covered, dropped })}
				{code === undefined ? "" : ` (${code})`}
			</span>
		</p>
	);
}
