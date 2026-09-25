import { isAbsolute } from "node:path";
import { buildSshConfigQueryArgs, type SshDraftRoute } from "./SshCommandBuilder";
import type { VerifiedSshEndpoint } from "./SshHostPinStore";

export type RemoteHostProfile = SshDraftRoute & {
	id: string;
	label: string;
	connectTimeoutMs: number;
	createdAt: string;
	updatedAt: string;
	identityFile?: string;
	remotePiCommand?: string;
	remoteNodeCommand?: string;
	browseRoots?: string[];
	lastConnectedAt?: string;
	verifiedEndpoint?: VerifiedSshEndpoint;
	verifiedAt?: string;
	disabledAt?: string;
};

export type RemoteHostSnapshot = { schemaVersion: 1; revision: number; profiles: RemoteHostProfile[]; retiredHostIds: string[] };
export type DecodedRemoteHostSnapshot = Omit<RemoteHostSnapshot, "schemaVersion">;

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_PROFILE_KEYS = new Set(["id", "label", "sshHost", "port", "user", "proxyJump", "identityFile", "remotePiCommand", "remoteNodeCommand", "browseRoots", "connectTimeoutMs", "createdAt", "updatedAt", "lastConnectedAt", "verifiedEndpoint", "verifiedAt", "disabledAt"]);
const ENDPOINT_KEYS = new Set(["hostName", "port", "user", "pinAlias", "routeDigest", "knownHostsSha256", "hostKeyFingerprints"]);

function invalid(): never {
	throw new Error("REMOTE_HOST_STORE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(record).every((key) => keys.has(key));
}

function validDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validToken(value: unknown): value is string {
	return typeof value === "string" && /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(value) && !value.split("/").includes("..");
}

function readEndpoint(value: unknown, hostId: string): VerifiedSshEndpoint {
	if (!isRecord(value) || !onlyKeys(value, ENDPOINT_KEYS)) invalid();
	if (typeof value.hostName !== "string" || !value.hostName || /^-|\s|[\x00-\x1f\x7f]/.test(value.hostName)) invalid();
	if (typeof value.user !== "string" || !value.user || /^-|\s|[\x00-\x1f\x7f]/.test(value.user)) invalid();
	if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 || value.pinAlias !== `pideck-${hostId}`) invalid();
	if (typeof value.routeDigest !== "string" || !SHA256.test(value.routeDigest) || typeof value.knownHostsSha256 !== "string" || !SHA256.test(value.knownHostsSha256)) invalid();
	if (!Array.isArray(value.hostKeyFingerprints) || value.hostKeyFingerprints.length !== 1 || typeof value.hostKeyFingerprints[0] !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.hostKeyFingerprints[0])) invalid();
	return { hostName: value.hostName, user: value.user, port: Number(value.port), pinAlias: value.pinAlias, routeDigest: value.routeDigest, knownHostsSha256: value.knownHostsSha256, hostKeyFingerprints: [value.hostKeyFingerprints[0]] };
}

