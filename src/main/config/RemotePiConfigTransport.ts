import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

type ServiceOf = () => Promise<RemoteHostConnectionService> | undefined;

async function requireService(serviceOf: ServiceOf): Promise<RemoteHostConnectionService> {
	const pending = serviceOf();
	if (pending === undefined) throw new Error("REMOTE_CONFIG_UNAVAILABLE");
	return await pending;
}

/**
 * The helper transport both remote config and remote MCP route through.
 *
 * One place owns the timeout and the session rules so the two layers cannot drift: host user files are read
 * on the host's session, and one project's `.pi/mcp.json` is read on the session confined to that project's
 * root (the host lock is held for the whole frame, so a sibling project's root switch cannot land inside it).
 * A project request without a usable root fails closed; it never falls back to the host session.
 */
export function createRemotePiConfigTransport(serviceOf: ServiceOf) {
	return {
		request: async (hostId: string, method: string, params: unknown) => (await requireService(serviceOf)).request(hostId, method, params, { timeoutMs: 15_000 }),
		requestProject: async (hostId: string, root: string, method: string, params: unknown) => {
			const outcome = await (await requireService(serviceOf)).withProjectSession(hostId, root, (session) => session.request(method, params));
			if (!outcome.ok) throw new Error(outcome.code);
			return outcome.value;
		},
	};
}
