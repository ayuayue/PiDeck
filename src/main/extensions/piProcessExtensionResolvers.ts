import { app } from "electron";
import type { AppSettings } from "../../shared/types";
import {
	listActiveBuiltInExtensionPaths,
	type BuiltInExtensionPathRoots,
} from "./builtInExtensions";
import { resolveEnabledExtensionPaths } from "./enabledExtensionResolver";

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
	resolveBuiltInExtensionPaths: (processSettings?: Partial<AppSettings>) => string[];
	resolveEnabledExtensionPaths: (
		processSettings?: Partial<AppSettings>,
	) => string[] | null;
} {
	const builtInRoots: BuiltInExtensionPathRoots = {
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		isDev: !app.isPackaged,
	};
	return {
		resolveBuiltInExtensionPaths: (processSettings) =>
			listActiveBuiltInExtensionPaths(
				builtInRoots,
				processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? [],
			),
		resolveEnabledExtensionPaths: (processSettings) =>
			resolveEnabledExtensionPaths({
				cwd,
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
