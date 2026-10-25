import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USER_DATA_NAME_MIGRATION_STATE_FILE = "user-data-name-migration.json";
const MIGRATION_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024;

/** 完成状态只对这一组目录有效，复制到别的环境或迁移版本变化后必须重新核验。 */
export type UserDataMigrationContext = {
	oldRoot: string;
	newRoot: string;
	sessionsRoot: string;
	platform: NodeJS.Platform;
};

/** 可选路径不存在无需迁移；权限/磁盘错误不能当作不存在而记录完成。 */
export function isMissingMigrationPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** 读取本身也有硬上界，不能只依赖 stat：检查后文件可能被另一进程放大或替换。 */
function readState(path: string): unknown {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return null;
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const bytes = readSync(fd, buffer, length, buffer.length - length, length);
			if (bytes === 0) break;
			length += bytes;
		}
		return length > MAX_STATE_BYTES ? null : JSON.parse(buffer.toString("utf8", 0, length));
	} finally {
		closeSync(fd);
	}
}

/** 有界读取专用完成记录；缺失、损坏、异地复制或版本不符均回到幂等核验。 */
export function isUserDataMigrationComplete(context: UserDataMigrationContext): boolean {
	try {
		const state = readState(join(context.newRoot, USER_DATA_NAME_MIGRATION_STATE_FILE));
		return (
			state !== null &&
			typeof state === "object" &&
			"schemaVersion" in state &&
			state.schemaVersion === 1 &&
			"migrationVersion" in state &&
			state.migrationVersion === MIGRATION_VERSION &&
			"status" in state &&
			state.status === "completed" &&
			"oldRoot" in state &&
			state.oldRoot === context.oldRoot &&
			"newRoot" in state &&
			state.newRoot === context.newRoot &&
			"sessionsRoot" in state &&
			state.sessionsRoot === context.sessionsRoot &&
			"platform" in state &&
			state.platform === context.platform &&
			"completedAt" in state &&
			typeof state.completedAt === "string"
		);
	} catch {
		return false;
	}
}

/** 只在全部步骤成功后调用；先持久化独占临时文件，再原子发布，失败不留假完成记录。 */
export function recordUserDataMigrationComplete(context: UserDataMigrationContext): void {
	const path = join(context.newRoot, USER_DATA_NAME_MIGRATION_STATE_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	let published = false;
	try {
		const state = { schemaVersion: 1, migrationVersion: MIGRATION_VERSION, status: "completed", ...context, completedAt: new Date().toISOString() };
		const serialized = JSON.stringify(state, null, 2);
		if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Migration completion record exceeds size limit");
		writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
		renameSync(temporary, path);
		published = true;
	} finally {
		if (!published) rmSync(temporary, { force: true });
	}
}
