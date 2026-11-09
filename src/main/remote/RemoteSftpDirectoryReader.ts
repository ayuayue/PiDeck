import { codeOf } from "../../shared/op";
import type { RemoteProjectSession } from "./RemoteHostConnectionService";
import { REMOTE_SFTP_MAX_ENTRIES, runRemoteSftpJob, type RemoteSftpList, type RemoteSftpProbe } from "./RemoteSftpAdapter";
import type { RemoteSftpBinaryIdentity } from "./RemoteSftpBinary";
import type { RemoteSftpCapabilityCache, RemoteSftpProbeResult } from "./RemoteSftpCapabilityCache";
import type { RemoteSftpCapabilityProbe } from "./RemoteSftpCapabilityProbe";

/** The helper's list ceiling is the public fact ceiling; the native request must not exceed it. */
export const REMOTE_SFTP_DIRECTORY_MAX_ENTRIES = 4096;

export const REMOTE_SFTP_DIRECTORY_READER_CODES = {
	binaryUnavailable: "REMOTE_SFTP_BINARY_UNAVAILABLE",
	readFailed: "REMOTE_SFTP_DIRECTORY_READ_FAILED",
} as const;

export type RemoteSftpDirectoryPort = {
	/**
	 * Read one directory while the caller keeps the project session pinned. The port never
	 * opens a helper session of its own and never falls back to the helper fs.list path.
	 */
	read(input: { session: RemoteProjectSession; canonicalRoot: string; relative: string; signal?: AbortSignal }): Promise<RemoteSftpDirectoryResult>;
};

export type RemoteSftpDirectoryResult = { ok: true; value: RemoteSftpList } | { ok: false; code: string };

export type RemoteSftpDirectoryReaderDependencies = {
	binary: () => Promise<RemoteSftpBinaryIdentity | undefined>;
	cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	probe: Pick<RemoteSftpCapabilityProbe, "ensureProbe">;
	adapter?: typeof runRemoteSftpJob;
};

function failed(code: string): RemoteSftpDirectoryResult {
	return { ok: false, code };
}

export function createRemoteSftpDirectoryReader(dependencies: RemoteSftpDirectoryReaderDependencies): RemoteSftpDirectoryPort {
	const adapter = dependencies.adapter ?? runRemoteSftpJob;
	return {
		async read(input) {
			if (typeof input?.canonicalRoot !== "string" || input.canonicalRoot.length === 0 || typeof input.relative !== "string" || input.relative.length > 4096 || input.session === undefined) {
				return failed(REMOTE_SFTP_DIRECTORY_READER_CODES.readFailed);
			}

			let binary: RemoteSftpBinaryIdentity | undefined;
			try {
				binary = await dependencies.binary();
			} catch {
				return failed(REMOTE_SFTP_DIRECTORY_READER_CODES.binaryUnavailable);
			}
			if (binary === undefined) return failed(REMOTE_SFTP_DIRECTORY_READER_CODES.binaryUnavailable);

			let probed: RemoteSftpProbeResult<RemoteSftpProbe>;
			try {
				probed = await dependencies.probe.ensureProbe({
					canonicalRoot: input.canonicalRoot,
					binaryPath: binary.path,
					binaryIdentity: binary.identity,
					session: input.session,
					cache: dependencies.cache,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				});
			} catch (error) {
				return failed(codeOf(error, REMOTE_SFTP_DIRECTORY_READER_CODES.readFailed));
			}
			if (!probed.ok) return failed(probed.code);

			try {
				const result = await input.session.withSftpInvocation(async (invocation, assertCurrent) => {
					await assertCurrent();
					if (input.signal?.aborted === true) return failed("SFTP_JOB_CANCELLED");
					const outcome = await adapter(
						binary.path,
						{
							operation: "list",
							invocation,
							root: input.canonicalRoot,
							relative: input.relative,
							maxEntries: Math.min(REMOTE_SFTP_DIRECTORY_MAX_ENTRIES, REMOTE_SFTP_MAX_ENTRIES),
						},
						{ ...(input.signal === undefined ? {} : { signal: input.signal }) },
					);
					// A listing has no user-data write, but its result still belongs to the generation
					// that produced it; a reconnect makes it stale rather than reusable evidence.
					await assertCurrent();
					if (!outcome.ok) return failed(outcome.code);
					if (outcome.operation !== "list") return failed("SFTP_RESULT_INVALID");
					return { ok: true as const, value: outcome.value };
				});
				return result;
			} catch (error) {
				return failed(codeOf(error, REMOTE_SFTP_DIRECTORY_READER_CODES.readFailed));
			}
		},
	};
}
