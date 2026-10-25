import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { ScrollArea } from "../../ui-shadcn/scroll-area";
import type { ConfigBackupDetail, ConfigBackupReason } from "../../../../../shared/types/backup";

/**
 * 配置备份的弹窗组件集：恢复选择（RestoreDialog）与脱敏查看（BackupDetailDialog）。
 * 与 SettingsBackupTab 分离，保证 tab 主体保持在单文件行数红线内；
 * 格式化函数供两处共用，避免循环依赖（formatter 只依赖 i18n，不依赖组件）。
 */

/** 恢复选择弹窗：列出备份包含的文件，默认全选；可只勾选需要恢复的单个/多个文件。 */
export function RestoreDialog(props: {
	detail: ConfigBackupDetail | null;
	open: boolean;
	/** 恢复进行中（弹窗内按钮 loading，阻止二次提交）。 */
	restoring?: boolean;
	onOpenChange: (open: boolean) => void;
	onRestore: (files: string[]) => void;
}) {
	const [selected, setSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		// 打开时默认全选（恢复全部是默认行为，取消勾选即退化为恢复单个）。
		if (props.open && props.detail) {
			setSelected(new Set(props.detail.files.map((file) => file.name)));
		}
	}, [props.open, props.detail]);

	const toggle = (name: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	const count = selected.size;

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{t("settings.backup.restoreTitle")}</DialogTitle>
					{props.detail && (
						<DialogDescription>
							{formatTime(props.detail.createdAt)} · {t("settings.backup.restoreSelectDesc")}
						</DialogDescription>
					)}
				</DialogHeader>
				{props.detail && (
					<div className="flex flex-col gap-1 py-1">
						{props.detail.files.map((file) => (
							<label key={file.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5">
								<Checkbox checked={selected.has(file.name)} onCheckedChange={() => toggle(file.name)} />
								<span className="font-mono text-xs">{file.name}</span>
							</label>
						))}
					</div>
				)}
				<div className="flex justify-end gap-2 pt-2">
					<Button variant="ghost" disabled={props.restoring} onClick={() => props.onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button disabled={count === 0 || props.restoring} loading={props.restoring} onClick={() => props.onRestore([...selected])}>
						{t("settings.backup.restoreSelected", { count })}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** 备份详情弹窗：展示脱敏后的文件内容，可按文件切换。 */
export function BackupDetailDialog(props: { detail: ConfigBackupDetail | null; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { detail } = props;
	const [activeFile, setActiveFile] = useState<string | null>(null);

	useEffect(() => {
		// 打开时默认选中第一个文件，关闭时清空选中。
		if (props.open && detail) {
			setActiveFile(detail.files[0]?.name ?? null);
		} else {
			setActiveFile(null);
		}
	}, [props.open, detail]);

	const file = detail?.files.find((entry) => entry.name === activeFile) ?? null;

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-h-[80vh] max-w-[720px] overflow-hidden">
				<DialogHeader>
					<DialogTitle>{t("settings.backup.detailTitle")}</DialogTitle>
					{detail && (
						<DialogDescription>
							{formatTime(detail.createdAt)} · {formatReason(detail.reason)}
						</DialogDescription>
					)}
				</DialogHeader>
				{detail && (
					<>
						<div className="flex flex-wrap gap-1.5 pb-2">
							{detail.files.map((entry) => (
								<button key={entry.name} className={`rounded-md px-2 py-1 text-xs transition-colors ${entry.name === activeFile ? "bg-foreground/10 font-medium" : "text-muted-foreground hover:bg-foreground/5"}`} onClick={() => setActiveFile(entry.name)}>
									{entry.name}
								</button>
							))}
						</div>
						{file && (
							<ScrollArea className="h-[50vh] rounded-md border border-border-subtle">
								<pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed">{file.raw}</pre>
							</ScrollArea>
						)}
						{file?.redacted && <p className="pt-2 text-caption text-muted-foreground">{t("settings.backup.redactedNotice")}</p>}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

export function formatReason(reason: ConfigBackupReason): string {
	switch (reason) {
		case "first-run":
			return t("settings.backup.reason.firstRun");
		case "upgrade":
			return t("settings.backup.reason.upgrade");
		case "on-save":
			return t("settings.backup.reason.onSave");
		case "pre-restore":
			return t("settings.backup.reason.preRestore");
		case "manual":
			return t("settings.backup.reason.manual");
		default:
			return reason;
	}
}

export function formatBytes(value: number): string {
	if (value === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
