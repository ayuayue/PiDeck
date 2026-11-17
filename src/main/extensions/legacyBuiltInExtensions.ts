import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

/** 链接目录属于用户布置的资源入口，不能因最终文件同名同内容而取得删除权。 */
async function ordinaryDirectories(paths: readonly string[]): Promise<boolean> {
	for (const path of paths) {
		try {
			const entry = await lstat(path);
			if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function regularFile(path: string): Promise<Buffer | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return undefined;
		return await readFile(path);
	} catch {
		return undefined;
	}
}

/**
 * 旧扩展只在内容与当前随包副本完全一致时迁出自动发现目录，并保留可恢复备份。
 * 无法识别的旧版本、已下线文件及用户修改保留原位；文件名不能证明文件归属。
 */
export async function migrateLegacyExtensionCopies(homeDir: string, bundledDir: string, names: readonly string[]): Promise<{ moved: number; preserved: number }> {
	const extensionsDir = join(homeDir, ".pi", "agent", "extensions");
	const backupDir = join(homeDir, ".pi", "agent", "pideck-legacy-extension-backups");
	const parents = [join(homeDir, ".pi"), join(homeDir, ".pi", "agent"), extensionsDir];
	if (!(await ordinaryDirectories(parents))) return { moved: 0, preserved: 0 };
	let moved = 0;
	let preserved = 0;
	for (const name of names) {
		if (!name || basename(name) !== name || name.includes("\\") || name.includes("/")) continue;
		const source = join(extensionsDir, name);
		const content = await regularFile(source);
		if (!content) continue;
		const bundled = await regularFile(join(bundledDir, name));
		if (!bundled || !content.equals(bundled)) {
			preserved += 1;
			continue;
		}
		try {
			await mkdir(backupDir, { recursive: true });
			const backupStat = await lstat(backupDir);
			if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
				preserved += 1;
				continue;
			}
			const digest = createHash("sha256").update(content).digest("hex");
			const backup = join(backupDir, `${name}.${digest}.bak`);
			try {
				await copyFile(source, backup, constants.COPYFILE_EXCL);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			}
			const saved = await regularFile(backup);
			const current = await regularFile(source);
			if (!saved?.equals(content) || !current?.equals(content) || !(await ordinaryDirectories([...parents, backupDir]))) {
				preserved += 1;
				continue;
			}
			await unlink(source);
			moved += 1;
		} catch {
			preserved += 1;
		}
	}
	return { moved, preserved };
}
