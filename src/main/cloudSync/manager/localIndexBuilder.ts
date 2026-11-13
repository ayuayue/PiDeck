/**
 * 本地 → 云端索引构建域（`buildLocalIndex` 及其拆分/元数据助手）。从 `CloudSyncManager` 原样搬出：
 * 项目/会话/资源分组、catalog 条目、pi auth/models 与 ImageGen 配置的收集与恢复。
 *
 * 宿主只提供三处只读事实（设备标识、内容开关），写入路径与落盘状态仍留在宿主。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionRecord } from "../../../shared/types.ts";
import type { CloudSyncSelectionPreferences, PiDeckSyncIndexV1 } from "../../../shared/types/cloudSync.ts";
import { localProjectPath } from "../../../shared/projectLocation.ts";
import type { CloudSyncInternalResource, CloudSyncInternalSession, CloudSyncScanSnapshot } from "../CloudSyncScanner.ts";
import { CLOUD_SYNC_SCANNER_LIMITS } from "../CloudSyncScanner.ts";
import type { CloudSyncManagerOptions } from "../CloudSyncManager.ts";
import { buildCatalogSyncEntry, buildCloudSyncProject, buildGlobalCloudSyncProject, buildPiDeckSyncIndex, buildSyntheticCloudSyncProject, createSessionRef, createTextFileBundle, extractExtensionSources, GLOBAL_SYNC_PROJECT_ID, toPortableRelativePath, type CloudSyncProjectOptions } from "../payload.ts";
import { ensureNoSymlinkEscape, hashDshSessionText, hashFile, readTextBounded, writeFileAtomic } from "./objectIo.ts";

/** 索引构建域的窄接口：全是宿主已有单一事实的只读入口（不引入新状态）。 */
export interface CloudSyncLocalIndexHost {
	deviceId(): string;
	deviceName(): string;
	/** 当前的内容分类开关（state.selection.content）。 */
	selectionContent(): CloudSyncSelectionPreferences["content"];
}

export class CloudSyncLocalIndexBuilder {
	private readonly host: CloudSyncLocalIndexHost;
	private readonly options: CloudSyncManagerOptions;

	constructor(host: CloudSyncLocalIndexHost, options: CloudSyncManagerOptions) {
		this.host = host;
		this.options = options;
	}

