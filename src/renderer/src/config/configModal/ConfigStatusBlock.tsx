import { Loader2 } from "lucide-react";
import { t } from "../../i18n";

/**
 * 加载态 / 错误提示：每个 TabsContent 顶部共用（Tabs 会卸载非激活内容，不能只挂一处）。
 * 同一 JSX element 可在多处渲染，不会造成重复副作用。
 */
export function ConfigStatusBlock({ loading, error }: { loading: boolean; error: string | null }) {
	return (
		<>
			{loading && (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			)}
			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
		</>
	);
}
