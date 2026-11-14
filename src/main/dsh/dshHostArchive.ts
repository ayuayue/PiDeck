import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchivedDshSession } from "../../shared/types";
import { foldSessionTitleFromDir } from "./dshForeignSessionScan";
import { pideckArchivePath } from "./pideckDshHome";
import { findDshSessionDir, workspaceDirFor } from "./dshSessionPath";

/**
 * DSH 会话归档 / 恢复 / 删除的宿主协作者：只做 `$DSH_HOME` 下的目录搬移与回收站调用，
 * 不碰 host 进程。路径转换（toHostPath）与回收站回调由宿主传入——WSL 路径只在宿主
 * 那一层转换（见 DshHost.configureWsl 的边界约定）。
 */
export type DshArchiveSessionInput = {
	dshSessionId: string;
	/** 上层传入的项目路径形式（catalog 的 project.path；WSL 项目是 /mnt/...）。 */
	cwd: string;
	/** host 实际使用的 workspace 路径（宿主已按 WSL 环境转换）。 */
	hostCwd: string;
	title?: string;
};

/**
 * 归档 DSH 会话（G14，与 pi 归档同语义：目录移动而非销毁）：
 * 把 host 会话目录移出 sessions 树到 $DSH_HOME/.pideck/archive/<sessionId>，
 * 并写 manifest（记录原 workspace cwd 与会话标题，恢复时移回原位置）。
 * host 重启后 session.list 不再包含该会话（目录已不在 sessions 树）。
 * title 为归档时刻 catalog 里的会话名：不存则恢复/列表只能看到 host id
 * 或退化为日志折叠（见 listArchivedSessions / unarchiveSession）。
 * 返回归档目录路径；会话不存在时返回 undefined。
 */
export async function archiveDshSession(homeDir: string, input: DshArchiveSessionInput): Promise<string | undefined> {
	const { dshSessionId, cwd, hostCwd, title } = input;
	const sourceDir = join(homeDir, "sessions", workspaceDirFor(hostCwd), dshSessionId);
	if (!existsSync(sourceDir)) return undefined;
	const archiveRoot = pideckArchivePath(homeDir);
	const targetDir = join(archiveRoot, dshSessionId);
	mkdirSync(archiveRoot, { recursive: true });
	if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
	renameSync(sourceDir, targetDir);
	writeFileSync(
		join(targetDir, "pideck-manifest.json"),
		JSON.stringify({
			dshSessionId,
			// cwd 保持上层传入的项目路径形式：恢复时 sessionIpc 要按它匹配/注册项目记录
			// （WSL 项目存的是 /mnt/...，换主机路径会让 findByPath 落空并新建重复项目）。
			cwd,
			// host 实际使用的 workspace 路径：恢复时按它还原目录，与当前 WSL 开关无关
			// （归档后关掉 WSL 再恢复也要能移回原位）。
			hostCwd,
			archivedAt: Date.now(),
			// G14+：标题随 manifest 持久化，恢复后列表/会话记录直接可用；
			// 旧归档没有该字段，由读取侧用日志折叠兜底。
			...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
		}),
		"utf8",
	);
	return targetDir;
}

/** 恢复归档的 DSH 会话（G14）：读 manifest 移回原 workspace 目录。返回恢复后的目录、manifest 中的原 cwd 与标题。 */
export async function unarchiveDshSession(homeDir: string, dshSessionId: string, toHostPath: (path: string) => string): Promise<{ restoredPath: string; cwd: string; title?: string } | undefined> {
	const archiveRoot = pideckArchivePath(homeDir);
	const archivedDir = join(archiveRoot, dshSessionId);
	const manifestPath = join(archivedDir, "pideck-manifest.json");
	if (!existsSync(manifestPath)) return undefined;
	let cwd = "";
	let hostCwd = "";
	let title: string | undefined;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cwd?: unknown; hostCwd?: unknown; title?: unknown };
		if (typeof manifest.cwd === "string" && manifest.cwd) cwd = manifest.cwd;
		if (typeof manifest.hostCwd === "string" && manifest.hostCwd) hostCwd = manifest.hostCwd;
		if (typeof manifest.title === "string" && manifest.title.trim()) title = manifest.title.trim();
	} catch {
		// manifest 损坏：无法恢复原位置
		return undefined;
	}
	// 优先用归档时记录的 host 路径（自描述，跨「归档期间切换 WSL 开关」也正确）；
	// 旧 manifest 没有该字段时按当前环境转换，非 WSL 场景转换即原样。
	const targetDir = join(homeDir, "sessions", workspaceDirFor(hostCwd || toHostPath(cwd)), dshSessionId);
	mkdirSync(dirname(targetDir), { recursive: true });
	renameSync(archivedDir, targetDir);
	// 旧归档 manifest 无标题时，从恢复后的会话日志前缀只读折叠补全
	// （与 listArchivedSessions 同源；避免恢复后侧栏落「新会话」占位名）。
	if (!title) title = foldSessionTitleFromDir(targetDir);
	return { restoredPath: targetDir, cwd, ...(title ? { title } : {}) };
}

