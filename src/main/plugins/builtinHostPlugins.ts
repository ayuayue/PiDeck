import { join } from "node:path";
import type { BuiltInExtensionPathRoots } from "../extensions/builtInExtensions";

/**
 * 随包内置的宿主插件目录（与内置扩展同一套「开发态走 appPath / 打包态走 resourcesPath」推导）。
 *
 * 目录不存在时 HostPluginManager.seedBuiltin 静默跳过，所以打包漏配 extraResources 只会
 * 少一个示例插件，不会报错——内置插件是可选示例，不是功能依赖。
 */
export function resolveBuiltinHostPluginDirectory(roots: BuiltInExtensionPathRoots): string {
	return roots.isDev ? join(roots.appPath, "resources", "host-plugins") : join(roots.resourcesPath, "host-plugins");
}
