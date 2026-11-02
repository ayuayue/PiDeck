import {
	PROJECT_SERVICE_CODES,
	ProjectServiceError,
	unwrapOp,
	type ProjectEntryDeleteReceipt,
	type ProjectEntryReceipt,
	type ProjectFileSearchResult,
	type ProjectFileService,
	type ProjectFileTarget,
	type ProjectServiceFence,
	type ProjectServicePathState,
	type ProjectServicesApi,
	type ProjectTextSaveReceipt,
} from "./projectServiceContracts";
import { assertProjectTarget, fenceProjectFileService } from "./projectServiceFence";
import type { ProjectDirectoryPage } from "../../../shared/types/projectFiles";

const NOT_FOUND_CODES = new Set(["PATH_NOT_FOUND", "NOT_FOUND", "REMOTE_ENTRY_NOT_FOUND", "ENOENT"]);

const UNSUPPORTED_DETAIL = {
	fileSystemOpen: "remote workspace has no local path",
	localTextVersion: "local project has no text version; a remote text version must not be sent here",
} as const;

function isNotFound(code: string): boolean {
	return NOT_FOUND_CODES.has(code);
}

function joinRelative(parent: string, name: string): string {
	return parent.length === 0 ? name : parent.endsWith("/") ? parent + name : parent + "/" + name;
}

function parentOf(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index < 0 ? "" : relativePath.slice(0, index);
}

function unsupported(detail: string): ProjectServiceError {
	return new ProjectServiceError(PROJECT_SERVICE_CODES.unsupported, "rejected", detail);
}

function childTarget(parent: ProjectFileTarget, name: string): ProjectFileTarget {
	return { projectId: parent.projectId, relativePath: joinRelative(parentOf(parent.relativePath), name) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本机 files.create/rename 返回 string | ProjectFileTarget；只接受带项目身份的形状，否则用调用方已知的目标。 */
function readProjectTarget(value: unknown, fallback: ProjectFileTarget): ProjectFileTarget {
	if (isRecord(value) && typeof value.projectId === "string" && typeof value.relativePath === "string") return { projectId: value.projectId, relativePath: value.relativePath };
	return fallback;
}

/**
 * 纯读取复用 main 的位置路由，不能通过 entry.stat 挤占写授权。
 *
 * 当前公共 files.stat 把本地/远端的读取失败都折叠成 exists=false：provider 只能证明 present，
 * negative 一律记 unavailable（不再让 UI 把读失败显示成“文件不存在”）。
 * 待 I 把公共结果改成携带稳定码的 Op 后，这里再把 PATH_NOT_FOUND 映射成 missing。
 */
function createProjectStat(projectId: string, api: ProjectServicesApi): ProjectFileService["stat"] {
	return async (target): Promise<ProjectServicePathState> => {
		assertProjectTarget(projectId, target);
		const state = await api.files.stat(target);
		if (state.exists) return { target, availability: "present", isDirectory: state.isDirectory };
		// 读不到时连“是不是目录”也不知道：不填 isDirectory，避免 UI 把读失败显示成文件。
		return { target, availability: "unavailable", code: PROJECT_SERVICE_CODES.statUnavailable };
	};
}

function assertTextVersion(expectedVersion: string | undefined): string {
	if (typeof expectedVersion !== "string" || expectedVersion.length === 0) throw new ProjectServiceError(PROJECT_SERVICE_CODES.versionRequired, "rejected", "readText must return a text version before saving");
	return expectedVersion;
}

/** 本机文件 provider：公共读面直接透传，写面走 files:* 通道。 */
export function createLocalProjectFileService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence): ProjectFileService {
	const service: ProjectFileService = {
		async listDirectory(target, options): Promise<ProjectDirectoryPage> {
			assertProjectTarget(projectId, target);
			return unwrapOp(await api.files.directoryPage(target, options), PROJECT_SERVICE_CODES.failed) as ProjectDirectoryPage;
		},
		async searchFiles(query): Promise<ProjectFileSearchResult> {
			// 本机 files.search 没有 truncated/scanned 元数据；不填 false 冒充完整。
			return { results: await api.files.search(projectId, query) };
		},
		searchContent(query) {
			return api.files.searchContent(projectId, query);
		},
		async readText(target, options) {
			assertProjectTarget(projectId, target);
			return { content: await api.files.readContent(target, options?.maxBytes) };
		},
		async writeText(target, content, expectedVersion): Promise<ProjectTextSaveReceipt> {
			assertProjectTarget(projectId, target);
			// 本机没有文本 version 通道：传入远端令牌必须显式拒绝，不能静默忽略。
			if (expectedVersion !== undefined) throw unsupported(UNSUPPORTED_DETAIL.localTextVersion);
			await api.files.writeContent(target, content);
			return {};
		},
		stat: createProjectStat(projectId, api),
		async createEntry(parent, name, type): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, parent);
			const created = await api.files.create(parent, name, type);
			return { target: readProjectTarget(created, childTarget(parent, name)), kind: type };
		},
		async renameEntry(target, newName): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, target);
			const renamed = await api.files.rename(target, newName);
			return { target: readProjectTarget(renamed, childTarget(target, newName)) };
		},
		async moveEntry(target, destinationRelativePath): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, target);
			const parentPath = parentOf(destinationRelativePath);
			const name = destinationRelativePath.slice(destinationRelativePath.lastIndexOf("/") + 1);
			const moved = await api.files.move([target], { projectId, relativePath: parentPath });
			const movedTarget = readProjectTarget(moved[0], { projectId, relativePath: destinationRelativePath });
			if (movedTarget.relativePath === destinationRelativePath) return { target: movedTarget };
			// 目标文件名与源不同：移动到位后再改名；两步都成功才返回收据，失败则抛出。
			const renamed = await api.files.rename(movedTarget, name);
			return { target: readProjectTarget(renamed, { projectId, relativePath: destinationRelativePath }) };
		},
		async deleteEntry(target): Promise<ProjectEntryDeleteReceipt> {
			assertProjectTarget(projectId, target);
			await api.files.delete(target);
			return { target };
		},
		async openInEditor(target) {
			assertProjectTarget(projectId, target);
			await api.files.open(target);
		},
		async showInFolder(target) {
			assertProjectTarget(projectId, target);
			await api.files.showInFolder(target);
		},
	};
	return fenceProjectFileService(fence, service);
}

