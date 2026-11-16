import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { TableCell, TableRow } from "../ui-shadcn/table";

/**
 * 「已归档」列表拉取失败的行（#538 尾项）。
 *
 * 为什么单独成组件：失败原先被 catch 成空数组，和「确实没有归档会话」长得一样，
 * 用户既看不出出错也没有重试入口；而 SessionManagerModal 所在文件已到行数红线。
 */
export function ManagerArchivedLoadErrorRow(props: { colSpan: number; onRetry: () => void }) {
	return (
		<TableRow>
			<TableCell colSpan={props.colSpan} className="py-6 text-center text-caption text-muted-foreground">
				{t("sessionManager.archivedLoadFailed")}{" "}
				<Button type="button" variant="link" className="h-auto p-0 text-caption" onClick={props.onRetry}>
					{t("common.retry")}
				</Button>
			</TableCell>
		</TableRow>
	);
}
