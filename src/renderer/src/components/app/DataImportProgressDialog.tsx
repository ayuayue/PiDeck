import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { formatBytes } from "../../../../shared/formatBytes";
import { dataEnvImportProgressAtom } from "../../atoms/dataEnvAtoms";
import { Button } from "../ui-shadcn/button";
import { Progress } from "../ui-shadcn/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";

type ImportDialogPhase = "preview" | "running" | "done" | "cancelled";

type DataImportProgressDialogProps = {
	open: boolean;
	/** 「跳过导入」：不导入直接继续（决策指针已写入；调用方负责重启落入独立目录）。 */
	onClose: () => void;
};

/** 导入完成到自动重启的缓冲：给用户读一句「即将重启」再退进程，避免像闪退。 */
const RESTART_DELAY_MS = 1500;

/**
 * 正式→dev 数据导入向导（规格 §6：仅首启、仅单向；进度事件经 dataEnvImportProgressAtom 驱动）。
 *
 * 状态机：preview（体积预估，可跳过/开始）→ running（进度条 + 当前项 + 取消）
 * → done（提示即将重启并自动 restart）/ cancelled（保留已复制内容，可再次导入）。
 * 复制过程不可经遮罩/Esc 打断，只能走「取消」按钮（保证 main 侧 busy 状态被显式收口）。
 */
export function DataImportProgressDialog(props: DataImportProgressDialogProps) {
	const [phase, setPhase] = useState<ImportDialogPhase>("preview");
	const [preview, setPreview] = useState<{ totalBytes: number } | null>(null);
	const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
	// 进度快照来自全局订阅（useDataEnvWatch）；终态推进前先清空快照（见 startImport），避免陈旧事件误触发。
	const progress = useAtomValue(dataEnvImportProgressAtom);
	const setImportProgress = useSetAtom(dataEnvImportProgressAtom);
	const restartTimer = useRef<number | null>(null);

	// 进入弹窗：拉体积预估并清掉上一次运行的陈旧进度；退出/卸载：清掉待触发的重启定时器。
	useEffect(() => {
		if (!props.open) return;
		setPhase("preview");
		setPreview(null);
		setErrorKey(null);
		setImportProgress(null);
		void desktopApi.dataEnv
			.getImportPreview()
			.then((result) => {
				// unavailable（如 stable 通道误入）不该出现在本流程，防御性给出不可用提示。
				if (!result.ok) {
					setErrorKey("dataMode.importUnavailable");
					return;
				}
				setPreview({ totalBytes: result.totalBytes });
			})
			.catch(() => setErrorKey("dataMode.importUnavailable"));
		return () => {
			if (restartTimer.current != null) window.clearTimeout(restartTimer.current);
		};
	}, [props.open, setImportProgress]);

	// running 态下消费进度事件的终态：done → 提示并自动重启；cancelled → 可再次导入；error → 回预览态提示。
	useEffect(() => {
		if (phase !== "running" || !progress) return;
		if (progress.phase === "done") {
			setPhase("done");
			restartTimer.current = window.setTimeout(() => void desktopApi.dataEnv.restart(), RESTART_DELAY_MS);
		} else if (progress.phase === "cancelled") {
			setPhase("cancelled");
		} else if (progress.phase === "error") {
			setPhase("preview");
			setErrorKey("dataMode.importError");
		}
	}, [phase, progress]);

	const startImport = () => {
		setErrorKey(null);
		// 先清空快照再进入 running：上一次运行的 done/cancelled 事件不能推进本次状态机，
		// 否则「取消后再次导入」会被旧 cancelled 事件立即弹回取消态。
		setImportProgress(null);
		setPhase("running");
		void desktopApi.dataEnv.importStart().then((result) => {
			// cancelled 由进度事件推进终态；busy/unavailable/failed 无进度事件，回预览态给错误提示。
			if (result.ok || result.error === "cancelled") return;
			setPhase((current) => (current === "running" ? "preview" : current));
			setErrorKey("dataMode.importError");
		});
	};

	const percent = progress && progress.totalBytes > 0 ? Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100)) : 0;

	return (
		<Dialog open={props.open}>
			<DialogContent
				className="sm:max-w-md"
				showCloseButton={false}
				// 一次性强制流程：复制中必须走「取消」收口，其余阶段走「跳过导入」。
				onInteractOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{t("dataMode.importSnapshot")}</DialogTitle>
					<DialogDescription>{t("dataMode.importSnapshotDesc")}</DialogDescription>
				</DialogHeader>

				{phase === "preview" && (
					<div className="space-y-1 text-caption text-muted-foreground">
						{preview ? <p>{t("dataMode.importPreviewSize", { size: formatBytes(preview.totalBytes) })}</p> : errorKey === null && <p>{t("dataMode.importEstimating")}</p>}
						{errorKey && <p className="text-destructive">{t(errorKey)}</p>}
					</div>
				)}

				{phase === "running" && (
					<div className="space-y-2">
						<div className="flex items-center justify-between text-caption text-muted-foreground">
							{/* 当前项名截断展示：长路径不挤占进度百分比 */}
							<span className="min-w-0 truncate">{progress?.currentItem ? t("dataMode.importCopying", { item: progress.currentItem }) : t("dataMode.importRunning")}</span>
							<span className="shrink-0">{percent}%</span>
						</div>
						<Progress value={percent} aria-label={t("dataMode.importSnapshot")} />
					</div>
				)}

				{phase === "done" && <p className="text-caption text-success">{t("dataMode.importDone")}</p>}

				{phase === "cancelled" && (
					<div className="space-y-1 text-caption">
						<p className="text-warning">{t("dataMode.importCancelled")}</p>
						{preview && <p className="text-muted-foreground">{t("dataMode.importPreviewSize", { size: formatBytes(preview.totalBytes) })}</p>}
					</div>
				)}

				<DialogFooter>
					{/* preview / cancelled 可跳过（不导入直接继续）；running 只能「取消」；done 等自动重启。 */}
					{(phase === "preview" || phase === "cancelled") && (
						<Button variant="ghost" size="sm" onClick={props.onClose}>
							{t("dataMode.importSkip")}
						</Button>
					)}
					{phase === "running" && (
						<Button variant="ghost" size="sm" onClick={() => void desktopApi.dataEnv.importCancel()}>
							{t("common.cancel")}
						</Button>
					)}
					{(phase === "preview" || phase === "cancelled") && (
						<Button size="sm" disabled={phase === "preview" && !preview} onClick={startImport}>
							{t("dataMode.importStart")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
