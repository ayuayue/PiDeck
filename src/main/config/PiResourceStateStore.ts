/**
 * PiDeck 侧的迁移状态与整包恢复快照存储（计划 A3）。
 *
 * **启动路径永远不读它决定资源是否加载**：当前 pi 原生配置才是唯一真值。
 * 本存储只承载两类辅助信息：
 * 1. 旧禁用记录迁移进度（哪些作用域/记录已安全迁移）；
 * 2. 整包停用前的过滤快照与 after 指纹（用于「启用时恢复先前选择」）。
 *
 * 文件：`<userData>/pi-native-resources.json`。写入是原子的（tmp + rename），
 * 读取失败降级为空状态（不能因为辅助状态损坏阻塞 pi 启动）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PackageFilterSnapshot } from "./piResourceRules";

export type PackageSnapshotRecord = {
	/** 停用前的四类过滤（缺键 = 原来就没有该类过滤）。 */
	before: PackageFilterSnapshot;
	/** 停用后的指纹（重新启用/恢复前校验外部是否改过）。 */
	after: string;
	createdAt: number;
	/** 停用前是纯字符串形态（"npm:foo"）：恢复时回到字符串而不是空对象。 */
	plainString?: boolean;
};

export type ResourceMigrationRecord = {
	/** 迁移完成时间。 */
	completedAt: number;
	/** 本次迁移写入的文件 revision（便于诊断）。 */
	revisions: Record<string, string>;
	/** 无法映射、留给用户处理的旧记录摘要。 */
	unresolved: string[];
};

export type PiResourceStateFile = {
	version: 1;
	/** key = `<settingsPath>\u0000<packageSource>`。 */
	packageSnapshots: Record<string, PackageSnapshotRecord>;
	/** key = 作用域键（settingsPath 或 `project:<projectId>`）。 */
	migrations: Record<string, ResourceMigrationRecord>;
};

/**
 * 每次返回**全新对象**：曾用浅拷贝共享嵌套对象，导致一个实例的迁移记录
 * 泄漏到同进程内文件缺失状态下的另一个实例（测试已复现）。
 */
function emptyState(): PiResourceStateFile {
	return { version: 1, packageSnapshots: {}, migrations: {} };
}

export function packageSnapshotFingerprint(entry: unknown): string {
	const shape = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
	const parts: string[] = [];
	for (const kind of ["extensions", "skills", "prompts", "themes"]) {
		const value = shape[kind];
		parts.push(`${kind}=${Array.isArray(value) ? JSON.stringify(value) : "<none>"}`);
	}
	return parts.join("|");
}

export class PiResourceStateStore {
	constructor(private readonly filePath: string) {}

	/** 停用前快照的 key：同一文件的同一包身份。 */
	packageKey(settingsPath: string, packageSource: string): string {
		return `${settingsPath}\u0000${packageSource}`;
	}

	read(): PiResourceStateFile {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
			const shape = parsed as Partial<PiResourceStateFile>;
			return {
				version: 1,
				packageSnapshots: shape.packageSnapshots && typeof shape.packageSnapshots === "object" ? { ...shape.packageSnapshots } : {},
				migrations: shape.migrations && typeof shape.migrations === "object" ? { ...shape.migrations } : {},
			};
		} catch {
			return emptyState();
		}
	}

	private write(next: PiResourceStateFile): void {
		try {
			if (!existsSync(dirname(this.filePath))) mkdirSync(dirname(this.filePath), { recursive: true });
			const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
			renameSync(temporary, this.filePath);
		} catch {
			// 辅助状态写失败不影响主流程：下次再试。
		}
	}

	/** 保存整包停用前的过滤；已有快照不覆盖（幂等，避免用停用后的状态当"原始值"）。 */
	savePackageSnapshot(key: string, before: PackageFilterSnapshot, options: { plainString?: boolean } = {}): void {
		const state = this.read();
		if (state.packageSnapshots[key]) return;
		state.packageSnapshots[key] = { before, after: "", createdAt: Date.now(), ...(options.plainString ? { plainString: true } : {}) };
		this.write(state);
	}

	/** 快照是否记录了「停用前是纯字符串形态」。 */
	isPackageSnapshotPlainString(key: string): boolean {
		return Boolean(this.read().packageSnapshots[key]?.plainString);
	}

	/** 记录停用后的指纹（写在成功停用之后）。 */
	markPackageSnapshotAfter(key: string, entry: unknown): void {
		const state = this.read();
		const record = state.packageSnapshots[key];
		if (!record) return;
		record.after = packageSnapshotFingerprint(entry);
		this.write(state);
	}

	/** 取出快照用于恢复（不删除；调用方在成功后显式 clear）。 */
	takePackageSnapshot(key: string): PackageFilterSnapshot | undefined {
		const record = this.read().packageSnapshots[key];
		return record ? { ...record.before } : undefined;
	}

	/** 恢复是否仍然安全：外部在停用后又改过过滤时不能悄悄用旧快照覆盖。 */
	isPackageSnapshotCurrent(key: string, currentEntry: unknown): boolean {
		const record = this.read().packageSnapshots[key];
		if (!record || !record.after) return false;
		return record.after === packageSnapshotFingerprint(currentEntry);
	}

	clearPackageSnapshot(key: string): void {
		const state = this.read();
		if (!(key in state.packageSnapshots)) return;
		delete state.packageSnapshots[key];
		this.write(state);
	}

	/** 迁移进度记录（A3）。 */
	recordMigration(key: string, record: ResourceMigrationRecord): void {
		const state = this.read();
		state.migrations[key] = record;
		this.write(state);
	}

	readMigration(key: string): ResourceMigrationRecord | undefined {
		return this.read().migrations[key];
	}
}

/** 默认状态文件路径（userData 由主进程注入）。 */
export function defaultPiResourceStatePath(userDataDir: string): string {
	return join(userDataDir, "pi-native-resources.json");
}
