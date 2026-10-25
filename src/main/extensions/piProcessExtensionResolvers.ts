import { app } from "electron";
import { basename } from "node:path";
import type { AppSettings } from "../../shared/types";
import { INTERNAL_BUILT_IN_EXTENSIONS, listActiveBuiltInExtensionPaths, resolveBuiltInExtensionsOverlayDir, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";

/**
 * 为 PiProcess 构造「PiDeck 自带扩展」注入解析器。
 *
 * 普通扩展（用户安装的 packages / 本地文件扩展）的启停已交给 pi 原生
 * `settings.json` 过滤规则，PiDeck 不再注入 `--no-extensions` + 全量 `-e` 白名单；
 * 这里只负责把随包分发的 PiDeck 扩展（`pi-deck-*.ts`）以 `-e` 附加到会话上。
 *
 * 为什么共用：AgentManager（会话运行时 RPC）与 PiModelCapabilityCache（模型能力快照）
 * 必须走同一套「哪些自带扩展加载」的判定，否则选择器可能展示运行时实际不存在的模型。
 */
export function createPiProcessExtensionResolvers(
	cwd: string,
	settings: AppSettings,
): {
	resolveBuiltInExtensionPaths: (processSettings?: Partial<AppSettings>, includeProjectResources?: boolean) => string[];
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
			const disabledForProject = new Set(includeProjectResources ? readProjectResourceOverrides(cwd).disabledGlobalExtensions : []);
			return listActiveBuiltInExtensionPaths(builtInRoots, processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? []).filter((path) => {
				const name = basename(path);
				return (INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(name) || !disabledForProject.has(name);
			});
		},
	};
}
