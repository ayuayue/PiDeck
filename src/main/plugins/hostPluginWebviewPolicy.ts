/** Window-level <webview> attach policy for host-plugin panels.
 *
 * Host plugin surfaces render as in-page `<webview>` guests (same layering model as the
 * built-in browser panel), not as native WebContentsView — native views float above every
 * DOM dialog/popover and can never be covered. The renderer allocates an instance first
 * (`hostPlugins.mount`), then attaches a webview whose partition is `host-plugin:<instanceId>`;
 * `will-attach-webview`/`did-attach-webview` consult the bridge set by HostPluginService
 * after initialization (window creation happens before the service exists, hence the indirection). */
import type { WebContents } from "electron";

export const HOST_PLUGIN_PARTITION_PREFIX = "host-plugin:";

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Extract the instance id from a `host-plugin:<uuid>` partition, or null for anything else. */
export function hostPluginPartitionId(partition: string): string | null {
	if (!partition.startsWith(HOST_PLUGIN_PARTITION_PREFIX)) return null;
	const id = partition.slice(HOST_PLUGIN_PARTITION_PREFIX.length);
	return INSTANCE_ID.test(id) ? id : null;
}

/** Surface operations the window attach policy needs; backed by HostPluginViewHost once initialized. */
export type HostPluginWebviewBridge = {
	hasLive(id: string): boolean;
	/** Resolve the live instance a freshly attached guest belongs to (session identity match), or null. */
	instanceForGuest(guest: WebContents): string | null;
	/** Bind the freshly attached guest; closes it when the instance is gone or revoked. */
	attachGuest(id: string, guest: WebContents): void;
	/** Prepared preload path for plugin guests (set only after service initialization). */
	preloadPath(): string | undefined;
};

let bridge: HostPluginWebviewBridge | null = null;

export function setHostPluginWebviewBridge(next: HostPluginWebviewBridge | null): void {
	bridge = next;
}

export function hostPluginWebviewBridge(): HostPluginWebviewBridge | null {
	return bridge;
}
