import { CloudOff } from "lucide-react";
import { REMOTE_CONFIG_CODES } from "../../../shared/piConfig";
import { t, type TranslationKey } from "../i18n";

/**
 * Stable-code copy for the remote-disabled surfaces. The list is the frozen §6.4.1 deferral set; the codes are
 * the shared closed vocabulary so tests can pin copy to protocol instead of prose.
 */
export const REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES: ReadonlyArray<{ labelKey: TranslationKey; code: string }> = [
	// Provider test/model fetch are replaced for models by the live-runtime catalog probe; usage query stays
	// v1-disabled (arbitrary probe templates cannot be allowlisted/redacted yet).
	{ labelKey: "remoteConfig.disabled.usage", code: REMOTE_CONFIG_CODES.providerOperationUnsupported },
];

/**
 * One inline notice for a remote-disabled page/entry. It never renders fake data and never offers the local
 * editor by accident: the copy names the stable code and tells the user to switch the target back to local.
 */
export function RemoteConfigUnsupportedNotice(props: { bodyKey: TranslationKey; code: string; hostLabel?: string; testId?: string }) {
	return (
		<div className="flex shrink-0 flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-4 py-3" data-testid={props.testId ?? "remote-config-unsupported"} data-code={props.code}>
			<div className="flex items-center gap-2 text-control font-medium">
				<CloudOff className="size-4 shrink-0" aria-hidden="true" />
				{t("remoteConfig.unsupported.title")}
			</div>
			<p className="text-control leading-relaxed text-muted-foreground">
				{props.hostLabel ? props.hostLabel + ": " : ""}
				{t(props.bodyKey)}
			</p>
			<code className="w-fit rounded-sm bg-bg-input px-1.5 py-0.5 font-mono text-micro text-muted-foreground" data-testid="remote-config-stable-code">
				{props.code}
			</code>
		</div>
	);
}

/** The small provider-operation deferral list shown inside the remote models/settings panel. */
export function RemoteConfigDeferredOperations() {
	return (
		<div className="flex shrink-0 flex-col gap-1.5 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-config-deferred-ops">
			<span className="text-micro font-medium text-muted-foreground">{t("remoteConfig.disabled.note")}</span>
			{REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES.map((entry) => (
				<div key={entry.labelKey} className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground">
					<span>{t(entry.labelKey)}</span>
					<code className="rounded-sm bg-bg-input px-1 py-0.5 font-mono" data-testid="remote-config-deferred-code">
						{entry.code}
					</code>
				</div>
			))}
		</div>
	);
}
