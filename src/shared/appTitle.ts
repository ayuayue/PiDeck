import { resolveAppDisplayName } from "./types/settings";

/**
 * 应用标题（窗口标题栏 / 任务栏 / Alt-Tab / document.title）的唯一拼装规则。
 *
 * 主进程建窗（src/main/index.ts 的 windowOptions.title）与渲染层 document.title 必须走同一份规则：
 * Electron 的原生窗口标题跟随 document.title（page-title-updated），两处各写一套会来回覆盖，
 * 用户改完显示名称看到的是上一个名字。
 *
 * devBranch 只在开发态功能分支隔离时传入（见 index.ts 的 isolateDevByGitBranch），
 * 打包版恒为空串，因此标题就是显示名称本身。
 */
export function composeAppTitle(displayName: string | null | undefined, devBranch?: string | null): string {
	const name = resolveAppDisplayName(displayName);
	const branch = typeof devBranch === "string" ? devBranch.trim() : "";
	return branch === "" ? name : `${name} · ${branch}`;
}