type EntryStat = { exists: true; isDirectory: boolean; version?: string } | { exists: false; code: string; outcome: "rejected" | "unknown" };

/** 远端 entry 令牌：只用于 rename/delete，绝不作为文本 version。 */
async function statEntry(api: ProjectServicesApi, projectId: string, target: ProjectFileTarget): Promise<EntryStat> {
	const result = await api.remoteHosts.statProjectEntry(projectId, target.relativePath);
	if (result.ok) return { exists: true, isDirectory: result.value.stat.kind === "directory", version: result.value.version };
	if (isNotFound(result.code)) return { exists: false, code: result.code, outcome: result.outcome };
	throw new ProjectServiceError(result.code, result.outcome);
}

async function requireEntryVersion(api: ProjectServicesApi, projectId: string, target: ProjectFileTarget, expectedVersion?: string): Promise<string> {
	if (typeof expectedVersion === "string" && expectedVersion.length > 0) return expectedVersion;
	const entry = await statEntry(api, projectId, target);
	if (!entry.exists) throw new ProjectServiceError(entry.code, entry.outcome);
	if (typeof entry.version !== "string" || entry.version.length === 0) throw new ProjectServiceError(PROJECT_SERVICE_CODES.versionRequired);
	return entry.version;
}

/** 远端文件 provider：读面同样走公共目录页；写面走 remoteHosts 的令牌化入口。 */
export function createRemoteProjectFileService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence): ProjectFileService {
	const service: ProjectFileService = {
		async listDirectory(target, options): Promise<ProjectDirectoryPage> {
			assertProjectTarget(projectId, target);
			return unwrapOp(await api.files.directoryPage(target, options), PROJECT_SERVICE_CODES.failed) as ProjectDirectoryPage;
		},
		async searchFiles(query): Promise<ProjectFileSearchResult> {
			// 远端文件名搜索的唯一真实入口是 remoteHosts.searchProject（files:search 对远端项目直接拒绝）。
			const value = unwrapOp(await api.remoteHosts.searchProject(projectId, "", query), PROJECT_SERVICE_CODES.failed);
			return {
				results: value.entries.map((entry) => ({
					name: entry.name,
					relativePath: entry.path,
					displayPath: entry.path,
					target: { projectId, relativePath: entry.path },
					type: entry.kind === "directory" ? "directory" : "file",
				})),
				truncated: value.truncated,
				scanned: value.scanned,
				// 原始条目只作为附加信息：普通 results 仍是位置无关的公共投影。
				entries: value.entries,
			};
		},
		searchContent(query) {
			return api.files.searchContent(projectId, query);
		},
		async readText(target, options) {
			assertProjectTarget(projectId, target);
			// 远端正文有 main 自己的 256 KiB 上限；maxBytes 不进入远端协议。
			void options;
			const value = unwrapOp(await api.remoteHosts.openProjectText(projectId, target.relativePath), PROJECT_SERVICE_CODES.failed);
			return { content: value.document.content, version: value.document.version };
		},
		async writeText(target, content, expectedVersion): Promise<ProjectTextSaveReceipt> {
			assertProjectTarget(projectId, target);
			// T 的核心：文本保存只能使用 readText 返回的文本 version；缺失/空串时零调用拒绝。
			// 绝不 statProjectEntry 取 entry 令牌、也不重新 open 覆盖原版本语义。
			const version = assertTextVersion(expectedVersion);
			const saved = unwrapOp(await api.remoteHosts.saveProjectText(projectId, target.relativePath, content, version), PROJECT_SERVICE_CODES.failed);
			if (typeof saved.version !== "string" || saved.version.length === 0) throw new ProjectServiceError(PROJECT_SERVICE_CODES.failed, "unknown", "save returned no text version");
			return { version: saved.version };
		},
		stat: createProjectStat(projectId, api),
		async createEntry(parent, name, type): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, parent);
			const result = type === "file" ? await api.remoteHosts.createProjectFile(projectId, parent.relativePath, name) : await api.remoteHosts.createProjectDirectory(projectId, parent.relativePath, name);
			const created = unwrapOp(result, PROJECT_SERVICE_CODES.failed);
			return { target: { projectId, relativePath: created.relativePath }, kind: created.kind };
		},
		async renameEntry(target, newName, expectedVersion): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, target);
			const version = await requireEntryVersion(api, projectId, target, expectedVersion);
			const targetPath = joinRelative(parentOf(target.relativePath), newName);
			const renamed = unwrapOp(await api.remoteHosts.renameProjectEntry(projectId, target.relativePath, targetPath, version), PROJECT_SERVICE_CODES.failed);
			return { target: { projectId, relativePath: renamed.relativePath } };
		},
		async moveEntry(target, destinationRelativePath): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, target);
			// 跨目录移动复用 rename 的 entry 令牌（同一项目内移动）；绝不拿文本 version 冒充。
			const version = await requireEntryVersion(api, projectId, target);
			const moved = unwrapOp(await api.remoteHosts.renameProjectEntry(projectId, target.relativePath, destinationRelativePath, version), PROJECT_SERVICE_CODES.failed);
			return { target: { projectId, relativePath: moved.relativePath } };
		},
		async deleteEntry(target, expectedVersion): Promise<ProjectEntryDeleteReceipt> {
			assertProjectTarget(projectId, target);
			const version = await requireEntryVersion(api, projectId, target, expectedVersion);
			const deleted = unwrapOp(await api.remoteHosts.deleteProjectEntry(projectId, target.relativePath, version), PROJECT_SERVICE_CODES.failed);
			return { target, trashId: deleted.trashId };
		},
		async openInEditor() {
			throw unsupported(UNSUPPORTED_DETAIL.fileSystemOpen);
		},
		async showInFolder() {
			throw unsupported(UNSUPPORTED_DETAIL.fileSystemOpen);
		},
	};
	return fenceProjectFileService(fence, service);
}

export type { ProjectFileService as ProjectFileServiceImpl };
