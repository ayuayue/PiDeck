import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolveRemoteSftpBinaryPath } from "./RemoteSftpAdapter";

export const REMOTE_SFTP_BINARY_MAX_BYTES = 64 * 1024 * 1024;

export type RemoteSftpBinaryIdentity = {
	readonly path: string;
	readonly identity: string;
};

/**
 * Resolve and fingerprint the exact native executor bytes used by one app run.
 * Missing or unreadable binaries remain an unavailable capability, never a
 * reason to fall back to a different transfer implementation.
 */
export async function loadRemoteSftpBinaryIdentity(input: { packaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform }): Promise<RemoteSftpBinaryIdentity | undefined> {
	const path = resolveRemoteSftpBinaryPath(input);
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size < 1 || info.size > REMOTE_SFTP_BINARY_MAX_BYTES) return undefined;
		const bytes = await readFile(path);
		if (bytes.length !== info.size || bytes.length > REMOTE_SFTP_BINARY_MAX_BYTES) return undefined;
		return { path, identity: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
	} catch {
		return undefined;
	}
}