	async build(scan: CloudSyncScanSnapshot, selectedSessions: CloudSyncInternalSession[], selectedResources: CloudSyncInternalResource[]): Promise<PiDeckSyncIndexV1> {
		const settings = this.options.getDesktopSettings();
		const content = this.host.selectionContent();
		const sessionsByProject = new Map<string, CloudSyncInternalSession[]>();
		for (const item of selectedSessions) {
			// DSH 会话按扫描器解析出的所属项目归组（cwd/catalog 匹配），不再单列 __dsh__ 合成节点。
			const group = item.candidate.scope === "project" || item.candidate.scope === "dsh" ? item.candidate.projectId : GLOBAL_SYNC_PROJECT_ID;
			const list = sessionsByProject.get(group) ?? [];
			list.push(item);
			sessionsByProject.set(group, list);
		}
		const resourcesByProject = new Map<string, CloudSyncInternalResource[]>();
		for (const item of selectedResources) {
			const list = resourcesByProject.get(item.candidate.projectId) ?? [];
			list.push(item);
			resourcesByProject.set(item.candidate.projectId, list);
		}

		const projects: PiDeckSyncIndexV1["projects"] = [];
		const emittedProjectIds = new Set<string>([GLOBAL_SYNC_PROJECT_ID]);
		for (const project of this.options.listProjects()) {
			emittedProjectIds.add(project.id);
			const sessions = sessionsByProject.get(project.id) ?? [];
			const resources = resourcesByProject.get(project.id) ?? [];
			const options: CloudSyncProjectOptions = {};
			const resourceBundles = await this.buildResourceBundles(resources);
			if (Object.keys(resourceBundles).length > 0 || content.prompts || content.skills || content.extensions) {
				options.resources = resourceBundles;
			}
			if (sessions.length > 0) {
				options.sessions = await Promise.all(sessions.map((item) => this.buildSessionRef(item)));
				if (content.catalog) {
					options.catalogEntries = sessions
						.map((item) => scan.recordsBySessionId.get(item.candidate.sessionId))
						.filter((record): record is SessionRecord => Boolean(record))
						.map((record) => buildCatalogSyncEntry(record, this.relativePathOf(record, project.id)));
				}
			}
			projects.push(buildCloudSyncProject(project, options));
		}
		// Global root: resources (global prompts/skills/extensions) + global sessions.
		const globalSessions = sessionsByProject.get(GLOBAL_SYNC_PROJECT_ID) ?? [];
		const globalResources = resourcesByProject.get(GLOBAL_SYNC_PROJECT_ID) ?? [];
		const globalOptions: CloudSyncProjectOptions = {};
		const globalBundles = await this.buildResourceBundles(globalResources);
		if (Object.keys(globalBundles).length > 0) globalOptions.resources = globalBundles;
		if (globalSessions.length > 0) {
			globalOptions.sessions = await Promise.all(globalSessions.map((item) => this.buildSessionRef(item)));
			if (content.catalog) {
				globalOptions.catalogEntries = globalSessions
					.map((item) => scan.recordsBySessionId.get(item.candidate.sessionId))
					.filter((record): record is SessionRecord => Boolean(record))
					.map((record) => buildCatalogSyncEntry(record, this.relativePathOf(record, GLOBAL_SYNC_PROJECT_ID)));
			}
		}
		projects.unshift(buildGlobalCloudSyncProject(globalOptions));
		// 本机未注册项目的会话（DSH 工作区合成节点等）：按扫描树里的节点名发出，保持「以项目组织」。
		for (const [projectId, sessions] of sessionsByProject) {
			if (emittedProjectIds.has(projectId) || sessions.length === 0) continue;
			const nodeName = scan.tree.projects.find((node) => node.projectId === projectId)?.name ?? projectId;
			projects.push(
				buildSyntheticCloudSyncProject(projectId, nodeName, {
					sessions: await Promise.all(sessions.map((item) => this.buildSessionRef(item))),
				}),
			);
		}

		const pi = await this.buildPiSyncContent(content);
		const imageGen = await this.buildImageGenContent(content);
		return buildPiDeckSyncIndex({
			deviceId: this.host.deviceId(),
			deviceName: this.host.deviceName(),
			appVersion: this.options.appVersion,
			syncedAt: Date.now(),
			...(content.desktopSettings ? { settings } : {}),
			...(pi ? { pi } : {}),
			...(imageGen ? { imageGen } : {}),
			projects,
		});
	}

	/** M8：按分类开关收集 pi 模型配置与认证（密钥进加密载荷，默认开）。 */
	private async buildPiSyncContent(content: CloudSyncSelectionPreferences["content"]): Promise<PiDeckSyncIndexV1["pi"] | undefined> {
		const pi: PiDeckSyncIndexV1["pi"] = {};
		const agentDir = join(this.options.homeDir, ".pi", "agent");
		if (content.piCredentials) {
			const auth = await this.readJsonFile(join(agentDir, "auth.json"));
			if (auth) pi.auth = auth as NonNullable<PiDeckSyncIndexV1["pi"]>["auth"];
		}
		if (content.piModels) {
			const models = await this.readJsonFile(join(agentDir, "models.json"));
			if (models) pi.models = models as NonNullable<PiDeckSyncIndexV1["pi"]>["models"];
		}
		return Object.keys(pi).length > 0 ? pi : undefined;
	}

	/** M8：生图配置（imagegen.json，含 apiKey）随分类开关同步。 */
	private async buildImageGenContent(content: CloudSyncSelectionPreferences["content"]): Promise<PiDeckSyncIndexV1["imageGen"] | undefined> {
		if (!content.imageGen) return undefined;
		const imageGen = await this.readJsonFile(join(this.options.userDataDir, "imagegen.json"));
		if (!imageGen) return undefined;
		return imageGen as PiDeckSyncIndexV1["imageGen"];
	}

