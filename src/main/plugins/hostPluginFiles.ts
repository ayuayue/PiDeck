/** Bounded local packages: consent applies to exact bytes, not only manifest/version. */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { extname, dirname, isAbsolute, join, relative } from "node:path";
import { isHostPluginAsset, parseHostPluginManifest } from "./hostPluginManifest";
import type { HostPluginManifest } from "../../shared/types/hostPlugin";

export type HostPluginPackage = { root: string; manifest: HostPluginManifest; fingerprint: string; assets: Map<string, string> };
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_FILES = 100;
const MAX_PACKAGE_DEPTH = 8;
export const HOST_PLUGIN_MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".woff2": "font/woff2",
};

/** Resolve every component without allowing directory symlinks or path traversal. */
export async function pluginAssetPath(root: string, asset: string): Promise<string> {
	if (!isHostPluginAsset(asset)) throw new Error("invalid-asset");
	let path = root;
	for (const part of asset.split("/")) {
		path = join(path, part);
		if ((await lstat(path)).isSymbolicLink()) throw new Error("symlink-not-allowed");
	}
	const resolved = await realpath(path);
	const rel = relative(root, resolved);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("asset-outside-package");
	return resolved;
}

/** A fixed buffer prevents a concurrently growing file from exceeding the read budget. */
export async function readPluginFile(root: string, asset: string): Promise<Buffer> {
	const path = await pluginAssetPath(root, asset);
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new Error("asset-too-large");
		const buffer = Buffer.alloc(info.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== info.size) throw new Error("asset-changed");
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Enumerate a complete small package; unsupported executables cannot hide outside the hash. */
export async function readHostPluginPackage(directory: string): Promise<HostPluginPackage> {
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("symlink-not-allowed");
	const root = await realpath(directory);
	const assets = new Map<string, string>();
	let totalBytes = 0;
	// manifest 只读一次：哈希与解析必须消费同一份字节。二次独立读取存在 TOCTOU——
	// 两次读取之间改写 permissions，指纹仍指向旧 manifest，已授权插件会带着新权限复用旧授权。
	let manifestBytes: Buffer | undefined;
	async function visit(prefix: string, depth: number): Promise<void> {
		if (depth > MAX_PACKAGE_DEPTH) throw new Error("package-too-deep");
		const entries = await readdir(join(root, prefix), { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const asset = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error("symlink-not-allowed");
			if (entry.isDirectory()) {
				await visit(asset, depth + 1);
				continue;
			}
			if (!entry.isFile() || !isHostPluginAsset(asset) || assets.size >= MAX_PACKAGE_FILES) throw new Error("invalid-package-file");
			const bytes = await readPluginFile(root, asset);
			totalBytes += bytes.length;
			if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("package-too-large");
			assets.set(asset, createHash("sha256").update(bytes).digest("hex"));
			if (asset === "pideck-plugin.json") manifestBytes = bytes;
		}
	}
	await visit("", 0);
	if (!manifestBytes) throw new Error("missing-manifest");
	const manifest = parseHostPluginManifest(JSON.parse(manifestBytes.toString("utf8")));
	for (const panel of manifest.contributes.panels) if (!assets.has(panel.entry)) throw new Error("missing-panel-entry");
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([...assets]))
		.digest("hex");
	return { root, manifest, fingerprint, assets };
}

/**
 * 把单个包内路径写进暂存目录。嵌套资产（`assets/app.html`）是合法路径，必须逐级建目录，
 * 否则 writeFile 直接 ENOENT —— 归档与目录两个来源共用这一处，避免两边各修一次。
 */
export async function stageHostPluginFile(targetDirectory: string, asset: string, bytes: Buffer): Promise<void> {
	const target = join(targetDirectory, asset);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, bytes);
}

/**
 * 目录包导入：把用户在对话框里选中的来源目录拷进与落位同卷的隐藏临时目录。
 * 目录能携带归档格式里根本不存在的形态，逐条明确定义：
 * - 顶层来源允许是链接（用户指的确实是这个目录，先 realpath 解析一次），包内任何一级符号链接都拒绝；
 * - `.git` 与 `node_modules` 是开发树产物而非包内容：整棵跳过，否则来源是项目根时光遍历就白花代价；
 * - 其余可接受文件照搬（与手工放置/归档导入得到的包内容一致，只跳路径形状本身不合法的条目）：
 *   `isHostPluginAsset` 是路径形状守卫（字符集、无 `..`/空段），扩展名白名单只在服务阶段生效
 *   （`readApprovedPluginAsset` 查 HOST_PLUGIN_MIME）—— 形状不合法的文件既不可能被 manifest 引用
 *   也不可能被服务，直接跳过而不是让整个安装失败（真实开发树里总有带空格的文档/截图）。
 *   单个文件逐个走与安装后同一个 readPluginFile（单文件上限 + 尺寸稳定判定）。
 * 因此落位目录里的文件集是 readHostPluginPackage 接受集合的子集，拷贝本身不会制造 invalid-package-file。
 * 预算在拷贝过程中生效：超限立即失败，不落盘、不留半成品。
 */
export async function copyHostPluginPackage(sourceDirectory: string, targetDirectory: string): Promise<void> {
	const root = await realpath(sourceDirectory);
	await mkdir(targetDirectory, { recursive: true });
	let files = 0;
	let totalBytes = 0;
	async function visit(prefix: string, depth: number): Promise<void> {
		if (depth > MAX_PACKAGE_DEPTH) throw new Error("package-too-deep");
		const entries = await readdir(join(root, prefix), { withFileTypes: true });
		// 稳定顺序：同一来源目录重复导入必须得到同一份按字母序写入的文件集。
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const asset = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error("symlink-not-allowed");
			if (entry.isDirectory()) {
				await visit(asset, depth + 1);
				continue;
			}
			if (!entry.isFile() || !isHostPluginAsset(asset)) continue;
			if (files >= MAX_PACKAGE_FILES) throw new Error("invalid-package-file");
			const bytes = await readPluginFile(root, asset);
			totalBytes += bytes.length;
			if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("package-too-large");
			files += 1;
			await stageHostPluginFile(targetDirectory, asset, bytes);
		}
	}
	await visit("", 0);
}

/** Serving also checks the approved digest: replacing code cannot reuse an old grant. */
export async function readApprovedPluginAsset(plugin: HostPluginPackage, asset: string): Promise<{ bytes: Buffer; mime: string }> {
	const digest = plugin.assets.get(asset);
	const mime = HOST_PLUGIN_MIME[extname(asset).toLowerCase()];
	if (!digest || !mime || asset === "pideck-plugin.json") throw new Error("asset-not-allowed");
	const bytes = await readPluginFile(plugin.root, asset);
	if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("plugin-code-changed");
	return { bytes, mime };
}
