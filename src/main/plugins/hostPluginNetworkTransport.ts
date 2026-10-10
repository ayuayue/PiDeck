/** One HTTP hop over a pinned address, with no proxy, shared cookies or connection pool. */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HostPluginNetworkRequest } from "../../shared/types/hostPlugin";
import { HOST_PLUGIN_NETWORK_HEADER_BYTES, HOST_PLUGIN_NETWORK_RESPONSE_BYTES } from "./hostPluginNetworkPolicy";

export type HostPluginNetworkAddress = { address: string; family: number };
export type HostPluginNetworkHop = { status: number; headers: Record<string, string>; body: string };
export type HostPluginNetworkTransport = (url: URL, input: HostPluginNetworkRequest, address: HostPluginNetworkAddress, signal: AbortSignal) => Promise<HostPluginNetworkHop>;
export const HOST_PLUGIN_NETWORK_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESPONSE_HEADERS = new Set(["content-type", "content-length", "cache-control", "etag", "last-modified", "retry-after"]);

/** Keep transport diagnostics out of plugin errors: they can contain hostnames, paths and credentials. */
function transportError(error: unknown): Error {
	if (error instanceof Error && /^network-[a-z-]+$/.test(error.message)) return error;
	if (typeof error === "object" && error !== null && "code" in error && error.code === "HPE_HEADER_OVERFLOW") return new Error("network-headers-too-large");
	return new Error("network-request-failed");
}

/** Read bounded UTF-8 text/JSON only; compressed or binary responses never expand in the host. */
export const requestHostPluginHop: HostPluginNetworkTransport = (url, input, address, signal) =>
	new Promise((resolve, reject) => {
		let outgoing: ClientRequest | undefined;
		let incoming: IncomingMessage | undefined;
		let settled = false;
		const finish = (error?: unknown, value?: HostPluginNetworkHop) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (error) {
				incoming?.destroy();
				outgoing?.destroy();
				reject(transportError(error));
			} else if (value) resolve(value);
		};
		const onAbort = () => finish(new Error("network-cancelled"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const send = url.protocol === "https:" ? httpsRequest : httpRequest;
			outgoing = send(
				url,
				{
					method: input.method ?? "GET",
					headers: { ...input.headers, "accept-encoding": "identity" },
					// Fresh sockets avoid reusing an address validated for a previous DNS answer.
					agent: false,
					maxHeaderSize: HOST_PLUGIN_NETWORK_HEADER_BYTES,
					lookup: (_hostname, options, callback) => {
						// The original URL stays intact for Host/SNI and certificate verification.
						if (options.all) callback(null, [address]);
						else callback(null, address.address, address.family);
					},
				},
				(response) => {
					incoming = response;
					response.once("error", (error) => finish(error));
					response.once("aborted", () => finish(new Error("network-request-failed")));
					const status = response.statusCode ?? 0;
					if (status < 100 || status > 599) return finish(new Error("network-request-failed"));
					const headers: Record<string, string> = {};
					for (const [name, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(name) && typeof value === "string") headers[name] = value;
					if (HOST_PLUGIN_NETWORK_REDIRECT_STATUSES.has(status)) {
						if (typeof response.headers.location === "string") headers.location = response.headers.location;
						finish(undefined, { status, headers, body: "" });
						response.destroy();
						return;
					}
					const encoding = response.headers["content-encoding"];
					if (encoding && encoding !== "identity") return finish(new Error("network-response-encoding-denied"));
					const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
					const mediaType = contentType.split(";", 1)[0].trim();
					// Empty 204/304 responses do not need a content type; all other data must be textual.
					if (status !== 204 && status !== 304 && !/^(?:text\/[a-z0-9.+-]+|application\/(?:json|[a-z0-9.-]+\+json))$/.test(mediaType)) return finish(new Error("network-response-type-denied"));
					const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/.exec(contentType)?.[1];
					if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") return finish(new Error("network-response-encoding-denied"));
					const length = response.headers["content-length"];
					if (typeof length === "string" && Number(length) > HOST_PLUGIN_NETWORK_RESPONSE_BYTES) return finish(new Error("network-response-too-large"));
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("data", (chunk: Buffer) => {
						if (settled) return;
						bytes += chunk.length;
						if (bytes > HOST_PLUGIN_NETWORK_RESPONSE_BYTES) return finish(new Error("network-response-too-large"));
						chunks.push(chunk);
					});
					response.once("end", () => {
						try {
							const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
							finish(undefined, { status, headers, body });
						} catch {
							finish(new Error("network-response-encoding-denied"));
						}
					});
				},
			);
			outgoing.once("error", (error) => finish(error));
			outgoing.end(input.body);
		} catch (error) {
			finish(error);
		}
	});
