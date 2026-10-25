/** Shared filesystem primitives for afterPack cleanup domains. */
const fs = require("node:fs");
const path = require("node:path");

/** Recursively remove a directory. */
async function rmDir(dir) {
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Windows 上刚写盘的文件会被杀软/索引器短暂持有句柄（分享模式不含 DELETE），
 * 此时 rename/unlink 返回 EPERM/EACCES/EBUSY。与 scripts/patch-electron-builder-rename-retry.js
 * 注入 electron-builder 的兜底同参数：有界重试等句柄释放，耗尽后抛原始错误，
 * 不把真实失败（路径错误、权限不足的非瞬时码）掩盖成重试成功。
 */
async function renameWithRetry(from, to, options = {}) {
	const maxAttempts = options.maxAttempts === undefined ? 40 : options.maxAttempts;
	const delayMs = options.delayMs === undefined ? 150 : options.delayMs;
	const rename = options.rename ?? ((source, destination) => fs.promises.rename(source, destination));
	for (let attempt = 1; ; attempt++) {
		try {
			return await rename(from, to);
		} catch (error) {
			const code = error && error.code;
			const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
			if (!transient || attempt >= maxAttempts) throw error;
			console.warn(`  [afterPack] ${to} 被其他进程占用，第 ${attempt}/${maxAttempts} 次重试`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/** Return a directory's file size without failing the packaging cleanup on unreadable entries. */
async function dirSize(dir) {
	let total = 0;
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				total += await dirSize(full);
			} else if (entry.isFile()) {
				total += (await fs.promises.stat(full)).size;
			}
		}
	} catch {
		/* Ignore unreadable cleanup candidates. */
	}
	return total;
}

module.exports = { dirSize, renameWithRetry, rmDir };
