/**
 * DSH Team 条的折叠偏好（localStorage，跨会话共享）。
 *
 * 为什么不复用 ComposerWidgetLayout 的内存 map：那份状态挂在每个 ComposerArea 的
 * ComposerMeasuredExtras 里，切换会话/面板重挂后 map 为空，Team 条会回到默认展开
 * （用户反馈：「折叠了，切换之后又默认展开」）。Team 是全局 UI 偏好——所有会话、
 * 重启后都应保持用户上次的选择，因此单独落盘。
 *
 * 默认展开：只有「从未设置过」时才为 false；用户手动折叠后写 true。
 * 存储不可用（隐私模式 / localStorage 抛 SecurityError / 无 window）时静默回退默认值，
 * 失败不能影响输入框渲染（与仓库其他 localStorage 偏好的 fail-safe 一致）。
 */

/** ComposerWidgetLayout 的稳定 key：跨会话共享（不含 sessionId）。 */
export const TEAM_WIDGET_KEY = "team";
export const TEAM_COLLAPSED_STORAGE_KEY = "pideck:session-team-collapsed";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

/** 读取 window.localStorage；隐私模式/受限环境访问即抛错，统一降级为 null。 */
function defaultStorage(): Storage | null {
	try {
		if (typeof window === "undefined") return null;
		return window.localStorage;
	} catch {
		return null;
	}
}

/** 读取 Team 条折叠偏好（true = 折叠）。默认展开（false）。 */
export function readTeamCollapsedPreference(storage: ReadableStorage | null = defaultStorage()): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(TEAM_COLLAPSED_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

/** 写入 Team 条折叠偏好；写失败（配额/禁用存储）只影响记忆，不阻塞交互。 */
export function writeTeamCollapsedPreference(collapsed: boolean, storage: WritableStorage | null = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.setItem(TEAM_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
	} catch {
		// 隐私模式/配额超限：保持默认展开，不影响输入框。
	}
}
