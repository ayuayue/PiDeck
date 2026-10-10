/** Renderer-only form shaping; the main-process manifest parser remains the authority for network grants. */
import type { HostPluginScaffoldInput } from "../../../shared/types/hostPlugin";

export type HostPluginScaffoldDraft = Omit<HostPluginScaffoldInput, "network"> & { httpsOrigins: string; localPorts: string };
const SCAFFOLD_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Network is opt-in; keep session viewing as the existing default. */
export function initialHostPluginScaffoldDraft(): HostPluginScaffoldDraft {
	return { id: "", name: "", permissions: ["sessions.read"], presentation: "modal", httpsOrigins: "", localPorts: "" };
}

/** One or more comma/whitespace-separated values; empty or duplicate grants should be fixed before IPC. */
function destinations(text: string): string[] | null {
	const values = text
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	return values.length >= 1 && values.length <= 16 && new Set(values).size === values.length ? values : null;
}

/** Validate form syntax without DNS or network access. Public IP and authoritative consent checks stay in main. */
export function hostPluginScaffoldInput(draft: HostPluginScaffoldDraft): HostPluginScaffoldInput | null {
	if (!SCAFFOLD_ID.test(draft.id) || draft.id.length > 80 || !draft.name.trim() || draft.name.length > 160 || /[\u0000-\u001f\u007f]/.test(draft.name)) return null;
	const network: NonNullable<HostPluginScaffoldInput["network"]> = {};
	if (draft.permissions.includes("network.https")) {
		const values = destinations(draft.httpsOrigins);
		if (!values) return null;
		const origins: string[] = [];
		for (const value of values) {
			try {
				const url = new URL(value);
				if (value.length > 2048 || /[?#*\\]/.test(value) || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return null;
				origins.push(url.origin);
			} catch {
				return null;
			}
		}
		if (new Set(origins).size !== origins.length) return null;
		network.httpsOrigins = origins;
	}
	if (draft.permissions.includes("network.local")) {
		const values = destinations(draft.localPorts);
		if (!values || values.some((value) => !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)) return null;
		network.localPorts = values.map(Number);
	}
	return { id: draft.id, name: draft.name.trim(), permissions: draft.permissions, presentation: draft.presentation, ...(network.httpsOrigins || network.localPorts ? { network } : {}) };
}
