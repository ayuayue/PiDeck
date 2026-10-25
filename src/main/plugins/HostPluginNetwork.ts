/** Host-mediated network requests: exact grants, pinned public DNS, bounded hops and revocable lifetime. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout, clearTimeout } from "node:timers";
import type { HostPluginManifest, HostPluginNetworkRequest, HostPluginNetworkResponse } from "../../shared/types/hostPlugin";
import { HOST_PLUGIN_NETWORK_REDIRECTS, isPublicPluginAddress, parseHostPluginNetworkRequest, parseHostPluginNetworkUrl } from "./hostPluginNetworkPolicy";
import { HOST_PLUGIN_NETWORK_REDIRECT_STATUSES, requestHostPluginHop, type HostPluginNetworkAddress, type HostPluginNetworkTransport } from "./hostPluginNetworkTransport";

type ResolveAddresses = (hostname: string) => Promise<HostPluginNetworkAddress[]>;

/** Await DNS/transport without retaining listeners when an abort wins; late operations cannot authorize a new hop. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason instanceof Error ? signal.reason : new Error("network-cancelled"));
		};
		if (signal.aborted) {
			operation.catch(() => undefined);
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Transport is injectable for isolated tests; production always uses fresh, pinned Node sockets. */
export class HostPluginNetwork {
	constructor(
		private readonly transport: HostPluginNetworkTransport = requestHostPluginHop,
		private readonly resolve: ResolveAddresses = (hostname) => lookup(hostname, { all: true, verbatim: true }),
	) {}

	/** Network permission is separate from origin/port consent; neither may be inferred from the other. */
	private async address(manifest: HostPluginManifest, url: URL, signal: AbortSignal): Promise<HostPluginNetworkAddress> {
		if (url.protocol === "http:") {
			if (!manifest.permissions.includes("network.local")) throw new Error("permission-denied");
			if (url.hostname !== "127.0.0.1" || !manifest.network?.localPorts?.includes(Number(url.port || 80))) throw new Error("network-origin-denied");
			return { address: "127.0.0.1", family: 4 };
		}
		if (!manifest.permissions.includes("network.https")) throw new Error("permission-denied");
		if (!manifest.network?.httpsOrigins?.includes(url.origin)) throw new Error("network-origin-denied");
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const family = isIP(hostname);
		const addresses = family ? [{ address: hostname, family }] : await untilAborted(this.resolve(hostname), signal);
		// Reject mixed public/private answers rather than selecting whichever one looks safe today.
		if (!addresses.length || addresses.some((item) => isIP(item.address) !== item.family || !isPublicPluginAddress(item.address))) throw new Error("network-address-denied");
		return addresses[0];
	}

	/** One total deadline covers DNS, connect, response and redirects. Scope/revocation is checked at each hop. */
	async request(manifest: HostPluginManifest, input: HostPluginNetworkRequest, ownerSignal: AbortSignal, authorized: () => boolean): Promise<HostPluginNetworkResponse> {
		let request = parseHostPluginNetworkRequest(input);
		let url = parseHostPluginNetworkUrl(request.url);
		const origin = url.origin;
		const controller = new AbortController();
		const revoke = () => controller.abort(new Error("plugin-revoked"));
		const check = () => {
			if (!authorized() || ownerSignal.aborted) revoke();
			if (controller.signal.aborted) throw controller.signal.reason;
		};
		ownerSignal.addEventListener("abort", revoke, { once: true });
		const timer = setTimeout(() => controller.abort(new Error("network-timeout")), request.timeoutMs);
		try {
			for (let redirects = 0; ; redirects++) {
				check();
				const address = await this.address(manifest, url, controller.signal);
				check();
				const response = await untilAborted(this.transport(url, request, address, controller.signal), controller.signal);
				check();
				if (!HOST_PLUGIN_NETWORK_REDIRECT_STATUSES.has(response.status)) return { url: url.toString(), status: response.status, ok: response.status >= 200 && response.status < 300, headers: response.headers, body: response.body };
				if (!response.headers.location) throw new Error("network-redirect-denied");
				if (redirects >= HOST_PLUGIN_NETWORK_REDIRECTS) throw new Error("network-too-many-redirects");
				let next: URL;
				try {
					next = new URL(response.headers.location, url);
					// Local :80 is canonicalized away by URL, but remains the same explicit-port grant.
					next = parseHostPluginNetworkUrl(next.protocol === "http:" && next.origin === origin ? `http://127.0.0.1:${next.port || 80}${next.pathname}${next.search}${next.hash}` : next.toString());
				} catch {
					throw new Error("network-redirect-denied");
				}
				// Never forward plugin-owned authorization headers or POST data to a different origin, even if declared.
				if (next.origin !== origin) throw new Error("network-redirect-denied");
				if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === "POST")) {
					const headers = { ...request.headers };
					delete headers["content-type"];
					request = { ...request, method: "GET", body: undefined, headers };
				}
				url = next;
			}
		} catch (error) {
			check();
			// DNS/TLS failures are opaque: never expose the URL, API key or OS diagnostic to plugins/logs.
			if (error instanceof Error && /^(?:network-[a-z-]+|permission-denied)$/.test(error.message)) throw error;
			throw new Error("network-request-failed");
		} finally {
			clearTimeout(timer);
			ownerSignal.removeEventListener("abort", revoke);
		}
	}
}
