import {
	PROJECT_SERVICE_CODES,
	ProjectServiceError,
	unwrapOp,
	type ProjectEntryDeleteReceipt,
	type ProjectEntryReceipt,
	type ProjectFileSearchResult,
	type ProjectFileService,
	type ProjectFileTarget,
	type ProjectFileText,
	type ProjectFileTransferOptions,
	type ProjectFileUploadSource,
	type ProjectServiceFence,
	type ProjectServicePathState,
	type ProjectServicesApi,
	type ProjectTextSaveReceipt,
} from "./projectServiceContracts";
import { assertProjectTarget, fenceProjectFileService } from "./projectServiceFence";
import { downloadThroughRemoteTransfer, uploadThroughRemoteTransfer } from "./remoteProjectTransferClient";
import type { ProjectDirectoryPage, ProjectFileStatResult } from "../../../shared/types/projectFiles";

const UNSUPPORTED_DETAIL = {
	fileSystemOpen: "remote workspace has no local path",
	localTextVersion: "local project has no text version; a remote text version must not be sent here",
	transferUnavailable: "this project location has no transfer entry",
} as const;

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
 * 目录内/跨目录移动（位置分派收口）：本机与远端都只调公共 `files:move`。
 * 目标文件名与源不同时，移动到位后再用公共 `files:rename` 改名；两步都成功才返回收据。
 */
async function moveProjectEntry(api: ProjectServicesApi, projectId: string, target: ProjectFileTarget, destinationRelativePath: string): Promise<ProjectEntryReceipt> {
	assertProjectTarget(projectId, target);
	const parentPath = parentOf(destinationRelativePath);
	const name = destinationRelativePath.slice(destinationRelativePath.lastIndexOf("/") + 1);
	const moved = unwrapOp(await api.files.move([target], { projectId, relativePath: parentPath }), PROJECT_SERVICE_CODES.failed);
	const movedTarget = readProjectTarget(moved[0], { projectId, relativePath: destinationRelativePath });
	if (movedTarget.relativePath === destinationRelativePath) return { target: movedTarget };
	const renamed = unwrapOp(await api.files.rename(movedTarget, name), PROJECT_SERVICE_CODES.failed);
	return { target: readProjectTarget(renamed, { projectId, relativePath: destinationRelativePath }) };
}

/**
 * 文件名搜索（位置分派收口）：本机与远端都只调公共 `files:search-page`，
 * 位置差异（索引/BFS vs helper 搜索）全部在 main 内决定；provider 只负责拆信封与保留元数据。
 */
function createProjectFileSearch(projectId: string, api: ProjectServicesApi): ProjectFileService["searchFiles"] {
	return async (query) => unwrapOp(await api.files.searchPage(projectId, query), PROJECT_SERVICE_CODES.failed);
}

/**
 * 纯读取复用 main 的位置路由，不能通过 entry.stat 挤占写授权。
 *
 * 公共 files.stat 携带 present / missing / unavailable 三态；provider 不再从布尔负结果猜测。
 */
function createProjectStat(projectId: string, api: ProjectServicesApi): ProjectFileService["stat"] {
	return async (target): Promise<ProjectServicePathState> => {
		assertProjectTarget(projectId, target);
		const raw = await api.files.stat(target);
		// Older preload builds only answered `exists`; keep that boundary explicit while
		// renderer and preload are reloaded together during a live Electron update.
		if (!("availability" in raw)) {
			const legacy = raw as unknown as { exists: boolean; isDirectory: boolean };
			return legacy.exists ? { target, availability: "present", isDirectory: legacy.isDirectory } : { target, availability: "unavailable", code: PROJECT_SERVICE_CODES.statUnavailable };
		}
		const state = raw as ProjectFileStatResult;
		if (state.availability === "present") return { target, availability: "present", isDirectory: state.isDirectory };
		return {
			target,
			availability: state.availability,
			code: state.availability === "missing" ? state.code : (state.code ?? PROJECT_SERVICE_CODES.statUnavailable),
		};
	};
}

