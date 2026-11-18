import { lstatSync, mkdtempSync as createTempDirSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp as createTempDir } from "node:fs/promises";
import { resolve } from "node:path";

const owned = new Map();

/** 只回收当前进程实际创建并登记的根，链接替换/路径变化时保留，绝不按前缀扫删。 */
export function cleanupTempDirs() {
	if (process.env.PIDECK_E2E_KEEP) return;
	for (const [path, identity] of owned) {
		try {
			const info = lstatSync(path);
			if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== identity.canonical || info.ino !== identity.ino || info.dev !== identity.dev) continue;
			const target = resolve(path);
			if (target !== path) continue;
			rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			owned.delete(path);
		} catch (error) {
			if (error.code === "ENOENT") owned.delete(path);
		}
	}
}

// node --test --test-force-exit 也触发同步 exit；不依赖此时已停止的异步事件循环。
process.once("exit", cleanupTempDirs);

/** 兼容 fs.mkdtempSync 的调用形状，已有 finally/t.after 仍负责及时清理；exit 是失败/早退兜底。 */
export function mkdtempSync(prefix, options) {
	const path = createTempDirSync(prefix, options);
	return track(path);
}

/** promises.mkdtemp 的同一生命周期策略，供异步测试直接替换 import。 */
export async function mkdtemp(prefix, options) {
	return track(await createTempDir(prefix, options));
}

function track(path) {
	if (typeof path !== "string") throw new Error("Tracked temp directories require string paths");
	const { ino, dev } = lstatSync(path);
	owned.set(resolve(path), { canonical: realpathSync(path), ino, dev });
	return path;
}
