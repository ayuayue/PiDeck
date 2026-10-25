import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { copyTextWithCopiedNotice } from "../utils/clipboardNotice";
import type { ProviderConfig } from "./configTypes";
import { encodeModelsTransfer } from "./modelsTransfer";

interface ModelsExportPanelProps {
	/** 批量选择模式下勾选的供应商 key */
	providerIds: string[];
	providers: Record<string, ProviderConfig>;
	onBack: () => void;
}

export function ModelsExportPanel(props: ModelsExportPanelProps) {
	const [password, setPassword] = useState("");
	const [notice, setNotice] = useState<string | null>(null);

	const buildSelectedProviders = () => {
		const selected: Record<string, ProviderConfig> = {};
		for (const id of props.providerIds) {
			const provider = props.providers[id];
			if (provider) selected[id] = provider;
		}
		return selected;
	};

	const exportToClipboard = async () => {
		const encoded = await encodeModelsTransfer(buildSelectedProviders(), password.trim() || undefined);
		await copyTextWithCopiedNotice(encoded);
		setNotice(t("config.models.transfer.copied"));
	};

	const exportToFile = async () => {
		const encoded = await encodeModelsTransfer(buildSelectedProviders(), password.trim() || undefined);
		// 与既有 ConfigModal.handleExport 相同的浏览器下载模式，不走 IPC
		const blob = new Blob([encoded], { type: "text/plain" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `pideck-models-${new Date().toISOString().slice(0, 10)}.txt`;
		a.click();
		URL.revokeObjectURL(a.href);
		setNotice(t("config.models.transfer.saved"));
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button variant="ghost" size="icon-sm" onClick={props.onBack}>
					<ArrowLeft size={16} />
				</Button>
				<span>{t("config.models.transfer.exportTitle")}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<p className="text-sm text-text-secondary">{t("config.models.transfer.selectedProviders", { count: props.providerIds.length })}</p>
				<div className="mt-4 space-y-2">
					<Label htmlFor="models-export-password">{t("config.models.transfer.password")}</Label>
					<Input
						id="models-export-password"
						type="password"
						value={password}
						onChange={(e) => {
							setPassword(e.target.value);
							setNotice(null);
						}}
						autoComplete="new-password"
					/>
					<p className="text-xs text-text-secondary">{t("config.models.transfer.passwordHint")}</p>
					{!password.trim() && <p className="text-xs text-warning">{t("config.models.transfer.noEncryptHint")}</p>}
				</div>
				{notice && <p className="mt-4 text-sm text-info">{notice}</p>}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button variant="outline" size="sm" disabled={props.providerIds.length === 0} onClick={() => void exportToClipboard()}>
					{t("config.models.transfer.exportToClipboard")}
				</Button>
				<Button variant="outline" size="sm" disabled={props.providerIds.length === 0} onClick={() => void exportToFile()}>
					{t("config.models.transfer.exportToFile")}
				</Button>
			</div>
		</div>
	);
}
