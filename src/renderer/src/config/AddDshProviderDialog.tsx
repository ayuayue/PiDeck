import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { isValidProviderName } from "../../../shared/providerName";
import { credentialRefFor } from "../../../shared/dshCredentialRef";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { ProviderEndpointFields } from "./ProviderEndpointFields";
import { DshModelsEditor } from "./DshModelsEditor";
import type { DshModelRow } from "./DshModelsTable";
import { validateDshDeepseekModels } from "./dshModels";
import type { DshProviderDraft } from "./dshProviderDraft";

/** 与 Pi 同款页内草稿：填写连接信息 → 获取/添加模型 → 统一保存；DSH 差异就地说明。 */
export function AddDshProviderDialog(props: {
	existingNames: string[];
	directory?: Array<{ provider: string; displayName: string; active: boolean; declared?: boolean }>;
	settingsNs: string;
	writable: boolean;
	onRegisterSave: (save: (() => Promise<boolean>) | null) => void;
	onDirtyChange: (dirty: boolean) => void;
	onConfirm: (draft: DshProviderDraft) => Promise<boolean>;
	error: string | null;
	onBack: () => void;
}) {
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<DshModelRow[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trimmedName = name.trim();
	const nameValid = isValidProviderName(trimmedName);
	const duplicate = props.existingNames.includes(trimmedName);
	const directoryEntry = props.directory?.find((entry) => entry.provider === trimmedName);
	const catalogProvider = Boolean(directoryEntry && !directoryEntry.declared);
	const candidates = (props.directory ?? []).filter((entry) => !entry.active && !entry.declared && !props.existingNames.includes(entry.provider));
	const modelFailure = validateDshDeepseekModels(models.map((model) => ({ ...model, name: typeof model.name === "string" ? model.name.trim() || undefined : model.name })));
	const canSubmit = props.writable && nameValid && !duplicate && !modelFailure && (catalogProvider || (Boolean(baseUrl.trim()) && Boolean(api.trim()) && models.length > 0));
	const dirty = Boolean(name || baseUrl || apiKey || api !== "openai-completions" || models.length);

	useEffect(() => {
		props.onDirtyChange(dirty);
		return () => props.onDirtyChange(false);
	}, [dirty, props.onDirtyChange]);

	const submit = useCallback(async (): Promise<boolean> => {
		if (saving || !canSubmit) {
			if (!saving) setError(t("config.dsh.addProviderIncomplete"));
			return false;
		}
		setSaving(true);
		setError(null);
		try {
			return await props.onConfirm({ name: trimmedName, baseUrl, api, apiKey, models, catalogProvider });
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			return false;
		} finally {
			setSaving(false);
		}
	}, [saving, canSubmit, props.onConfirm, trimmedName, baseUrl, api, apiKey, models, catalogProvider]);

	useEffect(() => {
		props.onRegisterSave(submit);
		return () => props.onRegisterSave(null);
	}, [props.onRegisterSave, submit]);

	return (
		<div className="provider-add-page flex min-h-0 min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button type="button" variant="ghost" size="icon-sm" onClick={props.onBack} disabled={saving} aria-label={t("common.back")}>
					<ArrowLeft size={16} />
				</Button>
				<span className="text-control font-semibold">{t("config.addProviderDialogTitle")}</span>
			</div>
			<div className="grid min-w-0 gap-4 px-5 py-4">
				<div className="rounded-md border border-border-subtle bg-bg-subtle p-3 text-caption leading-relaxed text-muted-foreground">
					<p>{t("config.dsh.addProviderHint")}</p>
					<p className="mt-1 break-all">{t("config.dsh.providerCredentialHint", { ref: credentialRefFor(undefined, trimmedName || "provider") })}</p>
					<p className="mt-1">{catalogProvider ? t("config.dsh.catalogProviderHint") : t("config.dsh.customProviderHint")}</p>
				</div>
				<div className="config-provider-form grid min-w-0 gap-2.5">
					<fieldset disabled={saving || !props.writable} className="grid min-w-0 gap-2.5">
						<div className="config-provider-field items-start">
							<Label className="pt-1.5 text-xs">{t("config.addProviderName")}</Label>
							<div className="flex min-w-0 flex-col gap-1">
								<Input autoFocus value={name} aria-label={t("config.addProviderName")} placeholder={t("config.providerNamePlaceholder")} onChange={(event) => setName(event.target.value)} />
								{trimmedName && !nameValid && <span className="text-caption text-destructive">{t("config.providerNameRule")}</span>}
								{duplicate && <span className="text-caption text-destructive">{t("config.providerNameDuplicate")}</span>}
							</div>
						</div>
						{candidates.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5 text-caption">
								<span className="text-muted-foreground">{t("config.dsh.directoryLabel")}</span>
								{candidates.map((entry) => (
									<Button key={entry.provider} type="button" variant="outline" size="sm" className="h-6 px-2 text-micro" onClick={() => setName(entry.provider)}>
										{entry.displayName}
									</Button>
								))}
							</div>
						)}
						<ProviderEndpointFields baseUrl={baseUrl} api={api} apiKey={apiKey} onChangeBaseUrl={setBaseUrl} onChangeApi={setApi} onChangeApiKey={setApiKey} catalogProvider={catalogProvider} backend="dsh" />
					</fieldset>
				</div>
				<DshModelsEditor models={models} writable={props.writable && !saving} settingsNs={props.settingsNs} providerKey={trimmedName} baseURL={baseUrl} api={catalogProvider ? undefined : api} apiKeyDraft={apiKey} onChange={setModels} />
				{(error || props.error) && (
					<p role="alert" className="break-words text-caption text-destructive">
						{error || props.error}
					</p>
				)}
			</div>
			<div className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button type="button" variant="outline" size="sm" onClick={props.onBack} disabled={saving}>
					{t("common.back")}
				</Button>
				<Button type="button" size="sm" onClick={() => void submit()} disabled={saving || !canSubmit}>
					{saving ? t("common.saving") : t("config.addProviderConfirm")}
				</Button>
			</div>
		</div>
	);
}
