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
 * 此时 rename/unlink 返回 EPERM/EACCES/EBUSY。afterPack 自己的文件替换使用
 * 有界重试等句柄释放，耗尽后抛原始错误；解压目录移动由上游 electron-builder 处理，
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

/**
 * 替换一个**可能被长期持有**的目标文件（典型：IDE 的工作区索引器）。
 *
 * 索引器常在打包产物刚出现时打开 app.asar，并一直持有到进程退出；这类句柄分享 READ/WRITE 但不含
 * DELETE，于是 rename 永远 EPERM，重试多少次都没用，而原地覆写完全合法。构建产物没有自家读者，
 * 覆写得到的字节与 rename 完全一致，因此耗尽重试后降级为 copy + unlink 源文件。
 * 非瞬时错误（ENOENT、只读文件系统等）仍然原样抛出，不掩盖真实失败。
 */
async function replaceFileWithRetry(from, to, options = {}) {
	try {
		await renameWithRetry(from, to, options);
		return;
	} catch (error) {
		const code = error && error.code;
		if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
		console.warn(`  [afterPack] ${to} rename 被占用，改为原地覆写`);
		await (options.copyFile ?? ((source, destination) => fs.promises.copyFile(source, destination)))(from, to);
		await fs.promises.rm(from, { force: true });
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

module.exports = { dirSize, renameWithRetry, replaceFileWithRetry, rmDir };
