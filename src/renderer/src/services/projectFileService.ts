import { PROJECT_SERVICE_CODES, ProjectServiceError, REMOTE_UNSUPPORTED_DETAIL, unwrapOp, type ProjectFileService, type ProjectFileText, type ProjectServicesApi } from "./projectServiceContracts";
import type { ProjectFileTarget } from "../../../shared/types";
import type { ProjectDirectoryPage, ProjectPathState } from "../../../shared/types/projectFiles";

const NOT_FOUND_CODES = new Set(["PATH_NOT_FOUND", "NOT_FOUND", "REMOTE_ENTRY_NOT_FOUND", "ENOENT"]);

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

/** 纯读取复用 main 的位置路由，不能通过 entry.stat 挤占写授权。 */
function createProjectStat(api: ProjectServicesApi): ProjectFileService["stat"] {
	return async (target): Promise<ProjectPathState> => {
		const state = await api.files.stat(target);
		return { target, exists: state.exists, isDirectory: state.isDirectory };
	};
}

/** 本机文件 provider：公共读面直接透传，写面走 files:* 通道。 */
export function createLocalProjectFileService(api: ProjectServicesApi): ProjectFileService {
	return {
		async listDirectory(target, options) {
			return unwrapOp(await api.files.directoryPage(target, options), PROJECT_SERVICE_CODES.remoteFailed) as ProjectDirectoryPage;
		},
		searchFiles(projectId, query) {
			return api.files.search(projectId, query);
		},
		searchContent(projectId, query) {
			return api.files.searchContent(projectId, query);
		},
		async readText(target, options) {
			const content = await api.files.readContent(target, options?.maxBytes);
			return { content };
		},
		async writeText(target, content) {
			await api.files.writeContent(target, content);
			return {};
		},
		stat: createProjectStat(api),
		async createEntry(parent, name, type) {
			await api.files.create(parent, name, type);
		},
		async renameEntry(target, newName) {
			await api.files.rename(target, newName);
		},
		async deleteEntry(target) {
			await api.files.delete(target);
		},
		openInEditor(target) {
			return api.files.open(target);
		},
		showInFolder(target) {
			return api.files.showInFolder(target);
		},
	};
}

/** 远端文件 provider：读面同样走公共目录页；写面走 remoteHosts 的令牌化入口。 */
export function createRemoteProjectFileService(api: ProjectServicesApi): ProjectFileService {
	async function statEntry(projectId: string, relativePath: string): Promise<{ exists: boolean; isDirectory: boolean; version?: string }> {
		const result = await api.remoteHosts.statProjectEntry(projectId, relativePath);
		if (result.ok) {
			return { exists: true, isDirectory: result.value.stat.kind === "directory", version: result.value.version };
		}
		if (isNotFound(result.code)) return { exists: false, isDirectory: false };
		throw new ProjectServiceError(result.code, result.outcome);
	}

	async function requireVersion(projectId: string, relativePath: string, expectedVersion?: string): Promise<string> {
		if (expectedVersion !== undefined && expectedVersion.length > 0) return expectedVersion;
		const entry = await statEntry(projectId, relativePath);
		if (!entry.exists || entry.version === undefined) throw new ProjectServiceError(PROJECT_SERVICE_CODES.versionRequired);
		return entry.version;
	}

	return {
		async listDirectory(target, options) {
			return unwrapOp(await api.files.directoryPage(target, options), PROJECT_SERVICE_CODES.remoteFailed) as ProjectDirectoryPage;
		},
		searchFiles(projectId, query) {
			return api.files.search(projectId, query);
		},
		searchContent(projectId, query) {
			return api.files.searchContent(projectId, query);
		},
		async readText(target, options): Promise<ProjectFileText> {
			const value = unwrapOp(await api.remoteHosts.openProjectText(target.projectId, target.relativePath), PROJECT_SERVICE_CODES.remoteFailed);
			void options;
			return { content: value.document.content, version: value.document.version };
		},
		async writeText(target, content, expectedVersion) {
			const version = await requireVersion(target.projectId, target.relativePath, expectedVersion);
			const saved = unwrapOp(await api.remoteHosts.saveProjectText(target.projectId, target.relativePath, content, version), PROJECT_SERVICE_CODES.remoteFailed);
			return { version: saved.version };
		},
		stat: createProjectStat(api),
		async createEntry(parent, name, type) {
			const result = type === "file" ? await api.remoteHosts.createProjectFile(parent.projectId, parent.relativePath, name) : await api.remoteHosts.createProjectDirectory(parent.projectId, parent.relativePath, name);
			unwrapOp(result, PROJECT_SERVICE_CODES.remoteFailed);
		},
		async renameEntry(target, newName, expectedVersion) {
			const version = await requireVersion(target.projectId, target.relativePath, expectedVersion);
			const targetPath = joinRelative(parentOf(target.relativePath), newName);
			unwrapOp(await api.remoteHosts.renameProjectEntry(target.projectId, target.relativePath, targetPath, version), PROJECT_SERVICE_CODES.remoteFailed);
		},
		async deleteEntry(target, expectedVersion) {
			const version = await requireVersion(target.projectId, target.relativePath, expectedVersion);
			unwrapOp(await api.remoteHosts.deleteProjectEntry(target.projectId, target.relativePath, version), PROJECT_SERVICE_CODES.remoteFailed);
		},
		async openInEditor() {
			throw unsupported(REMOTE_UNSUPPORTED_DETAIL.fileSystemOpen);
		},
		async showInFolder() {
			throw unsupported(REMOTE_UNSUPPORTED_DETAIL.fileSystemOpen);
		},
	};
}

export type { ProjectFileService as ProjectFileServiceImpl };
