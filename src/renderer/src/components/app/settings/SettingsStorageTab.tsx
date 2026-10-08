import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { SectionHeading } from "../../ui-shadcn/section-heading";
import type { AppSettings } from "../../../../../shared/types";
import { SettingBox, SettingRow } from "./SettingRows";
import { LogViewer } from "./LogViewer";

/**
 * 设置分区：一级标题（加粗、text-body） + 二级内容。
 * - 默认二级内容入淡色框（boxed）；数据展示页（用量统计）传 boxed={false} 不套框；
 * - divided 用于「层次分明的页面」：与上一级之间用淡横线分隔。
 */
export function SettingsSection(props: {
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	/** 锚点 id：设置深链滚动用（如 Git 摘要「去设置」） */
	id?: string;
	/** 与上一级之间用淡横线分隔（代替默认的间距分组） */
	divided?: boolean;
	/** 二级内容是否入淡色框（默认 true；图表类内容传 false 直接铺开） */
	boxed?: boolean;
	/** 标题行右侧动作（如「全部展开」）：由分区统一排版，避免各页自己拼 flex 头部长出第二套视觉 */
	action?: ReactNode;
}) {
	const heading = <SectionHeading className="settings-section-header pb-2" titleClassName="text-body font-bold text-foreground" title={props.title} description={props.description} />;
	return (
		<section id={props.id} className={props.divided ? "mt-2 border-t border-border-subtle pt-4" : "mt-4 first:mt-0"}>
			{props.action != null ? (
				<div className="flex items-start justify-between gap-2">
					{heading}
					<div className="shrink-0">{props.action}</div>
				</div>
			) : (
				heading
			)}
			{props.children != null ? props.boxed === false ? <div className="px-0.5 pb-1">{props.children}</div> : <SettingBox>{props.children}</SettingBox> : null}
		</section>
	);
}
/** 存储管理子标签页 */
export function StorageTab(props: { settings: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
	const [logsSize, setLogsSize] = useState<string>("");
	const [rpcLogsSize, setRpcLogsSize] = useState<string>("");
	const [pasteFilesSize, setPasteFilesSize] = useState<string>("");
	const [noticeHistorySize, setNoticeHistorySize] = useState<string>("");
	const [clearing, setClearing] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const [confirmDialog, setConfirmDialog] = useState<{
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	/**
	 * 统一刷新四类占用统计（应用日志 / RPC 日志 / 粘贴文件 / 通知历史）：
	 * 被 5s 轮询与清理完成后共用，保证「清理后立刻看到新大小」。
	 */
	const refreshSizes = useCallback(() => {
		void window.piDesktop.logs.getSize().then((bytes) => setLogsSize(formatBytes(bytes)));
		void window.piDesktop.rpcLogs.getSize().then((bytes) => setRpcLogsSize(formatBytes(bytes)));
		void window.piDesktop.pasteFiles.getSize().then((bytes) => setPasteFilesSize(formatBytes(bytes)));
		void window.piDesktop.noticeHistory.getSize().then((bytes) => setNoticeHistorySize(formatBytes(bytes)));
	}, []);

	useEffect(() => {
		refreshSizes();
		const timer = setInterval(refreshSizes, 5000);
		return () => clearInterval(timer);
	}, [refreshSizes]);

	const doClear = async (target: string) => {
		setClearing(target);
		setFeedback("");
		try {
			if (target === "app") {
				await window.piDesktop.logs.clear();
			} else if (target === "rpc") {
				await window.piDesktop.rpcLogs.clear();
			} else if (target === "paste") {
				// 粘贴文件：清空 userData/paste-files 与各项目遗留的 .pideck-paste
				await window.piDesktop.pasteFiles.clearAll();
			} else if (target === "noticeHistory") {
				// 通知历史：清空内存数组并删除落盘文件
				await window.piDesktop.noticeHistory.clear();
			} else {
				await window.piDesktop.logs.clear();
				await window.piDesktop.rpcLogs.clear();
				await window.piDesktop.pasteFiles.clearAll();
				await window.piDesktop.noticeHistory.clear();
			}
			setFeedback(t("settings.storage.clearSuccess"));
		} catch (e) {
			setFeedback(`${t("common.error")}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setClearing(null);
			refreshSizes();
		}
	};

	const confirmClear = (target: string, label: string) => {
		setConfirmDialog({
			title: t("app.confirm"),
			message: t("settings.storage.clearConfirm", { label }),
			onConfirm: () => {
				doClear(target);
				setConfirmDialog(null);
			},
		});
	};

	/**
	 * 清理界面本地缓存（localStorage）。清空后内存态（宽度/折叠/过滤器等）
	 * 仍是旧值，必须整页刷新让所有状态从默认值重新初始化，否则界面与存储
	 * 不一致（下一次交互会把旧值写回，清理等于没清）。
	 */
	const doClearLocalStorage = () => {
		try {
			// 审计上报：清理 UI 缓存是用户主动操作，留痕便于排查"设置怎么变了"类问题
			window.piDesktop?.app
				.rendererLog("info", "renderer", "UI local cache cleared", {
					keyCount: localStorage.length,
				})
				.catch(() => undefined);
			localStorage.clear();
		} catch (e) {
			setFeedback(`${t("common.error")}: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		window.location.reload();
	};

	const confirmClearLocalStorage = () => {
		setConfirmDialog({
			title: t("app.confirm"),
			message: t("settings.storage.clearLocalStorageConfirm"),
			onConfirm: () => {
				setConfirmDialog(null);
				doClearLocalStorage();
			},
		});
	};

	const handleOpenFolder = async () => {
		try {
			await window.piDesktop.logs.openFolder();
		} catch (e) {
			setFeedback(`${t("common.error")}: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	return (
		<>
			{confirmDialog && (
				// #115：手写确认浮层删除，统一走 shadcn ConfirmDialog（AlertDialog）
				<ConfirmDialog title={confirmDialog.title} message={confirmDialog.message} danger onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />
			)}
			{/* 操作（清理全部）放最上面，日志相关内容依次下移 */}
			<SettingsSection title={t("settings.storage.actions")}>
				<SettingRow level={1} title={<span>{t("settings.storage.clearAll")}</span>} description={t("settings.storage.clearAllDesc")}>
					<Button variant="destructive" loading={clearing === "all"} disabled={clearing !== null} onClick={() => confirmClear("all", `${t("settings.storage.appLogs")} + ${t("settings.storage.rpcLogs")} + ${t("settings.storage.pasteFiles")} + ${t("settings.storage.noticeHistory")}`)}>
						{t("settings.storage.clearAllButton")}
					</Button>
				</SettingRow>
				{/* 界面本地缓存：纯 UI 偏好（布局宽度/折叠/排序等），无敏感数据；
				   与 settings.json（主进程权威设置）互不影响，清空后刷新页面生效 */}
				<SettingRow level={1} title={<span>{t("settings.storage.clearLocalStorage")}</span>} description={t("settings.storage.clearLocalStorageDesc")}>
					<Button variant="destructive" disabled={clearing !== null} onClick={confirmClearLocalStorage}>
						{t("settings.storage.clearLocalStorageButton")}
					</Button>
				</SettingRow>
			</SettingsSection>
			<SettingsSection title={t("settings.storage.rpcLogs")}>
				<div className="flex items-center justify-between gap-3 px-0.5 py-1.5">
					<span className="text-caption text-muted-foreground">
						{t("settings.storage.rpcLogsSize")}：
						{rpcLogsSize || (
							<span className="inline-flex items-center gap-1">
								<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
								{t("common.loading")}
							</span>
						)}
					</span>
					<Button variant="secondary" loading={clearing === "rpc" || clearing === "all"} disabled={clearing !== null} onClick={() => confirmClear("rpc", t("settings.storage.rpcLogs"))}>
						{t("common.delete")}
					</Button>
				</div>
			</SettingsSection>
			{/* 粘贴文件：输入框长文本自动转文件的落盘位置（userData/paste-files，另含各项目遗留 .pideck-paste） */}
			<SettingsSection title={t("settings.storage.pasteFiles")} description={t("settings.storage.pasteFilesDesc")}>
				<div className="flex items-center justify-between gap-3 px-0.5 py-1.5">
					<span className="text-caption text-muted-foreground">
						{t("settings.storage.pasteFilesSize")}：
						{pasteFilesSize || (
							<span className="inline-flex items-center gap-1">
								<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
								{t("common.loading")}
							</span>
						)}
					</span>
					<Button variant="secondary" loading={clearing === "paste" || clearing === "all"} disabled={clearing !== null} onClick={() => confirmClear("paste", t("settings.storage.pasteFiles"))}>
						{t("common.delete")}
					</Button>
				</div>
			</SettingsSection>
			{/* 通知历史：toast 落盘存档（userData/notice-history.json，重启后仍可在通知历史面板回看） */}
			<SettingsSection title={t("settings.storage.noticeHistory")} description={t("settings.storage.noticeHistoryDesc")}>
				<div className="flex items-center justify-between gap-3 px-0.5 py-1.5">
					<span className="text-caption text-muted-foreground">
						{t("settings.storage.noticeHistorySize")}：
						{noticeHistorySize || (
							<span className="inline-flex items-center gap-1">
								<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
								{t("common.loading")}
							</span>
						)}
					</span>
					<Button variant="secondary" loading={clearing === "noticeHistory" || clearing === "all"} disabled={clearing !== null} onClick={() => confirmClear("noticeHistory", t("settings.storage.noticeHistory"))}>
						{t("common.delete")}
					</Button>
				</div>
			</SettingsSection>
			{/* 应用日志（最底部）：管理行 + 查看器；不套淡色框，避免日志多时在刷新区形成多余框边 */}
			<SettingsSection title={t("settings.storage.appLogs")} boxed={false}>
				<div className="flex items-center justify-between gap-3 px-0.5 py-1.5">
					<span className="text-caption text-muted-foreground">
						{t("settings.storage.appLogsSize")}：
						{logsSize || (
							<span className="inline-flex items-center gap-1">
								<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
								{t("common.loading")}
							</span>
						)}
					</span>
					<div className="flex items-center gap-2">
						<Button variant="secondary" onClick={handleOpenFolder}>
							{t("common.open")}
						</Button>
						<Button variant="secondary" loading={clearing === "app" || clearing === "all"} disabled={clearing !== null} onClick={() => confirmClear("app", t("settings.storage.appLogs"))}>
							{t("common.delete")}
						</Button>
					</div>
				</div>
				<LogViewer />
			</SettingsSection>
			{feedback && (
				<div className="px-0.5 pb-1 pt-2">
					<small className={`setting-status ${feedback.includes(t("common.error")) ? "error" : "success"}`}>{feedback}</small>
				</div>
			)}
		</>
	);
}

function formatBytes(value: number) {
	if (value === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
