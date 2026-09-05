import { useEffect, useState } from "react";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG } from "../../../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionPublicConfig } from "../../../../../shared/types/voiceTranscription";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

const DEFAULT_CONFIG: VoiceTranscriptionPublicConfig = {
	...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
	hasApiKey: false,
};

/** Independent, main-owned transcription credentials and endpoint settings. */
export function VoiceTranscriptionSettingsSection() {
	const [config, setConfig] = useState<VoiceTranscriptionPublicConfig>(DEFAULT_CONFIG);
	const [apiKey, setApiKey] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let active = true;
		void desktopApi.voiceTranscription.getConfig()
			.then((next) => {
				if (active) setConfig(next);
			})
			.catch(() => {
				if (active) showNotice(t("voice.settings.loadFailed"), 4000);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const save = async (clearApiKey = false) => {
		if (saving) return;
		setSaving(true);
		try {
			const result = await desktopApi.voiceTranscription.saveConfig({
				baseUrl: config.baseUrl,
				model: config.model,
				language: config.language,
				...(!clearApiKey && apiKey.trim() ? { apiKey } : {}),
				...(clearApiKey ? { clearApiKey: true } : {}),
			});
			if (!result.ok) {
				showNotice(t(`voice.settings.error.${result.error}`), 4000);
				return;
			}
			setConfig(result.config);
			setApiKey("");
			showNotice(t(clearApiKey ? "voice.settings.keyCleared" : "voice.settings.saved"), 3000);
		} catch {
			showNotice(t("voice.settings.error.saveFailed"), 4000);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			title={t("voice.settings.title")}
			description={t("voice.settings.description")}
		>
			<SettingRow title={t("voice.settings.baseUrl")} alignEnd={false}>
				<Input
					value={config.baseUrl}
					disabled={loading || saving}
					onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))}
				/>
			</SettingRow>
			<SettingRow title={t("voice.settings.apiKey")} alignEnd={false}>
				<Input
					type="password"
					value={apiKey}
					disabled={loading || saving}
					placeholder={config.hasApiKey
						? t("voice.settings.apiKeyConfigured")
						: t("voice.settings.apiKeyMissing")}
					autoComplete="off"
					onChange={(event) => setApiKey(event.target.value)}
				/>
			</SettingRow>
			<SettingRow title={t("voice.settings.model")} alignEnd={false}>
				<Input
					value={config.model}
					disabled={loading || saving}
					onChange={(event) => setConfig((current) => ({ ...current, model: event.target.value }))}
				/>
			</SettingRow>
			<SettingRow
				title={t("voice.settings.language")}
				description={t("voice.settings.languageDescription")}
				alignEnd={false}
			>
				<Input
					value={config.language}
					disabled={loading || saving}
					placeholder={t("voice.settings.languagePlaceholder")}
					onChange={(event) => setConfig((current) => ({ ...current, language: event.target.value }))}
				/>
			</SettingRow>
			<SettingRow title={t("voice.settings.actions")}>
				<div className="flex items-center gap-2">
					{config.hasApiKey ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={loading || saving}
							onClick={() => void save(true)}
						>
							{t("voice.settings.clearKey")}
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						loading={saving}
						disabled={loading}
						onClick={() => void save(false)}
					>
						{t("voice.settings.save")}
					</Button>
				</div>
			</SettingRow>
		</SettingsSection>
	);
}
