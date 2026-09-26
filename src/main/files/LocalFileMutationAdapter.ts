import { cp, rename as fsRename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProjectFileTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

export type LocalFilePathResolver = (input: string | ProjectFileTarget) => Promise<string>;

/** Preserves local clipboard-path copy/move behavior during the target migration. */
export class LocalFileMutationAdapter {
	constructor(
		private readonly resolvePath: LocalFilePathResolver,
		private readonly appLogger: Pick<AppLogger, "info">,
	) {}

	async copy(sources: Array<string | ProjectFileTarget>, targetDir: string | ProjectFileTarget): Promise<string[]> {
		const hostTargetDir = await this.resolvePath(targetDir);
		const resolvedSources = await Promise.all(sources.map(async (source) => ({ source, path: await this.resolvePath(source) })));
		const results: string[] = [];
		for (const { source, path } of resolvedSources) {
			try {
				const destination = join(hostTargetDir, basename(path));
				await cp(path, destination, { recursive: true, errorOnExist: false });
				results.push(destination);
				void this.appLogger.info("file", "File/folder copied", { src: source, dest: destination });
			} catch (error) {
				void this.appLogger.info("file", "File copy failed", { src: source, targetDir, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		return results;
	}

	async move(sources: Array<string | ProjectFileTarget>, targetDir: string | ProjectFileTarget): Promise<string[]> {
		const hostTargetDir = await this.resolvePath(targetDir);
		const resolvedSources = await Promise.all(sources.map(async (source) => ({ source, path: await this.resolvePath(source) })));
		const results: string[] = [];
		for (const { source, path } of resolvedSources) {
			try {
				const destination = join(hostTargetDir, basename(path));
				try {
					await fsRename(path, destination);
				} catch {
					await cp(path, destination, { recursive: true });
					await rm(path, { recursive: true, force: true });
				}
				results.push(destination);
				void this.appLogger.info("file", "File/folder moved", { src: source, dest: destination });
			} catch (error) {
				void this.appLogger.info("file", "File move failed", { src: source, targetDir, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		return results;
	}
}
