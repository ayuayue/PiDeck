/**
 * WebComposer — Web 端消息输入区（与桌面 ComposerArea 的 composer-box 同风格）。
 *
 * 复用桌面 .composer / .composer-box 样式类 + shadcn Button：
 * - textarea 由 .composer textarea 统一样式（透明底、内边距、随内容撑高）
 * - Enter 发送、Shift/Ctrl+Enter 换行
 * - 两行工具区（DeepSeek 式）：操作行（后端/图片/提示词/计划模式 + 发送）在上，
 *   模型行（模型/思考选择器）驻留在底部
 * - 计划模式复用桌面 composerBehavior 的 buildComposerPromptSubmission：
 *   agentMessage 携带隐藏标记，由内置扩展 pi-deck-plan-mode 识别后切只读工具集；
 *   一次性提交流（发完自动回普通模式），斜线命令原样发送不受标记污染
 * - 图片附件：文件选择 + 粘贴，发送前经 webImageCompress 压缩（P2）
 * - 提示词库：内嵌 WebPromptPicker，选中后回填 draft（P2）
 * - prefill：重发（prepare-resend）/提示词插入时由父级填充文本，nonce 变化触发
 * - 无会话时禁用；流式期间提交按钮转为停止
 */
import { useEffect, useRef, useState } from "react";
import { ClipboardList, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import type { AgentBackend, AvailableModel, ComposerAgentMode, SessionModelPreference } from "../../../shared/types";
import { buildComposerPromptSubmission } from "../composerBehavior";
import { compressImageToDataUrl, imagesFromPasteEvent } from "./webImageCompress";
import { WebModelSelector } from "./WebModelSheet";
import { WebBackendSelector } from "./WebBackendSelector";
import { WebThinkingSelector } from "./WebThinkingSelector";
import { WebPromptPicker } from "./WebPromptPicker";

/** 单会话图片上限（压缩后每张约 100–300KB，4 张足够多数场景且 body 可控）。 */
const MAX_ATTACHED_IMAGES = 4;

export function WebComposer(props: {
	disabled: boolean;
	streaming: boolean;
	/** 第四批：后端选择驻留 composer（对齐桌面端后端切换，仅草稿期可切）。 */
	backend?: import("../../../shared/types").AgentBackend;
	backendLocked?: boolean;
	onBackendChange?: (backend: import("../../../shared/types").AgentBackend) => void;
	/** 第三批：模型/思考选择驻留 composer（从 WebHeader 迁入）。 */
	model?: SessionModelPreference;
	models: AvailableModel[];
	refreshingModels?: boolean;
	onRefreshModels?: () => void;
	onModelChange: (model: AvailableModel) => void;
	thinkingLevel?: string;
	onThinkingChange: (level: string) => void;
	/** 提交时携带的图片（data URL，已压缩）；父级在 onSend 后清空自己的附件态。 */
	onSend: (text: string, images: string[], agentMessage?: string) => void;
	onStop: () => void;
	/** 父级驱动的预填充（重发 / 提示词插入）；nonce 变化才生效，避免重复触发。 */
	prefill?: { text: string; nonce: number };
}) {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [attachError, setAttachError] = useState(false);
	// 计划模式：一次性提交流（对齐桌面 composer 语义），发送后自动回普通
	const [mode, setMode] = useState<ComposerAgentMode>("normal");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const lastPrefillNonce = useRef<number>(-1);

	useEffect(() => {
		const prefill = props.prefill;
		if (!prefill || prefill.nonce === lastPrefillNonce.current) return;
		lastPrefillNonce.current = prefill.nonce;
		setDraft(prefill.text);
		textareaRef.current?.focus();
	}, [props.prefill]);

	const addFiles = async (files: File[]) => {
		const picks = files.filter((file) => file.type.startsWith("image/")).slice(0, MAX_ATTACHED_IMAGES);
		if (picks.length === 0) return;
		setBusy(true);
		setAttachError(false);
		try {
			const encoded = await Promise.all(picks.map((file) => compressImageToDataUrl(file)));
			setImages((prev) => [...prev, ...encoded].slice(0, MAX_ATTACHED_IMAGES));
		} catch {
			setAttachError(true);
		} finally {
			setBusy(false);
		}
	};

	const submit = () => {
		const text = draft.trim();
		if ((!text && images.length === 0) || props.disabled || props.streaming || busy) return;
		// 复用桌面单一来源：plan 模式生成隐藏 agentMessage（标记+只读分析指令），
		// 用户可见消息保持原文；斜线命令原样发送不受标记污染
		const submission = buildComposerPromptSubmission(text, mode);
		props.onSend(text, images, submission.agentMessage);
		setDraft("");
		setImages([]);
		if (mode === "plan") setMode("normal");
	};

	return (
		<form
			className="composer w-full min-w-0 flex-col gap-2 bg-background px-3 pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="composer-box relative flex min-h-[7rem] min-w-0 flex-col overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,background-color]">
				{images.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{images.map((src, index) => (
							<span key={`${index}-${src.slice(-24)}`} className="relative inline-block size-14 overflow-hidden rounded-md border border-border">
								<img src={src} alt={t("web.messageImage")} className="size-full object-cover" />
								<button type="button" aria-label={t("web.removeImage")} className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground" onClick={() => setImages((prev) => prev.filter((_, position) => position !== index))}>
									<X className="size-3" aria-hidden="true" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					id="prompt"
					ref={textareaRef}
					/* legacy .composer textarea 带 height:100%（桌面横向布局遗留）：web 端纵列布局下会把工具行挤出，utilities 层覆盖为随内容自适应 */
					className="h-auto max-h-[40dvh] min-h-14"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={(event) => {
						const pasted = imagesFromPasteEvent(event.nativeEvent as ClipboardEvent);
						if (pasted.length > 0) {
							event.preventDefault();
							void addFiles(pasted);
						}
					}}
					placeholder={mode === "plan" ? t("app.composerPlanPlaceholder") : t("web.promptPlaceholder")}
					disabled={props.disabled}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
							event.preventDefault();
							submit();
						}
					}}
					aria-label={t("web.promptPlaceholder")}
				/>
				{attachError ? <div className="px-3 text-micro text-danger">{t("web.imageAttachFailed")}</div> : null}
				{/* 操作行：附件/提示词/计划模式等动作 + 发送按钮钉右（模型/思考选择器移到底部独立行，窄屏不挤） */}
				<div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 pt-2">
					<span className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={(event) => {
								const files = Array.from(event.target.files ?? []);
								void addFiles(files);
								event.target.value = "";
							}}
						/>
						{props.onBackendChange ? <WebBackendSelector backend={props.backend ?? "pi"} locked={Boolean(props.backendLocked)} onChange={props.onBackendChange} /> : null}
						<Button type="button" variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0 text-muted-foreground" disabled={props.disabled || busy || images.length >= MAX_ATTACHED_IMAGES} title={t("web.attachImage")} aria-label={t("web.attachImage")} onClick={() => fileInputRef.current?.click()}>
							<ImagePlus className="size-4" aria-hidden="true" />
						</Button>
						<WebPromptPicker disabled={props.disabled} onPick={(content) => setDraft((prev) => (prev ? `${prev}\n\n${content}` : content))} />
						{/* 计划模式切换（复用桌面「+」菜单里的模式项语义）：激活态高亮；一次性提交流，发送后自动回普通 */}
						<Button type="button" variant={mode === "plan" ? "default" : "ghost"} size="sm" className="h-8 shrink-0 gap-1 px-2" aria-pressed={mode === "plan"} disabled={props.disabled} title={t("app.composerModePlanDesc")} onClick={() => setMode((prev) => (prev === "plan" ? "normal" : "plan"))}>
							<ClipboardList className="size-4" aria-hidden="true" />
							<span className="text-caption">{t("app.composerModePlan")}</span>
						</Button>
					</span>
					{props.streaming ? (
						<Button type="button" variant="destructive" size="sm" className="h-8 shrink-0" onClick={props.onStop}>
							{t("app.stop")}
						</Button>
					) : (
						<Button type="submit" size="sm" className="h-8 shrink-0 whitespace-nowrap" disabled={props.disabled || busy || (!draft.trim() && images.length === 0)}>
							{t("app.send")}
						</Button>
					)}
				</div>
				{/* 模型行（底部驻留）：模型/思考选择器 + 状态提示（计划模式时提示只读分析语义） */}
				<div className="flex shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-2.5">
					{/* 模型+思考两个 pill 靠左成组，提示文案推到行尾两端对齐，避免整行挤在左侧留大片空白 */}
					<WebModelSelector model={props.model} models={props.models} refreshing={props.refreshingModels} onRefresh={props.onRefreshModels} onChange={props.onModelChange} />
					<WebThinkingSelector level={props.thinkingLevel} onChange={props.onThinkingChange} />
					<span className="composer-hint ml-auto hidden min-w-0 truncate text-caption text-muted-foreground sm:inline">{mode === "plan" ? t("app.composerPlanStatus") : t("web.composerHint")}</span>
				</div>
			</div>
		</form>
	);
}
