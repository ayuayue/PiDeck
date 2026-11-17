import { Loader2, RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import { remoteConfigErrorKey } from "../remoteConfigModel";
import { useConfigEditor } from "../useConfigEditorApi";
import { Button } from "../../components/ui-shadcn/button";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ui-shadcn/ConfirmDialog";
import { remotePiConfigCodeFromError } from "../../../../shared/piConfig";

/**
 * 加载态 / 错误提示：每个 TabsContent 顶部共用（Tabs 会卸载非激活内容，不能只挂一处）。
 * 同一 JSX element 可在多处渲染，不会造成重复副作用。
 */
export function ConfigStatusBlock({ loading, error, onReload, hasDrafts }: { loading: boolean; error: string | null; onReload?: () => void; hasDrafts?: boolean }) {
	const [confirm, setConfirm] = useState(false);
	const { remote } = useConfigEditor();
	const errorKey = error ? remoteConfigErrorKey(remotePiConfigCodeFromError(error)) : undefined;
	return (
		<>
			{loading && (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			)}
			{error && (
				<div role="alert" className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
					{errorKey ? t(errorKey) : error}
				</div>
			)}
			{remote && onReload && (
				<Button variant="outline" size="sm" className="mb-3 w-fit gap-1.5" disabled={loading} onClick={() => (hasDrafts ? setConfirm(true) : onReload())}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("remoteConfig.reload")}
				</Button>
			)}
			{confirm && (
				<ConfirmDialog
					title={t("remoteConfig.reloadTitle")}
					message={t("remoteConfig.reloadDrafts")}
					confirmLabel={t("remoteConfig.reload")}
					danger
					onConfirm={() => {
						setConfirm(false);
						onReload?.();
					}}
					onCancel={() => setConfirm(false)}
				/>
			)}
		</>
	);
}
