import { useState } from "react";
import { Settings2 } from "lucide-react";
import { useReplyActions } from "../../../hooks/useReplyActions";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { ReplyActionsDialog } from "./ReplyActionsDialog";
import { SettingRow } from "./SettingRows";

/** 设置行里预览的规则条数：只让人确认「规则是我要的那份」，不试图在设置页铺开全部规则。 */
const PREVIEW_COUNT = 3;

/**
 * 常用设置 →「回复快捷操作」入口行。
 *
 * 与 QuickMessagesSetting 同一版式：前 3 条预览 + 条数 + 「配置更多…」，编辑在弹框里
 * （ReplyActionsDialog）。规则是结构化对象（文案 + 触发条件），预览只取文案，
 * 触发条件的增删在弹框里做——设置页塞不下二维结构。
 *
 * 数据只有一份：规则文件 userData/reply-actions.json（主进程 ReplyActionRuleStore）。
 * 本行只读预览，编辑与写盘全在弹框里，二者共享同一个 atom。
 */
export function ReplyActionsSetting() {
	const { items, loading } = useReplyActions();
	const [dialogOpen, setDialogOpen] = useState(false);

	const preview = items.slice(0, PREVIEW_COUNT);
	const hasMore = items.length > preview.length;
	const previewText = items.length === 0 ? t("settings.replyActionsPreviewEmpty") : `${preview.map((rule) => rule.text).join(" · ")}${hasMore ? " …" : ""}`;

	return (
		<>
			<SettingRow anchor="common-reply-actions" title={t("settings.replyActions")} description={loading ? t("settings.replyActionsLoading") : previewText}>
				<span className="flex items-center gap-2">
					{loading ? null : <span className="text-caption text-muted-foreground tabular-nums">{t("app.quickMessagesCount", { count: String(items.length) })}</span>}
					<Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
						<Settings2 size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.replyActionsConfigure")}
					</Button>
				</span>
			</SettingRow>
			{/* 弹框挂在入口行上：打开时它自己读文件，关掉后预览从同一个 atom 刷新 */}
			<ReplyActionsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
		</>
	);
}
