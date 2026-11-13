import { evaluateUserReadAccess } from "../security/policy";
import { WebServiceManager, type WebServiceDependencies } from "../web/WebServiceManager";
import { WebWorkspaceRoutes } from "../web/WebWorkspaceRoutes";
import type { WebServiceContext } from "./webServiceContext";
import { createWebRuntimeDeps } from "./webServiceDepsRuntime";
import { createWebSurfaceDeps } from "./webServiceDepsWeb";

/**
 * Web 服务启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，行为零变化）：
 * `new WebServiceManager({...})` → 回填单例 → 注入 workspaceRoutes。
 *
 * 依赖对象按原键序由两半拼成（第一部分在前），与搬迁前的对象字面量等价；
 * 之后的 applySettings / 初始探测仍在 index.ts 原位置，顺序不变。
 */
export function startWebService(ctx: WebServiceContext): void {
	const deps: WebServiceDependencies = { ...createWebSurfaceDeps(ctx), ...createWebRuntimeDeps(ctx) };
	ctx.assign({ webServiceManager: new WebServiceManager(deps) });
	startWebServiceRoutes(ctx);
}

/** P1-P3 工作区路由（git/files/prompts/assets）注入，构造顺序在 manager 之后。 */
function startWebServiceRoutes(ctx: WebServiceContext): void {
	const { projectStore, promptManager, gitService, fileSystemService, securityStore, xuePromptManager, skillManager, extensionManager } = ctx;
	ctx.getWebServiceManager().workspaceRoutes = new WebWorkspaceRoutes({
		listProjects: () => projectStore.list(),
		promptTemplates: promptManager,
		git: {
			isGitRepo: (cwd) => gitService.isGitRepo(cwd),
			getBranches: (cwd) => gitService.getBranches(cwd),
			getStatus: (cwd) => gitService.getStatus(cwd),
			getWorkspaceFileDiff: (cwd, group, filePath, maxBytes) => gitService.getWorkspaceFileDiff(cwd, group, filePath, maxBytes),
			getCommitLog: (cwd, options) => gitService.getCommitLog(cwd, options),
		},
		files: {
			listTree: (root, maxDepth, directory) => fileSystemService.listTree(root, maxDepth, directory),
		},
		// Web 端预览项目外文件时的用户意图门：与桌面端「项目外文件链接」同一套安全等级规则
		// （denyDirs > 敏感文件 > 目录边界），ask 由 Web 端弹「只读查看」确认后再带 confirm=1 重请求。
		userReadAccess: (input) => evaluateUserReadAccess(securityStore.getConfig(), input),
		// 提示词库只在 SQLite 库可用时注入（缺库时路由返回 503，前端隐藏入口）
		prompts: xuePromptManager
			? {
					list: (opts) => xuePromptManager.list(opts),
					detail: (slug, category) => xuePromptManager.detail(slug, category),
				}
			: undefined,
		// 技能/扩展资产面板（第二批）：与桌面设置页同源；列表脱敏在路由层做
		assets: {
			listSkills: () => skillManager.list(),
			toggleSkill: (skillPath, enabled) => skillManager.toggle(skillPath, enabled),
			listExtensions: () => extensionManager.list(),
			setExtensionEnabled: (source, enabled, scope, path, projectId) => extensionManager.toggleFromUi(source, enabled, scope, path, projectId),
		},
	});
}