function assertTextVersion(expectedVersion: string | undefined): string {
	if (typeof expectedVersion !== "string" || expectedVersion.length === 0) throw new ProjectServiceError(PROJECT_SERVICE_CODES.versionRequired, "rejected", "readText must return a text version before saving");
	return expectedVersion;
}

/**
 * 文本 / 传输 / 系统打开的后端端口：**位置差异只在这里**。
 *
 * provider 本身位置无关——读面、条目写面、失败语义全部走公共 `files:*`（main 内按位置路由）；
 * 这两组通道的形状确实不同（本机文本 version 是内容指纹、远端是令牌；传输与系统打开只有一侧存在），
 * 所以由装配层按位置注入端口，而不是让渲染层挑两个 provider。
 */
export type ProjectFileBackendPorts = {
	readText(target: ProjectFileTarget, options?: { maxBytes?: number }): Promise<ProjectFileText>;
	writeText(target: ProjectFileTarget, content: string, expectedVersion: string | undefined): Promise<ProjectTextSaveReceipt>;
	openInEditor?: ProjectFileService["openInEditor"];
	showInFolder?: ProjectFileService["showInFolder"];
	uploadFiles?: ProjectFileService["uploadFiles"];
	downloadFile?: ProjectFileService["downloadFile"];
};

/** 本机端口：文本走 `files:*`（version = 内容指纹），系统打开可用，传输没有。 */
export function localProjectFilePorts(projectId: string, api: ProjectServicesApi): ProjectFileBackendPorts {
	// 本机通道按 target 身份寻址，不需要 projectId；签名对称只为装配层不必分叉调用形状。
	void projectId;
	return {
		async readText(target, options) {
			return { content: await api.files.readContent(target, options?.maxBytes) };
		},
		async writeText(target, content, expectedVersion): Promise<ProjectTextSaveReceipt> {
			// 本机的 version 是内容指纹（sha256/absent），用来做乐观锁；远端令牌形状仍要显式拒绝，不能静默忽略。
			if (expectedVersion !== undefined && !/^(sha256:[a-f0-9]{64}|absent)$/.test(expectedVersion)) throw unsupported(UNSUPPORTED_DETAIL.localTextVersion);
			await api.files.writeContent(target, content, undefined, expectedVersion);
			return {};
		},
		async openInEditor(target) {
			await api.files.open(target);
		},
		async showInFolder(target) {
			await api.files.showInFolder(target);
		},
	};
}

/** 远端端口：文本走 `remoteHosts` 的令牌化入口，传输走 jobful 通道；系统打开没有本机路径。 */
export function remoteProjectFilePorts(projectId: string, api: ProjectServicesApi): ProjectFileBackendPorts {
	return {
		async readText(target) {
			// 远端正文有 main 自己的 256 KiB 上限；maxBytes 不进入远端协议。
			const value = unwrapOp(await api.remoteHosts.openProjectText(projectId, target.relativePath), PROJECT_SERVICE_CODES.failed);
			return { content: value.document.content, version: value.document.version };
		},
		async writeText(target, content, expectedVersion): Promise<ProjectTextSaveReceipt> {
			// 文本保存只能使用 readText 返回的文本 version；缺失/空串时零调用拒绝。
			// 绝不 statProjectEntry 取 entry 令牌、也不重新 open 覆盖原版本语义。
			const version = assertTextVersion(expectedVersion);
			const saved = unwrapOp(await api.remoteHosts.saveProjectText(projectId, target.relativePath, content, version), PROJECT_SERVICE_CODES.failed);
			if (typeof saved.version !== "string" || saved.version.length === 0) throw new ProjectServiceError(PROJECT_SERVICE_CODES.failed, "unknown", "save returned no text version");
			return { version: saved.version };
		},
		async uploadFiles(target, source, options) {
			return uploadThroughRemoteTransfer(api, projectId, target, source, options);
		},
		async downloadFile(target, options) {
			return downloadThroughRemoteTransfer(api, projectId, target, options);
		},
	};
}

