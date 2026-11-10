import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, Save, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { PiConfigFileKey } from "../../../shared/piConfig";
import { CodeMirrorEditor } from "../components/app/CodeMirrorEditor";
import { Button } from "../components/ui-shadcn/button";
import { t, type TranslationKey } from "../i18n";
import { formatConfigDocument, parseMergePatchText, remoteConfigErrorKey, shortConfigDigest } from "./remoteConfigModel";
import { RemoteConfigDeferredOperations, RemoteConfigUnsupportedNotice } from "./RemoteConfigUnsupportedNotice";
import { RemoteModelCatalogSection } from "./RemoteModelCatalogSection";
import { useRemotePiConfigPanel } from "./useRemotePiConfigPanel";

/**
 * Dedicated remote models.json/settings.json panel (Batch B). It renders the sanitized snapshot only:
 * version/sha256 plus secret configured|missing badges, a read-only data pane, and an explicit merge-patch
 * editor. Writes always send the displayed version; a conflict keeps the draft and offers reload; an
 * unconfirmed write cannot be retried without an explicit reload. No local ConfigManager path is reachable
 * from this component.
 */
export function RemoteConfigPanel(props: { file: PiConfigFileKey; hostId: string; hostLabel?: string; onDirtyChange?: (dirty: boolean) => void }) {
	const { state, dirty, reload, save, setPatchText, resetPatch, connectionTone, connectCode } = useRemotePiConfigPanel({ hostId: props.hostId, file: props.file, onDirtyChange: props.onDirtyChange });
	const [patchSyntaxError, setPatchSyntaxError] = useState<TranslationKey | null>(null);
	const snapshot = state.snapshot;
	const loading = state.phase === "loading";
	// 自动连接的状态优先于「读请求还没回来」：第一屏要回答「正在连哪台主机」，而不是一个泛泛的加载中。
	const connecting = connectionTone === "connecting";
	const saving = state.phase === "saving";
	const unsupported = state.phase === "unsupported";
	const conflict = state.phase === "conflict";
	const unconfirmed = state.phase === "unconfirmed";
	const failed = state.phase === "failed";
	const errorKey = remoteConfigErrorKey(state.code);
	const parsedPatch = parseMergePatchText(state.patchText);
	const patchReason = parsedPatch.ok ? null : parsedPatch.reason;
	const patchIsEmpty = state.patchText.trim().length === 0;
	const canApply = !loading && !saving && !unconfirmed && dirty && parsedPatch.ok;
	const fileLabel = props.file === "models" ? "models.json" : "settings.json";
	const patchBorder = patchSyntaxError || (dirty && !parsedPatch.ok) ? "border-danger/40" : "border-border-subtle";

	const handlePatchChange = (text: string) => {
		setPatchSyntaxError(null);
		setPatchText(text);
	};
	const handleSave = async () => {
		if (!parsedPatch.ok) {
			setPatchSyntaxError(parsedPatch.reason === "syntax" ? "remoteConfig.patchSyntax" : parsedPatch.reason === "reserved-key" ? "remoteConfig.patchReservedKey" : "remoteConfig.patchNotObject");
			return;
		}
		await save();
	};

	return (
		<div className="config-remote-panel flex min-h-0 flex-1 flex-col gap-3" data-testid="remote-config-panel" data-phase={state.phase} data-file={props.file}>
			<div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="remote-config-header">
				<span className="text-control font-medium">{t("remoteConfig.title", { file: fileLabel })}</span>
				{props.hostLabel ? (
					<span className="truncate font-mono text-micro text-muted-foreground" data-testid="remote-config-host">
						{props.hostLabel}
					</span>
				) : null}
				<Button type="button" variant="outline" size="sm" className="ml-auto h-8 gap-1.5" disabled={loading || saving} onClick={reload} data-testid="remote-config-reload">
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("remoteConfig.reload")}
				</Button>
			</div>

			{snapshot === undefined && (connecting || loading) ? (
				<div role="status" aria-live="polite" className="flex items-center justify-center gap-2.5 rounded-md border border-border-subtle bg-bg-panel px-3 py-8 text-control text-muted-foreground" data-testid={connecting ? "remote-config-connecting" : "remote-config-loading"} data-tone={connecting ? "connecting" : "loading"}>
					<LoaderCircle className={connecting ? "size-4 shrink-0 animate-pideck-spin text-warning" : "size-4 shrink-0 animate-pideck-spin"} aria-hidden="true" />
					<span className="animate-pulse">{connecting ? t("remoteConfig.connecting") : t("remoteConfig.loading")}</span>
					{props.hostLabel ? <span className="truncate font-mono text-micro text-muted-foreground">{props.hostLabel}</span> : null}
				</div>
			) : null}

			{unsupported ? <RemoteConfigUnsupportedNotice bodyKey="remoteConfig.errorUnsupported" code={state.code ?? "REMOTE_CONFIG_UNSUPPORTED"} hostLabel={props.hostLabel} /> : null}

			{failed && snapshot === undefined ? (
				<div className="flex flex-col gap-2 rounded-md border border-danger/20 bg-danger-soft px-3.5 py-2.5" data-testid="remote-config-load-error" data-tone={connectCode === undefined ? "failed" : "connect-failed"}>
					<div className="flex items-center gap-2 text-control font-medium text-danger">
						<AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
						{t("remoteConfig.failedTitle")}
					</div>
					<p className="text-control leading-relaxed text-danger">{errorKey ? t(errorKey) : t("remoteConfig.errorUnavailable")}</p>
					{connectCode !== undefined ? <p className="text-micro leading-relaxed text-muted-foreground">{t("remoteConfig.connectFailed")}</p> : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button type="button" variant="outline" size="sm" className="h-8 w-fit gap-1.5" disabled={connecting || loading} onClick={reload} data-testid="remote-config-reconnect">
							<RefreshCw className="size-3.5" aria-hidden="true" />
							{t("remoteConfig.reconnect")}
						</Button>
						{state.code ? <code className="font-mono text-micro text-muted-foreground">{t("remoteConfig.errorCode", { code: state.code })}</code> : null}
						{connectCode !== undefined ? <code className="font-mono text-micro text-muted-foreground" data-testid="remote-config-connect-code">{connectCode}</code> : null}
					</div>
				</div>
			) : null}

			{snapshot ? (
				<>
					<div className="flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-config-meta">
						<div className="flex min-w-0 items-baseline gap-1.5">
							<span className="text-micro text-muted-foreground">{t("remoteConfig.version")}</span>
							<code className="font-mono text-micro text-foreground/80" data-testid="remote-config-version" title={snapshot.version}>
								{shortConfigDigest(snapshot.version)}
							</code>
						</div>
						<div className="flex min-w-0 items-baseline gap-1.5">
							<span className="text-micro text-muted-foreground">{t("remoteConfig.sha256")}</span>
							<code className="truncate font-mono text-micro text-foreground/80" data-testid="remote-config-sha256" title={snapshot.sha256}>
								{shortConfigDigest(snapshot.sha256)}
							</code>
						</div>
						{dirty ? <span className="ml-auto text-micro text-warning">{t("remoteConfig.dirty")}</span> : null}
					</div>

					<div className="flex shrink-0 flex-col gap-1.5 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-config-secrets">
						<span className="text-micro font-medium text-muted-foreground">{t("remoteConfig.secrets")}</span>
						{snapshot.secrets.length === 0 ? (
							<span className="text-micro text-muted-foreground">{t("remoteConfig.noSecrets")}</span>
						) : (
							<div className="flex flex-wrap gap-2">
								{snapshot.secrets.map((secret) => (
									<span key={secret.path} className="inline-flex items-center gap-1.5 rounded-sm bg-bg-input px-1.5 py-0.5 text-micro" data-testid="remote-config-secret">
										<code className="font-mono text-foreground/80" data-testid="remote-config-secret-path">
											{secret.path}
										</code>
										<span data-testid="remote-config-secret-badge" data-status={secret.status} className={secret.status === "configured" ? "text-success" : "text-muted-foreground"}>
											{secret.status === "configured" ? t("remoteConfig.secretConfigured") : t("remoteConfig.secretMissing")}
										</span>
									</span>
								))}
							</div>
						)}
					</div>

					{conflict ? (
						<div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3.5 py-2.5" data-testid="remote-config-conflict">
							<div className="flex items-center gap-2 text-control font-medium text-warning">
								<ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
								{t("remoteConfig.conflictTitle")}
							</div>
							<p className="text-control leading-relaxed text-muted-foreground">{t("remoteConfig.conflictBody")}</p>
							<Button type="button" variant="outline" size="sm" className="h-8 w-fit gap-1.5" disabled={loading} onClick={reload} data-testid="remote-config-conflict-reload">
								<RefreshCw className="size-3.5" aria-hidden="true" />
								{t("remoteConfig.reload")}
							</Button>
						</div>
					) : null}

					{unconfirmed ? (
						<div className="flex flex-col gap-2 rounded-md border border-danger/20 bg-danger-soft px-3.5 py-2.5" data-testid="remote-config-unconfirmed">
							<div className="flex items-center gap-2 text-control font-medium text-danger">
								<AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
								{t("remoteConfig.unconfirmedTitle")}
							</div>
							<p className="text-control leading-relaxed text-muted-foreground">{t("remoteConfig.unconfirmedBody")}</p>
							<Button type="button" variant="outline" size="sm" className="h-8 w-fit gap-1.5" disabled={loading} onClick={reload} data-testid="remote-config-unconfirmed-reload">
								<RefreshCw className="size-3.5" aria-hidden="true" />
								{t("remoteConfig.reload")}
							</Button>
						</div>
					) : null}

					{failed && snapshot ? (
						<div className="flex items-center gap-2 rounded-md border border-danger/20 bg-danger-soft px-3.5 py-2.5" data-testid="remote-config-save-error">
							<AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden="true" />
							<span className="text-control text-danger">{errorKey ? t(errorKey) : t("remoteConfig.failedTitle")}</span>
							{state.code ? <code className="ml-auto font-mono text-micro text-muted-foreground">{t("remoteConfig.errorCode", { code: state.code })}</code> : null}
						</div>
					) : null}

					<div className="flex min-h-0 shrink-0 flex-col gap-1">
						<span className="text-micro font-medium text-muted-foreground">{t("remoteConfig.data")}</span>
						<div className="h-56 overflow-hidden rounded-md border border-border-subtle" data-testid="remote-config-data">
							<CodeMirrorEditor value={formatConfigDocument(snapshot.data)} language="json" height="100%" readOnly />
						</div>
					</div>

					<div className="flex min-h-0 shrink-0 flex-col gap-1">
						<div className="flex flex-wrap items-baseline gap-2">
							<span className="text-micro font-medium text-muted-foreground">{t("remoteConfig.patch")}</span>
							<span className="text-micro text-muted-foreground">{t("remoteConfig.patchHint")}</span>
						</div>
						<div className={"h-40 overflow-hidden rounded-md border " + patchBorder} data-testid="remote-config-patch">
							<CodeMirrorEditor value={state.patchText} language="json" height="100%" readOnly={loading || saving || unsupported || unconfirmed} onChange={handlePatchChange} />
						</div>
						{patchSyntaxError || (dirty && !parsedPatch.ok) ? (
							<span className="text-micro text-danger" data-testid="remote-config-patch-error">
								{patchSyntaxError ? t(patchSyntaxError) : t(patchReason === "syntax" ? "remoteConfig.patchSyntax" : patchReason === "reserved-key" ? "remoteConfig.patchReservedKey" : "remoteConfig.patchNotObject")}
							</span>
						) : null}
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" size="sm" className="h-8 gap-1.5" disabled={!canApply} onClick={() => void handleSave()} data-testid="remote-config-save">
								<Save className="size-3.5" aria-hidden="true" />
								{saving ? t("remoteConfig.saving") : t("remoteConfig.save")}
							</Button>
							<Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={saving || loading} onClick={resetPatch} data-testid="remote-config-reset">
								<RotateCcw className="size-3.5" aria-hidden="true" />
								{t("remoteConfig.resetPatch")}
							</Button>
							{patchIsEmpty && !dirty ? <span className="text-micro text-muted-foreground">{t("remoteConfig.patchEmpty")}</span> : null}
						</div>
					</div>

					{props.file === "models" ? <RemoteModelCatalogSection hostId={props.hostId} /> : <RemoteConfigDeferredOperations />}
				</>
			) : null}
		</div>
	);
}
