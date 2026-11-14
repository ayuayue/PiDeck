import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CodeMirrorEditor } from "../../components/app/CodeMirrorEditor";
import { Button } from "../../components/ui-shadcn/button";
import { ConfirmDialog } from "../../components/ui-shadcn/ConfirmDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui-shadcn/select";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import type { DshSectionApi } from "../dshSchema";

/** 配置目录 + 文件名 → 平台路径（F9：统一拼接，避免散落的 replace 兜底）。 */
function joinConfigPath(homeDir: string, fileName: string): string {
	return `${homeDir.replace(/[\\/]+$/, "")}/${fileName}`;
}

const RAW_FILES = ["settings.yaml", ".credentials.yaml"];

/** 源文件 tab：与 Pi 管理 RawTab 同款——顶部文件下拉 + 编辑器。
 *  保存语义与 Pi 管理页一致：草稿变化上报脏状态，顶部统一保存提交。 */
export function DshConfigRawTab(props: { homeDir: string; sectionApi?: DshSectionApi; instanceKey?: string }) {
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const [fileName, setFileName] = useState(RAW_FILES[0]);
	const [content, setContent] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	/** 当前文件从磁盘读到的内容基准：编辑改回原文即算干净，避免只记「编辑过」造成假脏。 */
	const loadedContentRef = useRef("");
	/** 读失败状态：区分「文件不存在/读取失败」与「空文件」，给重试入口而不是空编辑器。 */
	const [readError, setReadError] = useState<string | null>(null);
	/** 待切换的文件名：当前文件有未保存草稿时先弹确认，确认丢弃后才真正切换。 */
	const [pendingFile, setPendingFile] = useState<string | null>(null);
	/** 读失败重试计数：自增触发重读 useEffect（与切换文件同一加载链路）。 */
	const [retryTick, setRetryTick] = useState(0);

	/** 切换源文件：有未保存草稿时先确认（丢弃草稿才能切），避免静默丢失编辑。 */
	const handleFileChange = useCallback(
		(next: string) => {
			if (next === fileName) return;
			if (dirty) {
				setPendingFile(next);
				return;
			}
			setFileName(next);
		},
		[dirty, fileName],
	);

	// 脏状态上报（顶部统一保存/关闭确认）
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：写当前文件；成功返回 true。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		try {
			const filePath = joinConfigPath(props.homeDir, fileName);
			await desktopApi.files.writeContent(filePath, content);
			// 保存成功：把基准推进到已写盘内容，后续再编辑改回它就自动变干净
			loadedContentRef.current = content;
			setDirty(false);
			return true;
		} catch (error) {
			console.error(`[dsh-config] write ${fileName} failed:`, error);
			showNotice(t("config.dsh.rawSaveFailed", { file: fileName, error: error instanceof Error ? error.message : String(error) }), 6000);
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, content, fileName, props.homeDir]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	// 切换文件/目录时重新加载
	useEffect(() => {
		if (!props.homeDir) return;
		let cancelled = false;
		setLoaded(false);
		setDirty(false);
		setReadError(null);
		const filePath = joinConfigPath(props.homeDir, fileName);
		// 读取带版本号：目录被外部切换（DSH_HOME 变更）后旧目录读失败不该污染新状态
		void desktopApi.files
			.readContent(filePath)
			.then((next) => {
				if (!cancelled) {
					setContent(next);
					loadedContentRef.current = next;
					setLoaded(true);
				}
			})
			.catch((error: unknown) => {
				// 读失败 ≠ 空文件：显示错误与重试入口，而不是空编辑器（空编辑器一保存就会把文件清空）
				if (!cancelled) {
					console.error(`[dsh-config] read ${fileName} failed:`, error);
					setReadError(error instanceof Error ? error.message : String(error));
					setLoaded(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [props.homeDir, fileName, retryTick]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex shrink-0 items-center gap-2">
				<Select value={fileName} onValueChange={handleFileChange}>
					<SelectTrigger size="sm" className="w-48 font-mono">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RAW_FILES.map((name) => (
							<SelectItem key={name} value={name} className="font-mono">
								{name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{dirty && <span className="size-2 rounded-full bg-warning" aria-hidden="true" />}
				{saving && <span className="text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>
			{loaded ? (
				readError ? (
					<div className="grid gap-2 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5" role="alert">
						<p className="text-control font-medium text-danger">{t("config.dsh.rawReadFailed", { file: fileName })}</p>
						{/* scroll-ok: transient —— 原始配置读失败的错误预览，max-h-32 封顶，重试成功即消失；错误文本通常几行，无需虚拟化 */}
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm border border-danger/20 bg-bg-panel/60 px-2.5 py-2 text-micro leading-relaxed text-danger/90">{readError}</pre>
						<div>
							<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => setRetryTick((tick) => tick + 1)}>
								<RefreshCw className="size-3.5" aria-hidden="true" />
								{t("config.dsh.retry")}
							</Button>
						</div>
					</div>
				) : (
					<CodeMirrorEditor
						value={content}
						language="yaml"
						height="100%"
						onChange={(value) => {
							setContent(value);
							// 改回磁盘原文即算干净：脏状态按内容对比，而不是「编辑过就脏」
							setDirty(value !== loadedContentRef.current);
						}}
					/>
				)
			) : (
				<div className="flex h-72 items-center justify-center gap-2 text-control text-muted-foreground">
					<LoaderCircle size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			)}
			{/* 切文件确认：当前文件有未保存草稿时，切换下拉会丢弃草稿，必须显式确认 */}
			{pendingFile && (
				<ConfirmDialog
					title={t("config.rawSwitchTitle")}
					message={t("config.rawSwitchMessage")}
					confirmLabel={t("config.rawSwitchConfirm")}
					danger
					onConfirm={() => {
						const next = pendingFile;
						setPendingFile(null);
						if (next) setFileName(next);
					}}
					onCancel={() => setPendingFile(null)}
				/>
			)}
			{/* 编辑位置说明：展示当前正在编辑的具体文件（随下拉切换），保存后由 DSH host 读取 */}
			<div className="flex shrink-0 flex-col gap-1 rounded-md border border-border-subtle bg-bg-panel px-3 py-2">
				<div className="flex items-baseline gap-1.5 text-micro text-muted-foreground">
					<span className="shrink-0">{t("config.dsh.rawEditingAt")}</span>
					<span className="min-w-0 truncate font-mono text-foreground/80" title={joinConfigPath(props.homeDir, fileName)}>
						{joinConfigPath(props.homeDir, fileName)}
					</span>
				</div>
				<span className="text-micro text-muted-foreground">{t("config.dsh.rawHostReads")}</span>
			</div>
		</div>
	);
}
