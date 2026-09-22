import { useState } from "react";
import { Settings2 } from "lucide-react";
import { MAX_QUICK_MESSAGES } from "../../../../../shared/quickMessages";
import { useQuickMessages } from "../../../hooks/useQuickMessages";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { QuickMessagesDialog } from "./QuickMessagesDialog";
import { SettingRow } from "./SettingRows";

/** 设置行里预览的条目数：只让人确认「清单是我要的那份」，不试图在设置页铺开全部条目。 */
const PREVIEW_COUNT = 3;

/**
 * 常用设置 →「快捷消息」入口行。
 *
 * 这里刻意只放**一行**：前 3 条预览 + 条数 + 「配置更多…」按钮，真正的编辑在弹框里
 * （QuickMessagesDialog）。原因是条目上限 30 条、出厂就有 16 条，把清单直接铺在设置页
 * 会把整页撑成一屏半，也让相邻设置项淹没在输入框中间。
 *
 * 数据仍然只有一份：配置文件 userData/quick-messages.json（主进程 QuickMessageStore）。
 * 本行只读预览（useQuickMessages 拿文件快照），编辑与写盘全在弹框里，二者共享同一个 atom，
 * 所以弹框里改完关掉，这一行的预览立刻是新的。
 */
export function QuickMessagesSetting() {
	const { items, loading } = useQuickMessages();
	const [dialogOpen, setDialogOpen] = useState(false);

	const preview = items.slice(0, PREVIEW_COUNT);
	const hasMore = items.length > preview.length;
	const previewText = items.length === 0 ? t("settings.quickMessagesPreviewEmpty") : `${preview.join(" · ")}${hasMore ? " …" : ""}`;

	return (
		<>
			<SettingRow anchor="common-quick-messages" title={t("settings.quickMessages")} description={loading ? t("settings.quickMessagesLoading") : previewText}>
				<span className="flex items-center gap-2">
					{/* 条数单独显示：预览截断了，得有个地方看得出「一共有多少条」 */}
					{loading ? null : <span className="text-caption text-muted-foreground tabular-nums">{t("app.quickMessagesCount", { count: String(items.length) })}</span>}
					<Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
						<Settings2 size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.quickMessagesConfigure")}
					</Button>
				</span>
			</SettingRow>
			{/* 弹框挂在入口行上：打开时它自己读文件，关掉后预览从同一个 atom 刷新 */}
			<QuickMessagesDialog open={dialogOpen} onOpenChange={setDialogOpen} />
		</>
	);
}
