/** Bounded local packages: consent applies to exact bytes, not only manifest/version. */
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { isHostPluginAsset, parseHostPluginManifest } from "./hostPluginManifest";
import type { HostPluginManifest } from "../../shared/types/hostPlugin";

export type HostPluginPackage = { root: string; manifest: HostPluginManifest; fingerprint: string; assets: Map<string, string> };
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
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
		if (depth > 8) throw new Error("package-too-deep");
		const entries = await readdir(join(root, prefix), { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const asset = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error("symlink-not-allowed");
			if (entry.isDirectory()) {
				await visit(asset, depth + 1);
				continue;
			}
			if (!entry.isFile() || !isHostPluginAsset(asset) || assets.size >= 100) throw new Error("invalid-package-file");
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

/** Serving also checks the approved digest: replacing code cannot reuse an old grant. */
export async function readApprovedPluginAsset(plugin: HostPluginPackage, asset: string): Promise<{ bytes: Buffer; mime: string }> {
	const digest = plugin.assets.get(asset);
	const mime = HOST_PLUGIN_MIME[extname(asset).toLowerCase()];
	if (!digest || !mime || asset === "pideck-plugin.json") throw new Error("asset-not-allowed");
	const bytes = await readPluginFile(plugin.root, asset);
	if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("plugin-code-changed");
	return { bytes, mime };
}