/**
 * 位置无关的文件 provider：读面与条目写面全部走公共 `files:*`，位置差异只剩注入的端口。
 * `createProjectServices` 因此不再按 isRemoteProject 二选一。
 */
export function createProjectFileService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence, ports: ProjectFileBackendPorts): ProjectFileService {
	const service: ProjectFileService = {
		async listDirectory(target, options): Promise<ProjectDirectoryPage> {
			assertProjectTarget(projectId, target);
			return unwrapOp(await api.files.directoryPage(target, options), PROJECT_SERVICE_CODES.failed) as ProjectDirectoryPage;
		},
		searchFiles: createProjectFileSearch(projectId, api),
		searchContent(query) {
			return api.files.searchContent(projectId, query);
		},
		async readText(target, options) {
			assertProjectTarget(projectId, target);
			return ports.readText(target, options);
		},
		async writeText(target, content, expectedVersion): Promise<ProjectTextSaveReceipt> {
			assertProjectTarget(projectId, target);
			return ports.writeText(target, content, expectedVersion);
		},
		stat: createProjectStat(projectId, api),
		async createEntry(parent, name, type): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, parent);
			const created = unwrapOp(await api.files.create(parent, name, type), PROJECT_SERVICE_CODES.failed);
			return { target: readProjectTarget(created, childTarget(parent, name)), kind: type };
		},
		async renameEntry(target, newName): Promise<ProjectEntryReceipt> {
			assertProjectTarget(projectId, target);
			// 乐观锁凭据由 main 现读现用（stat→rename 在同一进程内完成）；调用方不再传令牌/version。
			const renamed = unwrapOp(await api.files.rename(target, newName), PROJECT_SERVICE_CODES.failed);
			return { target: readProjectTarget(renamed, childTarget(target, newName)) };
		},
		moveEntry: (target, destinationRelativePath) => moveProjectEntry(api, projectId, target, destinationRelativePath),
		async deleteEntry(target): Promise<ProjectEntryDeleteReceipt> {
			assertProjectTarget(projectId, target);
			// 远端删除进回收站会带回 trashId；本机没有回收站，收据里就没有这个字段。
			const receipt = unwrapOp(await api.files.delete(target), PROJECT_SERVICE_CODES.failed);
			const trashId = isRecord(receipt) && typeof receipt.trashId === "string" ? receipt.trashId : undefined;
			return { target, ...(trashId === undefined ? {} : { trashId }) };
		},
		async uploadFiles(target, source, options) {
			// 端口缺席 = 这个位置没有传输能力：显式拒绝，绝不静默成功。
			if (ports.uploadFiles === undefined) throw unsupported(UNSUPPORTED_DETAIL.transferUnavailable);
			assertProjectTarget(projectId, target);
			return ports.uploadFiles(target, source, options);
		},
		async downloadFile(target, options) {
			if (ports.downloadFile === undefined) throw unsupported(UNSUPPORTED_DETAIL.transferUnavailable);
			assertProjectTarget(projectId, target);
			return ports.downloadFile(target, options);
		},
		async openInEditor(target) {
			if (ports.openInEditor === undefined) throw unsupported(UNSUPPORTED_DETAIL.fileSystemOpen);
			assertProjectTarget(projectId, target);
			return ports.openInEditor(target);
		},
		async showInFolder(target) {
			if (ports.showInFolder === undefined) throw unsupported(UNSUPPORTED_DETAIL.fileSystemOpen);
			assertProjectTarget(projectId, target);
			return ports.showInFolder(target);
		},
	};
	return fenceProjectFileService(fence, service);
}

export type { ProjectFileService as ProjectFileServiceImpl };
