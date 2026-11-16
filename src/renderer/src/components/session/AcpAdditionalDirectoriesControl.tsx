/**
 * ACP 会话附加根目录（#560）。
 *
 * 附加目录是**会话创建参数**（ACP `session/new` / `session/load` 的
 * `additionalDirectories`，只在 agent 声明 `sessionCapabilities.additionalDirectories`
 * 时下发），不是 configOptions 选择器，所以这里用弹窗编辑一份完整列表，存进会话记录，
 * 由激活链路带进握手。
 *
 * 为什么放在底栏安全位（SecurityControl 的 ACP 分支）：这一格原本为空（ACP 权限走
 * agent 自己的 request_permission），而「agent 能访问哪些目录」与权限档同属会话的
 * 作用域设置，放在一起比塞进模型/模式那排配置控件更贴合语义。
 *
 * 生效时机：握手时才下发，改完必须重开会话；已经停止的会话下次启动自动带上。
 */
import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderPlus } from "lucide-react";
import { normalizeAcpAdditionalDirectories } from "../../../../shared/acpAdditionalDirectories";
import { sessionRecordByIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui-shadcn/dialog";
import { Textarea } from "../ui-shadcn/textarea";

export function AcpAdditionalDirectoriesControl(props: { sessionId: string; disabled?: boolean }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const upsertSession = useSetAtom(upsertSessionAtom);
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const current = record?.additionalDirectories ?? [];

	const openDialog = () => {
		setDraft(current.join("\n"));
		setOpen(true);
	};

	const save = () => {
		// 与主进程同一套归一化：只留绝对路径、去重、限量；空列表 = 清空（不沿用上次）。
		const next = normalizeAcpAdditionalDirectories(draft.split("\n"));
		void desktopApi.sessions
			.updateRecord(props.sessionId, { additionalDirectories: next ?? [] })
			.then((updated) => {
				upsertSession(updated);
				setOpen(false);
				showNotice(next ? t("acp.additionalDirectoriesSaved", { count: next.length }) : t("acp.additionalDirectoriesCleared"), 4000);
			})
			.catch((error) => showNotice(error instanceof Error ? error.message : String(error), 5000));
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? openDialog() : setOpen(false))}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="icon" className="relative shrink-0" disabled={props.disabled} title={current.length > 0 ? t("acp.additionalDirectoriesCount", { count: current.length }) : t("acp.additionalDirectoriesTitle")}>
					<FolderPlus className="h-4 w-4" />
					{current.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("acp.additionalDirectoriesTitle")}</DialogTitle>
					<DialogDescription>{t("acp.additionalDirectoriesDesc")}</DialogDescription>
				</DialogHeader>
				<Textarea rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="/path/to/shared-lib" />
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost">{t("common.cancel")}</Button>
					</DialogClose>
					<Button onClick={save}>{t("common.save")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
