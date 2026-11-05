/**
 * 宿主插件包的统一挑选与预算：GitHub tar 与 AtomGit 文件列表共用同一份口径。
 *
 * 输入是**已去掉仓库容器前缀**的相对路径（GitHub 的 `<repo>-<ref>/`、AtomGit 的包根由调用方先剥）。
 * 这里只做纯数据判断：找 `pideck-plugin.json` 所在的包根（取最浅的一层，多层同深即歧义）、
 * 只保留包根下的文件、施加与 `.pideck-plugin` 归档一致的逐文件/整包预算。
 * 不读网络、不落盘、不校验 manifest 内容——信任判定仍归 `HostPluginManager.installFiles`。
 */
import type { HostPluginArchiveFile } from "./hostPluginArchive";
import { isHostPluginAsset } from "./hostPluginManifest";

export const MANIFEST_FILE = "pideck-plugin.json";
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 100;
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/**
 * 从一组相对路径文件里选出插件包。
 * `subpath` 是仓库内的子目录：给了就只在该目录下找包根，返回的路径都相对包根。
 */
export function selectHostPluginPackage(files: readonly HostPluginArchiveFile[], subpath?: string): HostPluginArchiveFile[] {
	const relative = new Map<string, Buffer>();
	for (const file of files) {
		let path = file.path;
		if (path.startsWith("/")) continue;
		if (subpath) {
			if (path !== subpath && !path.startsWith(`${subpath}/`)) continue;
			path = path.slice(subpath.length).replace(/^\//, "");
			if (!path) continue;
		}
		if (isHostPluginAsset(path)) relative.set(path, file.bytes);
	}
	const roots = [...relative.keys()].filter((path) => path === MANIFEST_FILE || path.endsWith(`/${MANIFEST_FILE}`)).map((path) => path.slice(0, path.length - MANIFEST_FILE.length));
	if (roots.length === 0) throw new Error("missing-manifest");
	const shallowest = Math.min(...roots.map((root) => (root.length === 0 ? 0 : root.split("/").length)));
	const candidates = roots.filter((root) => (root.length === 0 ? 0 : root.split("/").length) === shallowest);
	if (candidates.length > 1) throw new Error("plugin-manifest-ambiguous");
	const root = candidates[0];
	const collected: HostPluginArchiveFile[] = [];
	let total = 0;
	for (const [path, bytes] of relative) {
		if (root && !path.startsWith(root)) continue;
		const asset = root ? path.slice(root.length) : path;
		if (!asset || !isHostPluginAsset(asset)) continue;
		if (bytes.length > MAX_ASSET_BYTES) throw new Error("asset-too-large");
		if (collected.length >= MAX_PACKAGE_FILES) throw new Error("package-too-large");
		total += bytes.length;
		if (total > MAX_PACKAGE_BYTES) throw new Error("package-too-large");
		collected.push({ path: asset, bytes });
	}
	return collected;
}
