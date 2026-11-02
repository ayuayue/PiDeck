import { useCallback, useEffect, useState } from "react";
import { Download, FolderOpen, Pencil, RefreshCw, Upload } from "lucide-react";
import type { AgentMemoryBundlePeekOutcome, AgentMemoryStatus } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { AgentMemoryExportDialog } from "./AgentMemoryExportDialog";
import { AgentMemoryImportDialog } from "./AgentMemoryImportDialog";
import { describeAgentMemoryCode } from "./agentMemoryLabels";

/** 字节 → 人类可读（记忆量级在 KB~几十 KB，MB 只是兜底）。 */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

/**
 * 常用设置 →「智能体记忆」的状态区。
 *
 * 只读展示 + 三个动作（导出/导入/清空索引）。这三个动作的共同点是**都不改记忆内容语义**：
 * 导出与导入是搬运，清空索引是可重建的缓存（Markdown 真值不动），所以它们都不进 draft/保存流程，
 * 不像开关那样要等「保存设置」。
 *
 * 导出与导入都先弹二次确认（`AgentMemoryExportDialog` / `AgentMemoryImportDialog`）：
 * 记忆是跨机器共享的事实，搬运前让用户看一眼清单，比为「一键全量」省一次点击重要得多。
 *
 * 挂载时读一次、动作后重读：没有订阅——记忆变化的来源是 Agent 会话，设置页开着时它也可能在写，
 * 但设置页不是仪表盘，用户对「刚才那一秒的条目数」没有需求，少一条长连订阅。
 */
