/**
 * 远端项目目录页与批量存在性（从 remoteProjectIpc.ts 拆出，行为保持）。
 *
 * 两者都走同一条只读 `withProjectSession` 边界；这里只负责把目录事实/stat 结果投影成公共形状。
 */

import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type { ProjectDirectoryEntry, ProjectDirectoryPageResult, ProjectDirectoryWatchDegradation, ProjectPathState, ProjectPathsExistResult } from "../../shared/types/projectFiles";
import { applyDirectoryIgnore, type DirectoryIgnoreProbe } from "../remote/RemoteDirectoryIgnore";
import type { RemoteProjectTargetResolver } from "./remoteProjectTarget";
import { readRelativePath, readerPath, sessionPort, type RemoteProjectDirSnapshot } from "./remoteProjectReadIpc";
import { createRemoteWorkspaceReader } from "../remote/RemoteWorkspaceReader";

/**
 * 深层 watch 状态 → 页面字段。
 *
 * 只投影「确实降级」的状态：路径列表留在主进程，页面只需要原因与计数。
 * 未降级返回 undefined，页面就完全不带这个字段（旧渲染层/旧缓存不会看到新形状）。
 */
export function projectDirectoryWatchDegradation(status: { degraded?: { reason: ProjectDirectoryWatchDegradation["reason"]; desired: number; covered: number; dropped: number; code?: string } }): ProjectDirectoryWatchDegradation | undefined {
	const degraded = status.degraded;
	return degraded === undefined
		? undefined
		: {
				degraded: true,
				reason: degraded.reason,
				desired: degraded.desired,
				covered: degraded.covered,
				dropped: degraded.dropped,
				// 稳定失败码是「为什么没监听」的唯一可判定答案；成功/预算降级没有码时不伪造。
				...(degraded.code === undefined ? {} : { code: degraded.code }),
			};
}

export function projectDirectoryPage(input: {
	projectId: string;
	path: string;
	force: boolean;
	readDirSnapshot: (projectId: string, relative: string, force: boolean) => Promise<RemoteProjectDirSnapshot>;
	generationOf: (projectId: string) => string;
	/** 目录页是渲染层知道「监听降级」的唯一通道；未装配时页面形状保持旧样。 */
	dirWatch?: (projectId: string) => ProjectDirectoryWatchDegradation | undefined;
	/**
	 * Git ignore 修饰（T6 收尾）：只给已被 git 判定的条目加 `ignored: true`。
	 * 探测失败/未装配只是“没修饰”，绝不把目录页搞成失败，也不填 `false` 冒充“查过了”。
	 */
	ignoreProbe?: DirectoryIgnoreProbe;
}): Promise<ProjectDirectoryPageResult> {
	const relative = readRelativePath(input.path);
	if (relative === undefined) return Promise.resolve(opFailFromCode("REMOTE_PROJECT_PATH_INVALID"));
	return (async () => {
		const read = await input.readDirSnapshot(input.projectId, relative, input.force);
		if (!read.ok) return opFailFromCode(read.code);
		const dirWatch = input.dirWatch?.(input.projectId);
		const prefix = relative === "" ? "" : relative + "/";
		const entries: ProjectDirectoryEntry[] = read.snapshot.value
			.filter((entry) => entry.kind === "file" || entry.kind === "directory")
			.map((entry) => ({
				target: { projectId: input.projectId, relativePath: prefix + entry.name },
				relativePath: prefix + entry.name,
				type: entry.kind as "file" | "directory",
				// 单层目录协议不逐项探测：远端只能是 unknown，不能伪装成“没有子项”。
				hasChildren: (entry.kind === "directory" ? "unknown" : false) as boolean | "unknown",
			}));
		const page = entries.slice(0, 2000);
		// 只对真正返回的条目判定（截断之后），批次与上限在探测实现里定。
		// 判定失败只是「没有修饰」：它绝不能让一次成功的目录读变成失败。
		let ignored: readonly boolean[] | undefined;
		if (input.ignoreProbe !== undefined && page.length > 0) {
			try {
				ignored = await input.ignoreProbe(
					input.projectId,
					page.map((entry) => entry.relativePath),
				);
			} catch {
				ignored = undefined;
			}
		}
		return opOk({
			entries: applyDirectoryIgnore(page, ignored),
			truncated: read.snapshot.truncated || entries.length > 2000,
			scanned: read.snapshot.scanned,
			revision: read.snapshot.revision,
			generation: input.generationOf(input.projectId),
			...(dirWatch === undefined ? {} : { dirWatch }),
		});
	})();
}

export async function projectPathsExist(input: { projectId: string; paths: readonly string[]; projectReadTarget: RemoteProjectTargetResolver }): Promise<ProjectPathsExistResult> {
	const relativePaths: string[] = [];
	for (const path of input.paths) {
		const relative = readRelativePath(path);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		relativePaths.push(relative);
	}
	const target = await input.projectReadTarget(input.projectId);
	if ("code" in target) return opFailFromCode(target.code);
	try {
		const outcome = await target.service.withProjectSession(
			target.hostId,
			target.remotePath,
			async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				const states: ProjectPathState[] = [];
				// 128 路径 = 2 帧（≤64/帧）；批量是全有或全无，含缺失路径时退回逐项只读 stat，
				// 仍然不签发任何 entry/文本授权。
				for (let offset = 0; offset < relativePaths.length; offset += 64) {
					const batch = relativePaths.slice(offset, offset + 64);
					try {
						const answer = await reader.statMany(target.hostId, batch.map(readerPath));
						for (let index = 0; index < batch.length; index += 1) states.push({ target: { projectId: input.projectId, relativePath: batch[index] }, exists: true, isDirectory: answer.entries[index]?.kind === "directory" });
					} catch (error) {
						if (codeOf(error, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw error;
						for (const relativePath of batch) {
							try {
								const fileStat = await reader.stat(target.hostId, readerPath(relativePath));
								states.push({ target: { projectId: input.projectId, relativePath }, exists: true, isDirectory: fileStat.kind === "directory" });
							} catch (inner) {
								if (codeOf(inner, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw inner;
								states.push({ target: { projectId: input.projectId, relativePath }, exists: false, isDirectory: false });
							}
						}
					}
				}
				return states;
			},
			{ requireReady: true },
		);
		return outcome.ok ? opOk(outcome.value) : opFailFromCode(outcome.code);
	} catch (error) {
		return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
	}
}
