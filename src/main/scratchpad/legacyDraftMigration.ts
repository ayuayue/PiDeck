import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 旧便签的时间戳名称；冲突时使用内容指纹，重试收敛到同一份副本。 */
function legacyDraftName(mtimeMs: number): string {
	const ts = new Date(mtimeMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 已存在的完整普通副本可复用（覆盖 copy 成功、源 unlink 失败的窗口）。 */
async function identicalCopy(path: string, content: Buffer): Promise<boolean> {
	try {
		const entry = await lstat(path);
		return entry.isFile() && !entry.isSymbolicLink() && entry.size === content.length && (await readFile(path)).equals(content);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

/**
 * 只迁移普通旧文件；目标独占发布且永不覆盖。失败保留源文件，下一次访问可重试。
 * 同目录临时文件写完后 link 发布，避免草稿列表读到半截副本。
 */
export async function migrateLegacyDraft(userDataDir: string): Promise<void> {
	const draftsDir = join(userDataDir, "drafts");
	await mkdir(draftsDir, { recursive: true });
	const directory = await lstat(draftsDir);
	if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Draft migration requires a regular drafts directory");
	const source = join(userDataDir, "scratch-pad.md");
	let entry;
	try {
		entry = await lstat(source);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	if (!entry.isFile() || entry.isSymbolicLink()) return;
	const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let content: Buffer;
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) return;
		content = await handle.readFile();
	} finally {
		await handle.close();
	}
	if (content.length === 0) return; // 空文件不是用户内容，保留也不会反复产生草稿。
	const name = legacyDraftName(entry.mtimeMs);
	const digest = createHash("sha256").update(content).digest("hex");
	const candidates = [join(draftsDir, `${name}.md`), join(draftsDir, `${name} legacy-${digest.slice(0, 16)}.md`)];
	let published = false;
	for (const target of candidates) {
		if (await identicalCopy(target, content)) {
			published = true;
			break;
		}
		const temporary = join(draftsDir, `.legacy-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
			await link(temporary, target); // EEXIST 包括链接/目录，绝不覆盖。
			published = true;
			break;
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			if (await identicalCopy(target, content)) {
				published = true;
				break;
			}
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
	if (!published) throw new Error("Legacy draft migration conflict; source retained");
	// 复制期间被旧 writer 改过或替换时保留源；下一次会生成它的新内容副本。
	const current = await lstat(source);
	if (current.isFile() && !current.isSymbolicLink() && current.ino === entry.ino && current.dev === entry.dev && current.size === entry.size && current.mtimeMs === entry.mtimeMs && (await readFile(source)).equals(content)) await unlink(source);
}