export function AgentMemorySettingsSection(props: {
	/** 兄弟面板（条目列表）改过记忆后 +1，让体积/索引统计一起重读。 */
	reloadKey?: number;
	/** 本面板的动作改过记忆后通知兄弟面板刷新。 */
	onChanged?: () => void;
	/** 自动学习开关：开着才显示「上次学习」行——关着时没学过是常态，显示只会让人困惑。 */
	showLearn?: boolean;
}) {
	const [status, setStatus] = useState<AgentMemoryStatus | null>(null);
	const [busy, setBusy] = useState<"none" | "preview" | "clear">("none");
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const [exportOpen, setExportOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const [importPreview, setImportPreview] = useState<Extract<AgentMemoryBundlePeekOutcome, { canceled: false }> | null>(null);

	const refresh = useCallback(async () => {
		const result = await desktopApi.agentMemory.status();
		if (result.ok) setStatus(result.value);
		else setError(describeAgentMemoryCode(result.code));
	}, []);
	// 依赖 props.reloadKey：条目列表删完一条后体积/条目数要跟着变。
	useEffect(() => {
		if (props.reloadKey === undefined) return;
		void refresh();
	}, [props.reloadKey, refresh]);

	useEffect(() => {
		void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, [refresh]);

	/** 导入：先选包并预览（只读），再让弹窗决定导入哪些条目。 */
	const runPreviewImport = async () => {
		setBusy("preview");
		setError(null);
		setMessage(null);
		try {
			const result = await desktopApi.agentMemory.previewBundle();
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else if (!result.value.canceled) setImportPreview(result.value);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy("none");
		}
	};

	const runReveal = async () => {
		const result = await desktopApi.agentMemory.revealRoot();
		if (!result.ok) setError(describeAgentMemoryCode(result.code));
	};

	const runClear = async () => {
		setConfirmClear(false);
		setBusy("clear");
		setError(null);
		setMessage(null);
		try {
			const result = await desktopApi.agentMemory.clearIndex();
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else setMessage(t("settings.agentMemoryClearDone", { count: String(result.value.removed) }));
		} finally {
			setBusy("none");
			void refresh();
			props.onChanged?.();
		}
	};

	const filesValue = status ? t("settings.agentMemorySummaryFiles", { size: formatBytes(status.totalBytes), count: String(status.files.reduce((sum, file) => sum + file.entries, 0)) }) : null;
	const indexValue = status ? (status.index ? t("settings.agentMemoryStatIndexValue", { sessions: String(status.index.sessions), messages: String(status.index.messages) }) : t("settings.agentMemoryIndexUnavailable")) : null;

	const learnSummary = status ? (status.learn.lastAt ? t("settings.agentMemoryLearnLast", { count: String(status.learn.sessions), time: new Date(status.learn.lastAt).toLocaleString() }) : t("settings.agentMemoryLearnNever")) : null;

	return (
		<>
			{/* 状态卡：信息在上、主操作在右、维护动作在底。
			    五个按钮挤进 SettingRow 的 260px 控件列会折成三行、右缘参差，所以这一块不再走两列栅格。 */}
			<div id="settings-section-memory-usage" className="flex flex-col gap-3 px-2 py-2">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<strong className="text-control font-medium text-foreground">{t("settings.agentMemoryUsage")}</strong>
						{props.showLearn && learnSummary ? <small className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">{learnSummary}</small> : null}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button type="button" variant="outline" size="sm" disabled={busy !== "none"} onClick={() => setExportOpen(true)}>
							<Download size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.agentMemoryExport")}
						</Button>
						<Button type="button" variant="outline" size="sm" disabled={busy !== "none"} onClick={() => void runPreviewImport()}>
							<Upload size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.agentMemoryImport")}
						</Button>
					</div>
				</div>

				{status ? (
					<dl className="grid gap-y-2 sm:grid-cols-3">
						<div className="min-w-0">
							<dt className="text-micro text-muted-foreground">{t("settings.agentMemoryStatFiles")}</dt>
							<dd className="mt-0.5 truncate text-control font-medium text-foreground tabular-nums">{filesValue}</dd>
						</div>
						<div className="min-w-0 sm:border-l sm:border-border-subtle/60 sm:pl-4">
							<dt className="text-micro text-muted-foreground">{t("settings.agentMemoryStatIndex")}</dt>
							<dd className="mt-0.5 truncate text-control font-medium text-foreground tabular-nums">{indexValue}</dd>
						</div>
						<div className="min-w-0 sm:border-l sm:border-border-subtle/60 sm:pl-4">
							<dt className="text-micro text-muted-foreground">{t("settings.agentMemoryStatDevice")}</dt>
							<dd className="mt-0.5 truncate text-control font-medium text-foreground" title={status.device.name}>
								{status.device.name}
							</dd>
						</div>
					</dl>
				) : (
					<p className="text-caption text-muted-foreground">{t("common.loading")}</p>
				)}

				{/* 维护动作：目录与改名是日常入口；清空索引只重建缓存（记忆文件不动），单独隔开降低误触。 */}
				<div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border-subtle/60 pt-2.5">
					<Button type="button" variant="ghost" size="sm" disabled={busy !== "none" || !status} onClick={() => void runReveal()}>
						<FolderOpen size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryOpenFolder")}
					</Button>
					<Button type="button" variant="ghost" size="sm" disabled={busy !== "none" || !status} onClick={() => setRenameOpen(true)}>
						<Pencil size={14} strokeWidth={2} aria-hidden="true" />
						{t("common.rename")}
					</Button>
					<span className="mx-1 h-4 w-px bg-border-subtle" aria-hidden="true" />
					<Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy !== "none" || !status?.index} onClick={() => setConfirmClear(true)}>
						<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryClearIndex")}
					</Button>
				</div>

				{status?.indexError ? <p className="text-caption text-muted-foreground">{t("settings.agentMemoryIndexDegraded", { reason: status.indexError })}</p> : null}
				{error ? <p className="text-caption text-destructive">{error}</p> : null}
				{message ? <p className="text-caption text-muted-foreground">{message}</p> : null}
			</div>
			{exportOpen ? (
				<AgentMemoryExportDialog
					onCancel={() => setExportOpen(false)}
					onError={(text) => {
						setExportOpen(false);
						setError(text);
					}}
					onExported={(entries) => {
						setExportOpen(false);
						setMessage(t("settings.agentMemoryExportDone", { count: String(entries) }));
						void refresh();
					}}
				/>
			) : null}
			{importPreview ? (
				<AgentMemoryImportDialog
					filePath={importPreview.filePath}
					preview={importPreview.preview}
					onCancel={() => setImportPreview(null)}
					onError={(text) => {
						setImportPreview(null);
						setError(text);
					}}
					onImported={(result) => {
						setImportPreview(null);
						setMessage(
							t("settings.agentMemoryImportDone", {
								device: result.device || t("settings.agentMemoryUnknownDevice"),
								added: String(result.added),
								duplicate: String(result.duplicate),
								tombstoned: String(result.tombstoned),
								replaced: String(result.replaced),
							}),
						);
						void refresh();
						props.onChanged?.();
					}}
				/>
			) : null}
			{confirmClear ? <ConfirmDialog title={t("settings.agentMemoryClearIndex")} message={t("settings.agentMemoryClearConfirm")} confirmLabel={t("settings.agentMemoryClearIndex")} danger onConfirm={() => void runClear()} onCancel={() => setConfirmClear(false)} /> : null}
			{renameOpen && status ? (
				<AgentDeviceRenameDialog
					current={status.device.name}
					onDone={(name) => {
						setRenameOpen(false);
						if (name) setMessage(t("settings.agentMemoryDeviceRenamed", { name }));
						void refresh();
					}}
					onCancel={() => setRenameOpen(false)}
					onError={setError}
				/>
			) : null}
		</>
	);
}

/**
 * 设备改名弹窗：设备 id 永不改变（设备记忆靠 id 落目录），这里只改显示名。
 * 空名按取消处理（sync 层会拒，这里在 UI 侧直接禁用保存更直观）。
 */
function AgentDeviceRenameDialog(props: { current: string; onDone: (name: string | null) => void; onCancel: () => void; onError: (text: string) => void }) {
	const [name, setName] = useState(props.current);
	const [busy, setBusy] = useState(false);
	const trimmed = name.trim();

	const runSave = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.agentMemory.renameDevice(trimmed);
			if (result.ok) props.onDone(result.value.name);
			else props.onError(describeAgentMemoryCode(result.code));
		} catch (cause) {
			props.onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onCancel();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settings.agentMemoryDeviceRenameTitle")}</DialogTitle>
				</DialogHeader>
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={60}
					autoFocus
					onKeyDown={(event) => {
						if (event.key === "Enter" && trimmed && !busy) void runSave();
					}}
				/>
				<DialogFooter>
					<Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
						{t("common.cancel")}
					</Button>
					<Button type="button" size="sm" disabled={!trimmed || busy || trimmed === props.current} onClick={() => void runSave()}>
						{t("common.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
