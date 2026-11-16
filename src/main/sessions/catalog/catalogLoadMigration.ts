import { looksLikePiSessionFileStem } from "../../../shared/sessionIdentity";
import type { SessionCatalogEntry, SessionFilePathResolver, SessionTitleFetcher } from "../SessionCatalog";
import { repairSessionCatalogIdentities } from "../sessionCatalogIdentityRepair";
import { isPlaceholderCatalogTitle } from "./catalogTitleOwnership";

/**
 * 加载期存量归一（版本迁移）：把  里的内存归一化步骤原样搬出来，逻辑、顺序、注释都不变。
 * 依赖只有三项（派生身份键、路径归一化、标题读取），宿主仍持有 map 与落盘事务。
 */
export type LoadedCatalogMigrationDeps = {
	readonly originKeyForEntry: (entry: SessionCatalogEntry) => string | undefined;
	readonly resolveFilePath: SessionFilePathResolver | undefined;
	readonly fetchTitle: SessionTitleFetcher | undefined;
};

export async function migrateLoadedCatalogEntries(loaded: SessionCatalogEntry[], deps: LoadedCatalogMigrationDeps): Promise<{ entries: SessionCatalogEntry[]; migrated: boolean }> {
	let entries = loaded;
	// Draft 只代表当前进程中的“尚未发送”编辑面：没有用户消息就没有
	// 可恢复的 Pi session。重启时清掉它们（仅限 pi 后端），避免空 Agent 在
	// 历史列表中永久残留。
	// 例外：DSH 会话的草稿必须保留。DSH 的 host 会话数据由 $DSH_HOME 持久化，
	// catalog 只是 id 映射；即使“创建后激活链路未走完”（attachRuntime 未把
	// status 置 active），重启后用户仍应在侧栏看到并重新激活它。若在此清掉，
	// host 侧会话会变成孤儿且无法从侧栏访问。带 dshSessionId 的异常中间态同样保留。
	/** 本次加载是否改动了内容：决定要不要走一次归一化写事务（没改就一个字节都不写）。 */
	let migrated = false;
	// ACP 同理（StaleDraftReaper 的 acp 豁免、Coordinator 激活失败兑底的
	// draft+acpSessionId 中间态都依赖该保留语义，清单除即 agent 侧孤儿化）。
	const staleDrafts = entries.filter((entry) => entry.status === "draft" && entry.backend !== "dsh" && entry.backend !== "acp");
	if (staleDrafts.length > 0) {
		entries = entries.filter((entry) => entry.status !== "draft" || entry.backend === "dsh" || entry.backend === "acp");
		migrated = true;
	}

	// 兼容旧数据：pi 默认 sessionName（JSONL 文件名时间戳）曾被 onTitleChanged 写进 catalog。
	// 侧栏会显示一排日期，且 refreshAutoTitle 不再把首条消息当标题。加载时清成 Untitled。
	const timestampTitles = entries.filter((entry) => looksLikePiSessionFileStem(entry.title));
	if (timestampTitles.length > 0) {
		for (const entry of timestampTitles) entry.title = "Untitled";
		migrated = true;
	}

	// 旧 catalog 没有 titleLocked/titleOrigin：已有真实标题视为 PiDeck 已确认，避免升级后被
	// 扫描或 TUI 写入反向覆盖；只有占位标题保留一次初始化/自动命名机会。
	// titleLocked=true 的存量条目无法区分手动/扩展自动，一律迁成 legacy：
	// 行为同 manual（挡住自动写入），另加一次指纹修复机会修 #266 被误锁的首句兜底。
	const missingTitleOwnership = entries.filter((entry) => typeof entry.titleLocked !== "boolean" || (entry.titleOrigin === undefined && entry.titleLocked === true));
	if (missingTitleOwnership.length > 0) {
		for (const entry of missingTitleOwnership) {
			if (typeof entry.titleLocked !== "boolean") entry.titleLocked = !isPlaceholderCatalogTitle(entry.title);
			if (entry.titleOrigin === undefined && entry.titleLocked === true) entry.titleOrigin = "legacy";
		}
		migrated = true;
	}

	// 路径与派生身份键一起修复：#354 的旧 POSIX 键是全小写，即使绝对路径
	// 本身没变也需要重算。启动时归并已产生的重复索引，保留原始会话 ID；
	// 标题冲突用注入的会话名读取做有界权威证据仲裁（无证据则整组保留），
	// 被吸收的历史 ID 记入 mergedSessionIds，供持久化引用迁移。
	const repaired = await repairSessionCatalogIdentities(entries, deps.resolveFilePath, (entry) => deps.originKeyForEntry(entry), deps.fetchTitle);
	if (repaired) {
		entries = repaired;
		migrated = true;
	}

	// 兼容旧数据：DSH 会话曾只按文件分支 attach（filePath/piSessionId 落盘，
	// dshSessionId 缺失）——标题同步（findByDshSessionId）与重启后 attach 恢复
	// 旧会话都依赖 dshSessionId。加载时把 backend=dsh 且缺 dshSessionId 的
	// 记录用 piSessionId（当时存的就是 host 会话 id）补齐。
	const migratedDsh = entries.some((entry) => entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId);
	if (migratedDsh) {
		for (const entry of entries) {
			if (entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId) {
				entry.dshSessionId = entry.piSessionId;
			}
		}
		migrated = true;
	}

	// 兼容旧数据：早期版本把 DSH 会话当 pi 会话 attach（filePath=host zstd 文件、
	// piSessionId=host 会话 id 落盘）。pi 侧逻辑会把 zstd 文件当 pi 会话文件
	// 处理（启动 pi exited code=1、导出/删除误判等）。dsh 条目只保留 dshSessionId，
	// filePath/piSessionId 一律清除（dshSessionId 已在上方迁移补齐）。
	const pollutedDsh = entries.some((entry) => entry.backend === "dsh" && (Boolean(entry.filePath) || Boolean(entry.piSessionId)));
	if (pollutedDsh) {
		for (const entry of entries) {
			if (entry.backend !== "dsh") continue;
			delete entry.filePath;
			delete entry.piSessionId;
			entry.originKey = undefined;
		}
		migrated = true;
	}
	// 兼容旧数据：ACP 会话曾被 pi 分支 attach（filePath/piSessionId 落盘）时同理污染；
	// ACP 历史在 agent 侧，PiDeck 无本地会话文件，一律清除。
	const pollutedAcp = entries.some((entry) => entry.backend === "acp" && (Boolean(entry.filePath) || Boolean(entry.piSessionId)));
	if (pollutedAcp) {
		for (const entry of entries) {
			if (entry.backend !== "acp") continue;
			delete entry.filePath;
			delete entry.piSessionId;
			entry.originKey = undefined;
		}
		migrated = true;
	}
	return { entries, migrated };
}