function readProfile(value: unknown): RemoteHostProfile {
	if (!isRecord(value) || !onlyKeys(value, ALLOWED_PROFILE_KEYS)) invalid();
	if (typeof value.id !== "string" || !HOST_ID.test(value.id)) invalid();
	if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128 || /[\x00-\x1f\x7f]/.test(value.label)) invalid();
	if (!Number.isSafeInteger(value.connectTimeoutMs) || Number(value.connectTimeoutMs) < 1000 || Number(value.connectTimeoutMs) > 120_000) invalid();
	if (!validDate(value.createdAt) || !validDate(value.updatedAt) || value.updatedAt < value.createdAt) invalid();
	if (value.verifiedAt !== undefined && (!validDate(value.verifiedAt) || value.verifiedAt < value.createdAt)) invalid();
	if (value.disabledAt !== undefined && (!validDate(value.disabledAt) || value.disabledAt < value.createdAt)) invalid();
	if (value.lastConnectedAt !== undefined && !validDate(value.lastConnectedAt)) invalid();
	if (value.identityFile !== undefined && (typeof value.identityFile !== "string" || !isAbsolute(value.identityFile) || /[\x00-\x1f\x7f]/.test(value.identityFile))) invalid();
	if (value.remotePiCommand !== undefined && !validToken(value.remotePiCommand)) invalid();
	if (value.remoteNodeCommand !== undefined && !validToken(value.remoteNodeCommand)) invalid();
	if (
		value.browseRoots !== undefined &&
		(!Array.isArray(value.browseRoots) || value.browseRoots.length > 32 || value.browseRoots.some((path) => typeof path !== "string" || !path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").includes("..") || path.split("/").includes(".") || path.includes("//")))
	)
		invalid();
	if (typeof value.sshHost !== "string" || (value.port !== undefined && typeof value.port !== "number") || (value.user !== undefined && typeof value.user !== "string") || (value.proxyJump !== undefined && typeof value.proxyJump !== "string")) invalid();
	const route: SshDraftRoute = { sshHost: value.sshHost, ...(value.port !== undefined ? { port: value.port } : {}), ...(value.user !== undefined ? { user: value.user } : {}), ...(value.proxyJump !== undefined ? { proxyJump: value.proxyJump } : {}) };
	try {
		buildSshConfigQueryArgs(route);
	} catch {
		invalid();
	}
	if ((value.verifiedEndpoint === undefined) !== (value.verifiedAt === undefined)) invalid();
	if (value.browseRoots !== undefined && value.verifiedEndpoint === undefined) invalid();
	const verifiedEndpoint = value.verifiedEndpoint === undefined ? undefined : readEndpoint(value.verifiedEndpoint, value.id);
	return {
		id: value.id,
		label: value.label,
		...route,
		connectTimeoutMs: Number(value.connectTimeoutMs),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(value.identityFile !== undefined ? { identityFile: value.identityFile } : {}),
		...(value.remotePiCommand !== undefined ? { remotePiCommand: value.remotePiCommand } : {}),
		...(value.remoteNodeCommand !== undefined ? { remoteNodeCommand: value.remoteNodeCommand } : {}),
		...(value.browseRoots !== undefined ? { browseRoots: [...value.browseRoots] } : {}),
		...(value.lastConnectedAt !== undefined ? { lastConnectedAt: value.lastConnectedAt } : {}),
		...(verifiedEndpoint !== undefined ? { verifiedEndpoint } : {}),
		...(value.verifiedAt !== undefined ? { verifiedAt: value.verifiedAt } : {}),
		...(value.disabledAt !== undefined ? { disabledAt: value.disabledAt } : {}),
	};
}

/** Strict v1 decoder: reject unknown authority fields and duplicate or reused host IDs. */
export function decodeRemoteHostSnapshot(value: unknown): DecodedRemoteHostSnapshot {
	if (
		!isRecord(value) ||
		!onlyKeys(value, new Set(["schemaVersion", "revision", "profiles", "retiredHostIds"])) ||
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		!Array.isArray(value.profiles) ||
		!Array.isArray(value.retiredHostIds) ||
		value.profiles.length > 1000 ||
		value.retiredHostIds.length > 1000
	)
		invalid();
	const profiles = value.profiles.map(readProfile);
	const retiredHostIds: string[] = [];
	for (const id of value.retiredHostIds) {
		if (typeof id !== "string" || !HOST_ID.test(id)) invalid();
		retiredHostIds.push(id);
	}
	const ids = [...profiles.map((profile) => profile.id), ...retiredHostIds];
	if (new Set(ids).size !== ids.length) invalid();
	return { revision: Number(value.revision), profiles, retiredHostIds };
}

export function encodeRemoteHostSnapshot(profiles: RemoteHostProfile[], retiredHostIds: string[], revision: number): RemoteHostSnapshot {
	if (!Number.isSafeInteger(revision) || revision < 1) invalid();
	const decoded = decodeRemoteHostSnapshot({ schemaVersion: 1, revision, profiles, retiredHostIds });
	return { schemaVersion: 1, ...decoded };
}
