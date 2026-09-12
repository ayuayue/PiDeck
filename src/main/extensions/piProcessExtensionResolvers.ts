import { app } from "electron";
import { basename } from "node:path";
import type { AppSettings } from "../../shared/types";
import {
	listActiveBuiltInExtensionPaths,
	resolveBuiltInExtensionsOverlayDir,
	type BuiltInExtensionPathRoots,
} from "./builtInExtensions";
import { resolveEnabledExtensionPaths } from "./enabledExtensionResolver";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";

/**
 * 为 PiProcess 构造扩展解析器（内置扩展注入 + 白名单枚举）。
 * 返回值可直接展开为 PiProcess 第 4 参 options 的
 * resolveBuiltInExtensionPaths / resolveEnabledExtensionPaths。
 *
 * 为什么共用：AgentManager（会话运行时 RPC）与 PiModelCapabilityCache（模型能力快照）
 * 必须走同一套「哪些扩展加载」的判定，否则选择器可能展示运行时实际不存在的模型
 * （例如用户已禁用的扩展贡献的模型），用户选完才在会话启动时报错。
 */
export function createPiProcessExtensionResolvers(
	cwd: string,
	settings: AppSettings,
): {
	resolveBuiltInExtensionPaths: (
		processSettings?: Partial<AppSettings>,
		includeProjectResources?: boolean,
	) => string[];
	resolveEnabledExtensionPaths: (
		processSettings?: Partial<AppSettings>,
		cwd?: string,
		includeProjectResources?: boolean,
	) => string[] | null;
} {
	const builtInRoots: BuiltInExtensionPathRoots = {
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		isDev: !app.isPackaged,
		// 热更新覆盖层：有热补丁时优先注入它，重启会话即生效（无覆盖层时该字段无影响）
		overlayDir: resolveBuiltInExtensionsOverlayDir(app.getPath("userData")),
	};
	return {
		resolveBuiltInExtensionPaths: (processSettings, includeProjectResources = true) => {
			const disabledForProject = new Set(
				includeProjectResources
					? readProjectResourceOverrides(cwd).disabledGlobalExtensions
					: [],
			);
			return listActiveBuiltInExtensionPaths(
				builtInRoots,
				processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? [],
			).filter((path) => !disabledForProject.has(basename(path)));
		},
		resolveEnabledExtensionPaths: (processSettings, _processCwd, includeProjectResources = true) =>
			resolveEnabledExtensionPaths({
				cwd,
				includeProjectResources,
				disabled:
					processSettings?.disabledExtensions ?? settings.disabledExtensions ?? [],
				removedBuiltInExtensions:
					processSettings?.removedBuiltInExtensions ??
					settings.removedBuiltInExtensions ??
					[],
				builtInRoots,
			}),
	};
}