/**
 * 永久删除已归档的 DSH 会话（区别于恢复）：把归档目录移入系统回收站（经注入的 trashPath）。
 * 幂等：归档目录不存在/非 PiDeck 归档（无 manifest）返回 false；否则删除后返回 true。
 */
export async function deleteArchivedDshSession(homeDir: string, dshSessionId: string, trashPath: (path: string) => Promise<void>): Promise<boolean> {
	const archiveRoot = pideckArchivePath(homeDir);
	const archivedDir = join(archiveRoot, dshSessionId);
	// 只有带 manifest 的目录才算 PiDeck 归档（与 listArchivedSessions 同判定），避免误删非归档目录。
	const manifestPath = join(archivedDir, "pideck-manifest.json");
	if (!existsSync(manifestPath)) return false;
	await trashPath(archivedDir);
	return true;
}

/**
 * 删除活跃 DSH 会话（与 pi 会话删除同语义）：把 host 会话目录移入系统回收站
 * （经注入的 trashPath，可恢复；回收站不可用时抛错，拒绝静默硬删）。
 * DSH 官方没有 session.delete 协议，定位/搬移与 archiveSession 同构（移出 sessions 树），
 * host 重启后 session.list 不再包含该会话。
 * 幂等：目录不存在（已删/已回收）返回 false。
 * @param hostCwd 会话所属 workspace 的 host 视角路径（宿主已转换）；失配时按 sessionId 兜底扫描。
 */
export async function deleteDshSession(homeDir: string, hostCwd: string, dshSessionId: string, trashPath: (path: string) => Promise<void>): Promise<boolean> {
	const target = findDshSessionDir(homeDir, hostCwd, dshSessionId);
	if (!target) return false;
	await trashPath(target);
	return true;
}

/**
 * 归档区中的 DSH 会话清单（G14：恢复入口用；返回 manifest 里的原 workspace cwd、
 * 归档时间与标题）。标题优先 manifest（G14+ 写入）；旧归档缺省时从归档目录的
 * 会话日志前缀只读折叠补全（与外部会话导入同源策略）。
 * manifest 缺失/损坏的目录跳过（无 manifest 不视为 PiDeck 归档）。
 */
/**
 * 2027-02 性能审计改异步：旧归档缺标题时逐目录读 256KiB 日志前缀 + zstd 同步解压，
 * 归档条目多时同步实现把主进程事件循环堵数百 ms（打开归档管理页整窗卡）。
 * 现在每个归档目录处理前让出一轮事件循环；目录遍历走 fs/promises。
 */
export async function listArchivedDshSessions(homeDir: string): Promise<ArchivedDshSession[]> {
	const archiveRoot = pideckArchivePath(homeDir);
	if (!existsSync(archiveRoot)) return [];
	const entries = await readdir(archiveRoot, { withFileTypes: true });
	const listed: ArchivedDshSession[] = [];
	for (const item of entries) {
		if (!item.isDirectory()) continue;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const manifestPath = join(archiveRoot, item.name, "pideck-manifest.json");
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				dshSessionId?: unknown;
				cwd?: unknown;
				archivedAt?: unknown;
				title?: unknown;
			};
			const dshSessionId = typeof manifest.dshSessionId === "string" ? manifest.dshSessionId : item.name;
			// manifest 携带的标题优先（G14+ 归档时刻写入）；旧归档缺省时
			// 从归档目录的日志前缀折叠，避免归档区只能显示裸 host id。
			const manifestTitle = typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : undefined;
			const title = manifestTitle ?? foldSessionTitleFromDir(join(archiveRoot, item.name));
			listed.push({
				dshSessionId,
				cwd: typeof manifest.cwd === "string" ? manifest.cwd : "",
				archivedAt: typeof manifest.archivedAt === "number" ? manifest.archivedAt : 0,
				...(title ? { title } : {}),
			});
		} catch {
			// manifest 缺失/损坏的目录跳过（无 manifest 不视为 PiDeck 归档）
		}
	}
	return listed;
}
