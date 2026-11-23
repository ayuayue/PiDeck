import { REMOTE_EXTENSION_DISPOSITIONS } from "../../../shared/remoteExtensionDisposition";
import type { PiExtensionSummary } from "../../../shared/types";

/** User-facing PiDeck extensions that can be injected into remote sessions. */
const remoteBuiltIns = Object.entries(REMOTE_EXTENSION_DISPOSITIONS)
	.filter(([name, disposition]) => name !== "pi-deck-runtime.ts" && (disposition === "remote" || disposition === "remote-needs-env"))
	.map(([name]) => name);
const remoteBuiltInSet = new Set(remoteBuiltIns);

export function isRemoteSharedBuiltIn(source: string): boolean {
	return remoteBuiltInSet.has(source);
}

/** These switches reflect the host application's shared injection settings, not SSH settings. */
export function remoteSharedBuiltInRows(removed: readonly string[], version: string | null): PiExtensionSummary[] {
	const disabled = new Set(removed);
	return remoteBuiltIns.map((source) => ({ id: `local:${source}`, source, scope: "user", builtIn: true, enabled: !disabled.has(source), ...(version ? { currentVersion: version } : {}) }));
}
