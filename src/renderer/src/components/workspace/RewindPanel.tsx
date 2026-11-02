import { History } from "lucide-react";
import { useAtomValue } from "jotai";
import { t } from "../../i18n";
import { currentSessionIdAtom } from "../../atoms/session-atoms";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { RewindCheckpointList } from "../session/RewindCheckpointList";

/**
 * 右侧抽屉「检查点」面板：展示当前会话在 refs/pi-checkpoints 下的文件快照，
 * 与底栏弹层共用 RewindCheckpointList（列表/diff/范围回退）。
 *
 * 能力边界：与底栏按钮同口径——仅 pi 后端（rewind 能力）展示列表；
 * dsh/imagegen 会话给出不支持提示；未打开会话给出引导空态。
 */
export function RewindPanel() {
	const sessionId = useAtomValue(currentSessionIdAtom);
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId ?? ""));
	const backend = sessionRecord?.backend;
	const unsupported = backend !== undefined && backend !== "pi";

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-semibold text-foreground">
				<History size={13} strokeWidth={1.8} aria-hidden="true" />
				{t("rewind.title")}
				<span className="ml-auto text-micro font-normal text-text-tertiary">{t("rewind.panelHint")}</span>
			</div>
			{/* scroll-ok: bounded —— 行由子组件 RewindCheckpointList 渲染，且列表是后端游标分页
			     （到顶后点「加载更多」追加），条数由点击增长；虚拟化要么把行数组提到父级、
			     要么把滚动窗下沉到子组件，都属跨组件重构，不在本批。 */}
			<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-2 pb-2">
				{!sessionId ? (
					<div className="px-1 py-2 text-xs leading-5 text-text-secondary">
						<p>{t("rewind.noSession")}</p>
						<p className="mt-0.5 text-text-tertiary">{t("rewind.noSessionHint")}</p>
					</div>
				) : unsupported ? (
					<p className="px-1 py-2 text-xs text-destructive">{t("rewind.unsupportedBackend")}</p>
				) : (
					<RewindCheckpointList sessionId={sessionId} />
				)}
			</div>
		</div>
	);
}
