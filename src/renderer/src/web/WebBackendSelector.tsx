/**
 * WebBackendSelector — 会话后端选择器（Composer 工具行驻留，对齐桌面端能力）。
 *
 * 语义与桌面一致：后端（pi / dsh / 生图）仅在草稿期可切换——pi 会话文件与 DSH
 * session log 格式不同，会话激活（有 runtime）后锁定禁用；切换草稿会话后端时由
 * 父级同时清空跨后端的模型/思考偏好（见 UpdateSessionRecordInput.model 注释）。
 *
 * 交互：工具行文本 pill（与模型/思考 pill 同范式）→ WebBottomSheet 大触控行选择
 * （窄屏底部滑出 / 宽屏居中卡片，复用跨端基石组件）。
 */
import { useState } from "react";
import { Check, ChevronsUpDown, Image as ImageIcon, SquareTerminal } from "lucide-react";
import type { AgentBackend } from "../../../shared/types";
import { AgentPresetLogo } from "@/components/session/SessionSourceBadge";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebBottomSheet } from "./WebBottomSheet";

/** 后端选项元数据；label 里 Pi/DSH 是品牌名不本地化，生图走 i18n。 */
function backendOptions(): { value: AgentBackend; label: string; desc: string }[] {
	return [
		{ value: "pi", label: "Pi", desc: t("web.backendPiDesc") },
		{ value: "dsh", label: "DSH", desc: t("web.backendDshDesc") },
		{ value: "imagegen", label: t("web.backendImagegen"), desc: t("web.backendImagegenDesc") },
	];
}

/** 后端行首图标：pi=终端（本地编码助手）、dsh=官方预设 logo、生图=图片。 */
function BackendOptionMark(props: { backend: AgentBackend }) {
	if (props.backend === "dsh") return <AgentPresetLogo className="size-4" />;
	if (props.backend === "imagegen") return <ImageIcon className="size-4 text-violet-600 dark:text-violet-400" aria-hidden="true" />;
	return <SquareTerminal className="size-4" aria-hidden="true" />;
}

export function WebBackendSelector(props: { backend: AgentBackend /** 会话已激活（有 runtime）后锁定，禁用切换单元 */; locked: boolean; onChange: (backend: AgentBackend) => void }) {
	const [open, setOpen] = useState(false);
	const options = backendOptions();
	const label = options.find((option) => option.value === props.backend)?.label ?? "Pi";

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				disabled={props.locked}
				aria-label={t("session.backendPickerHint")}
				title={props.locked ? t("session.backendLockedHint") : t("session.backendPickerHint")}
				// 与模型/思考 pill 同范式：h-8 紧凑触控、双击误触低；禁用态保留可读性。shrink-0：工具行溢出时 pill 整体不压缩，交给横向滚动
				className="h-8 shrink-0 gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
				onClick={() => setOpen(true)}
			>
				<span className="min-w-0 truncate">{label}</span>
				<ChevronsUpDown className="size-3.5 shrink-0" aria-hidden="true" />
			</Button>
			<WebBottomSheet open={open} onOpenChange={setOpen} title={t("web.backendSheetTitle")}>
				{props.locked ? (
					// 锁定兜底文案（正常路径 pill 已禁用打不开；防御状态竞态，如 runtime 在弹层打开后启动）
					<p className="px-4 py-4 text-sm text-muted-foreground">{t("session.backendLockedNotice")}</p>
				) : (
					<div className="flex flex-col pb-2">
						{options.map((option) => {
							const selected = option.value === props.backend;
							return (
								<button
									type="button"
									key={option.value}
									aria-pressed={selected}
									className={cn(
										// h-12 大触控行（移动端拇指可达标准），选中态高亮左边框
										"flex h-12 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/60",
										selected && "bg-muted/40",
									)}
									onClick={() => {
										setOpen(false);
										if (!selected) props.onChange(option.value);
									}}
								>
									<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
										<BackendOptionMark backend={option.value} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium text-foreground">{option.label}</span>
										<span className="block truncate text-xs text-muted-foreground">{option.desc}</span>
									</span>
									{selected && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
								</button>
							);
						})}
					</div>
				)}
			</WebBottomSheet>
		</>
	);
}
