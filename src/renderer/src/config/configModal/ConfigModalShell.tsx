import type { ReactNode } from "react";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import { Button } from "../../components/ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../../components/ui-shadcn/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import type { ConfigSection } from "./configModalStorage";

export type ConfigModalShellProps = {
	open: boolean;
	/** 关闭请求（含未保存确认，由内容层提供）。 */
	onRequestClose: () => void;
	/** 弹窗外框尺寸类（按窗口宽度给出）。 */
	sizeClass: string;
	saving: boolean;
	hasDirty: boolean;
	/** ssh 目标禁用本机保存/导出/导入：按钮置灰并说明原因。 */
	targetKind: PiConfigTarget["kind"];
	backendPane: "dsh" | "pi";
	section: ConfigSection;
	onSaveCurrent: () => void;
	onExport: () => void;
	onImport: () => void;
	children: ReactNode;
};

/**
 * 独立模式的外壳：Dialog + 标题栏（保存/导出/导入/关闭）+ 内容。
 * 嵌入模式（ConfigPane）不经过这里——宿主设置窗口自带标题栏，只渲染内容。
 */
export function ConfigModalShell({ open, onRequestClose, sizeClass, saving, hasDirty, targetKind, backendPane, section, onSaveCurrent, onExport, onImport, children }: ConfigModalShellProps) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onRequestClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", sizeClass, "config-modal")}>
				{/* 顶栏/侧栏控件与设置弹窗、会话顶栏统一到 sm / text-sm 密度 */}
				<DialogHeader className="flex-row items-center justify-between px-4 py-2.5">
					<DialogTitle className="text-sm font-semibold tracking-tight">{t("config.title")}</DialogTitle>
					<div className="flex items-center gap-1.5">
						{/* 顶部统一保存：各 tab 内部保存按钮可能被滚动藏住，这里常驻可见；
						    有未保存修改时按钮带黄点标记；无修改也放开再次保存，不再禁用 */}
						<Button variant="default" size="sm" onClick={onSaveCurrent} disabled={saving || targetKind === "ssh"} title={targetKind === "ssh" ? t("config.target.remoteSaveHint") : hasDirty ? t("config.dirtyTooltip") : undefined}>
							{hasDirty && <span className="size-2 rounded-full bg-warning" aria-hidden="true" />}
							{saving ? t("common.saving") : t("common.save")}
						</Button>
						{backendPane === "pi" && section === "config" ? (
							<>
								<Button variant="outline" size="sm" onClick={onExport} disabled={targetKind !== "local"} title={targetKind === "local" ? undefined : t("config.target.exportLocalOnly")}>
									{t("common.export")}
								</Button>
								{/* 导入与导出统一 outline 白底描边：与深色「保存」主按钮形成主次层级，避免并排按钮一描边一填充的不一致（对齐 SettingsModal 同款按钮组） */}
								<Button variant="outline" size="sm" onClick={onImport} disabled={targetKind !== "local"} title={targetKind === "local" ? undefined : t("config.target.exportLocalOnly")}>
									{t("common.import")}
								</Button>
							</>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("common.close")} title={t("common.close")}>
								<X size={16} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	);
}