	private async readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
		try {
			const raw = await readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	/** M8：按分类开关恢复 pi auth/models 与 ImageGen 配置（本地优先，缺失取远端）。 */
	async restoreSensitiveContent(merged: PiDeckSyncIndexV1, remote: PiDeckSyncIndexV1): Promise<void> {
		const content = this.host.selectionContent();
		const agentDir = join(this.options.homeDir, ".pi", "agent");
		if (content.piCredentials) {
			const auth = merged.pi?.auth ?? remote.pi?.auth;
			if (auth) await this.writeJsonSafe(join(agentDir, "auth.json"), auth);
		}
		if (content.piModels) {
			const models = merged.pi?.models ?? remote.pi?.models;
			if (models) await this.writeJsonSafe(join(agentDir, "models.json"), models);
		}
		if (content.imageGen) {
			const imageGen = merged.imageGen ?? remote.imageGen;
			if (imageGen) await this.writeJsonSafe(join(this.options.userDataDir, "imagegen.json"), imageGen);
		}
	}

	private async writeJsonSafe(filePath: string, value: unknown): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		await ensureNoSymlinkEscape(dirname(filePath), filePath);
		await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
	}

	private async buildSessionRef(item: CloudSyncInternalSession): Promise<import("../../../shared/types/cloudSync.ts").CloudSyncSessionRef> {
		// DSH 会话：hash 基于解压后文本（与上传/恢复一致）。
		const contentHash = item.candidate.scope === "dsh" ? await hashDshSessionText(item.filePath) : await hashFile(item.filePath);
		return createSessionRef({
			sessionId: item.candidate.sessionId,
			scope: item.candidate.scope,
			...(item.candidate.projectId && (item.candidate.scope === "project" || item.candidate.scope === "dsh") ? { projectId: item.candidate.projectId } : {}),
			filePath: item.filePath,
			rootPath: item.rootPath,
			size: item.candidate.size,
			mtimeMs: item.candidate.mtimeMs,
			contentHash,
		});
	}

	private async buildResourceBundles(resources: CloudSyncInternalResource[]): Promise<NonNullable<import("../../../shared/types/cloudSync.ts").CloudSyncProject["resources"]>> {
		const result: NonNullable<import("../../../shared/types/cloudSync.ts").CloudSyncProject["resources"]> = {};
		const byCategory = new Map<string, CloudSyncInternalResource[]>();
		for (const item of resources) {
			const list = byCategory.get(item.candidate.category) ?? [];
			list.push(item);
			byCategory.set(item.candidate.category, list);
		}
		const settingsItems = byCategory.get("settings") ?? [];
		if (settingsItems.length > 0) {
			const content = await readTextBounded(settingsItems[0].filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				result.piSettings = parsed;
				// 包扩展声明：结构化为 extensionSources，便于恢复时按声明安装。
				const sources = extractExtensionSources(parsed, settingsItems[0].candidate.projectId === GLOBAL_SYNC_PROJECT_ID ? "user" : "project");
				if (sources.length > 0) result.extensionSources = sources;
			} catch {
				// A broken local settings.json is skipped rather than crashing the sync.
			}
		}
		for (const [category, items] of byCategory) {
			if (category === "settings") continue;
			const bundles = [];
			for (const item of items) {
				const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
				bundles.push(createTextFileBundle(item.candidate.relativePath, content));
			}
			if (category === "prompts") result.prompts = bundles;
			else if (category === "skills") result.skills = bundles;
			else if (category === "extensions") result.localExtensions = bundles;
			else if (category === "config") result.config = bundles;
		}
		return result;
	}

	private relativePathOf(record: SessionRecord, projectId: string): string | undefined {
		if (!record.filePath) return undefined;
		try {
			if (projectId === GLOBAL_SYNC_PROJECT_ID) {
				return toPortableRelativePath(join(this.options.homeDir, ".pi", "agent", "sessions"), record.filePath);
			}
			const project = this.options.listProjects().find((candidate) => candidate.id === projectId);
			if (!project) return undefined;
			const projectPath = localProjectPath(project);
			if (!projectPath) return undefined;
			return toPortableRelativePath(join(projectPath, ".pi", "sessions"), record.filePath);
		} catch {
			return undefined;
		}
	}
}
