/**
 * Git 面板的 localStorage 偏好与缓存（从 `GitPanel.tsx` 原样搬出）。
 *
 * 三类数据各按自己的作用域落盘：ahead/behind 角标与 smart commit 选区按「项目 + 仓库」隔离，
 * 变更列表视图模式是全局观感偏好。全部读写在 try/catch 内静默降级——预览/无存储环境
 * （localStorage 被禁用）只影响持久化，不影响本轮会话内的交互。
 */
import type { GitAheadBehind } from "../../../../../shared/types";
import type { GitChangeViewMode } from "./changeTree";

export type SmartCommitPreference = {
	enableSmartCommit: boolean;
	suggestSmartCommit: boolean;
};

/**
 * push/pull 角标（ahead/behind）持久化 key：按项目 + 仓库隔离。
 *
 * 为什么持久化：角标来自 git fetch 远程 + 对比，属于慢操作（网络往返）。
 * 切会话 tab / 关抽屉再开会让 GitPanel 卸载重挂，若不缓存，每次回来角标都要
 * 从 0 重新等一轮 fetch；缓存后重挂先秒显上次结果，再后台刷新校正。
 */
export function aheadBehindStorageKey(projectId: string, repoScopeKey: string): string {
	return `pideck:git-panel:${projectId}:${encodeURIComponent(repoScopeKey)}:ahead-behind:v1`;
}

/** 读取上次缓存的 ahead/behind 角标；无缓存或格式非法返回 null（视为无角标）。 */
export function readAheadBehindCache(projectId: string, repoScopeKey: string): GitAheadBehind | null {
	try {
		const raw = localStorage.getItem(aheadBehindStorageKey(projectId, repoScopeKey));
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<GitAheadBehind> | null;
		// 只信任数字字段：缓存可能被旧版本/手改损坏，非法时按无缓存处理
		if (value && typeof value.ahead === "number" && Number.isFinite(value.ahead) && typeof value.behind === "number" && Number.isFinite(value.behind)) {
			return { ahead: value.ahead, behind: value.behind };
		}
		return null;
	} catch {
		return null;
	}
}

/** 写入 ahead/behind 角标缓存；存储不可用时静默跳过（本轮会话仍可用）。 */
export function writeAheadBehindCache(projectId: string, repoScopeKey: string, value: GitAheadBehind | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(aheadBehindStorageKey(projectId, repoScopeKey));
			return;
		}
		localStorage.setItem(aheadBehindStorageKey(projectId, repoScopeKey), JSON.stringify(value));
	} catch {
		// 预览/无存储环境不持久化，不影响本轮会话内展示
	}
}

function smartCommitStorageKey(projectId: string): string {
	return `pideck:git-panel:${projectId}:smart-commit:v1`;
}

export function readSmartCommitPreference(projectId: string): SmartCommitPreference {
	try {
		const value = JSON.parse(localStorage.getItem(smartCommitStorageKey(projectId)) ?? "null") as Partial<SmartCommitPreference> | null;
		return {
			enableSmartCommit: value?.enableSmartCommit === true,
			// VS Code defaults suggestSmartCommit to true until the user chooses Never.
			suggestSmartCommit: value?.suggestSmartCommit !== false,
		};
	} catch {
		return { enableSmartCommit: false, suggestSmartCommit: true };
	}
}

export function writeSmartCommitPreference(projectId: string, value: SmartCommitPreference): void {
	try {
		localStorage.setItem(smartCommitStorageKey(projectId), JSON.stringify(value));
	} catch {
		// The choice remains valid for this renderer session when storage is unavailable.
	}
}

/** 变更列表视图模式：全局偏好（不按项目分），同一台机器上各项目共享同一观感 */
const GIT_CHANGES_VIEW_MODE_STORAGE_KEY = "pideck:git-panel:changes-view-mode:v1";

/** 读取变更列表视图模式；无缓存/非法值回落平铺（默认不变观感，升级后与旧版一致，树形需用户主动开启） */
export function readChangesViewMode(): GitChangeViewMode {
	try {
		return localStorage.getItem(GIT_CHANGES_VIEW_MODE_STORAGE_KEY) === "tree" ? "tree" : "flat";
	} catch {
		return "flat";
	}
}

/** 写入视图模式；存储不可用时静默跳过（本轮会话仍生效） */
export function writeChangesViewMode(mode: GitChangeViewMode): void {
	try {
		localStorage.setItem(GIT_CHANGES_VIEW_MODE_STORAGE_KEY, mode);
	} catch {
		// 无存储环境（预览页）只影响持久化
	}
}
