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
	const [payload, setPayload] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const handleGenerate = async () => {
		const selected: Record<string, ProviderConfig> = {};
		for (const id of props.providerIds) {
			const provider = props.providers[id];
			if (provider) selected[id] = provider;
		}
		// password 留空 → undefined → 无密码信封（仅编码，不构成保护）
		setPayload(await encodeModelsTransfer(selected, password.trim() || undefined));
		setNotice(null);
	};

	const handleCopy = async () => {
		if (!payload) return;
		await copyTextWithCopiedNotice(payload);
		setNotice(t("config.models.transfer.copied"));
	};

	const handleSaveFile = () => {
		if (!payload) return;
		// 与既有 ConfigModal.handleExport 相同的浏览器下载模式，不走 IPC
		const blob = new Blob([payload], { type: "text/plain" });
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
				<p className="text-sm text-text-secondary">
					{t("config.models.transfer.selectedProviders", { count: props.providerIds.length })}
				</p>
				{!payload && (
					<div className="mt-4 space-y-2">
						<Label htmlFor="models-export-password">{t("config.models.transfer.password")}</Label>
						<Input
							id="models-export-password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="new-password"
						/>
						<p className="text-xs text-text-secondary">{t("config.models.transfer.passwordHint")}</p>
						{!password.trim() && <p className="text-xs text-warning">{t("config.models.transfer.noEncryptHint")}</p>}
					</div>
				)}
				{notice && <p className="mt-4 text-sm text-info">{notice}</p>}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				{!payload ? (
					<Button size="sm" onClick={handleGenerate} disabled={props.providerIds.length === 0}>
						{t("config.models.transfer.exportButton")}
					</Button>
				) : (
					<>
						<Button variant="outline" size="sm" onClick={handleCopy}>
							{t("config.models.transfer.copyBase64")}
						</Button>
						<Button variant="outline" size="sm" onClick={handleSaveFile}>
							{t("config.models.transfer.saveFile")}
						</Button>
					</>
				)}
			</div>
		</div>
	);
}