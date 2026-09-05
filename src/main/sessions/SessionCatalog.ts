import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	open,
	readFile,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AgentBackend,
	AgentTab,
	SessionEnvironment,
	SessionRecord,
	SessionSource,
	SessionSummary,
} from "../../shared/types";
import type { SessionProxyOverride } from "../../shared/types/session";
import { getAppLogger } from "../logging/sharedLogger";
import { renameWithRetry } from "../utils/fsRetry";
import {
	buildSessionOriginKey,
	buildSummaryOriginKey,
	canonicalizeSessionPath,
	collectSessionSubtreeIds,
	getImportedSessionSourceId,
	getSessionEnvironment,
	isInSubagentArtifactsDir,
	looksLikePiSessionFileStem,
} from "../../shared/sessionIdentity";

export type SessionCatalogEntry = {
	id: string;
	projectId: string;
	originKey?: string;
	title: string;
	/** Anonymous entries are in-memory only and are never written to session-catalog.json. */
	noSession?: boolean;
	source: SessionSource;
	environment: SessionEnvironment;
	/** 运行时后端；缺省 "pi"（旧 catalog 数据兼容）。 */
	backend?: AgentBackend;
	filePath?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	status: "draft" | "active";
	/** 子会话标记：扫描时从 SessionSummary 继承，持久化供 getRecord/listEntries 重建（不丢树形） */
	parentSessionPath?: string;
	/**
	 * fork 会话标记（pi fork/clone 产物，文件头带 parentSession）：
	 * 与 parentSessionPath 独立（后者=子代理折叠关系），仅作 fork 身份元数据——
	 * (fork) 标题后缀由 fork 完成时物理写入会话名（sessionForkTitle.ts），不靠该标记拼装。
	 */
	forked?: boolean;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	piSessionId?: string;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 时由 DshAgentManager 创建/attach 维护。 */
	dshSessionId?: string;
	/** DSH 权限预设（read-only/workspace-write/danger-full-access）：草稿期预选，激活时应用。 */
	permissionPreset?: string;
	/** DSH agent 预设（会话「模式」）：草稿期预选；激活新建时随 sessions.create 应用，attach 时从 host 回写。 */
	agentPreset?: string;
	/** 会话级代理覆盖（缺省 = 跟随全局）。DSH 会话的设置在 host 启动时被聚合应用。 */
	proxy?: SessionProxyOverride;
	createdAt: number;
	updatedAt: number;
};

type SessionCatalogFile = {
	version: 1;
	sessions: SessionCatalogEntry[];
	/** 用户主动删除过的 DSH host 会话。host 目录可能还在，自动同步不得再导入。 */
	dismissedDshSessionIds?: string[];
};

type SessionCatalogContext = {
	wslDistro?: string;
	wslUser?: string;
};

/**
 * 将 catalog 条目 filePath 归一化为绝对路径（可选注入）。
 * pi 可能上报相对 cwd 的 sessionFile（如 sessionDir 配置为 ".pi/sessions"），
 * 与扫描器发现的绝对路径 originKey 不同，会造成同文件双记录（侧栏重复显示）。
 * 注入后 catalog 在加载与写入边界统一修正；实现见 main/index.ts。
 */
export type SessionFilePathResolver = (
	projectId: string,
	filePath: string,
	environment: SessionEnvironment,
) => string;

/** 会话标题读取与有效性校验的合并结果：name 缺省时保留 catalog 标题；valid:false 表示
 *  文件非有效 Pi 会话（如 pi-subagents transcript 转储，首条记录用 recordType 而无 type 头），
 *  mergeScanned 应拒绝索引该文件（#168）；parentSessionPath 仅供平铺子代理形态
 * （@tintinweb/pi-subagents：parentSession header + 会话名 <agent>#<8hex>）回填父关系，
 *  用户 fork / 普通会话 / nicobailon 嵌套形态不返回该值。
 *  forked 为 pi fork/branch 探测结果（parentSession header + 非 tintinweb 形态）：
 *  只做列表 (fork) 标记，不影响 parentSessionPath 的折叠语义。
 *  nameFromSessionInfo 标记 name 是否直接取自 session_info（权威）：
 *  - true/缺省 = 权威来源，允许覆盖 catalog 已有真实标题（pi-tui /name 外部改名同步）；
 *  - false = 首条消息回退的弱信号（session_info 落在头/尾窗口盲区），只用于占位标题补名，
 *    不得覆盖已有真实标题（2026-09 自动命名被第二轮消息挤出窗口后被回退覆盖的现场）。 */
export type SessionTitleFetchResult = { name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean };

/** 标题刷新 + 会话头有效性校验：装配层注入（实现为 SessionScanner.inferSessionNameAndValidity，
 *  见 main/index.ts）。文件版本变化时有界读取头尾，既补占位标题，也同步 pi-tui 外部改名。 */
export type SessionTitleFetcher = (filePath: string) => Promise<SessionTitleFetchResult>;

/** 扫描未读正文时没有 session_info。pi JSONL 文件名是时间戳，不能当标题，否则侧栏全是日期。 */
function scannedFileStemTitle(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	const stem = base.replace(/\.jsonl$/i, "").trim();
	if (!stem || looksLikePiSessionFileStem(stem)) return "Untitled";
	return stem;
}

/** 侧栏/Tab 展示用：pi 文件名时间戳不是会话名。 */
function catalogDisplayTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	return looksLikePiSessionFileStem(title) ? undefined : title;
}

/** 占位标题判定：catalog 无真实名称时落成 Untitled（pi 时间戳 stem 加载时也被清成它），
 *  只有这类标题才值得读头部补名，否则每次扫描都会重复读盘。 */
function isPlaceholderCatalogTitle(title: string | undefined): boolean {
	if (!title) return true;
	if (looksLikePiSessionFileStem(title)) return true;
	return /^untitled(?: session)?$/i.test(title);
}

function cloneEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
	return {
		...entry,
		model: entry.model ? { ...entry.model } : undefined,
	};
}

function equalModel(
	left?: { provider: string; modelId: string },
	right?: { provider: string; modelId: string },
): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT",
	);
}

export function canAttachRuntimeMetadata(
	entry: SessionCatalogEntry | undefined,
	tab: Partial<AgentTab>,
): boolean {
	if (!entry || !tab.sessionPath) return false;
	// DSH 的 sessionPath 是 host zstd 日志，不是 pi JSONL。走文件配对会把 zstd
	// 写进 filePath，渲染层当成有历史去读，空会话输入时整页抽成「正在加载历史」。
	if (entry.backend === "dsh" || tab.backend === "dsh") return false;
	if (entry.status === "draft" && !entry.filePath) return true;
	if (!entry.filePath) return false;
	const environment = tab.sessionEnvironment ?? entry.environment;
	return buildSessionOriginKey({
		source: entry.source,
		environment: entry.environment,
		filePath: entry.filePath,
		wslDistro: entry.wslDistro,
		wslUser: entry.wslUser,
		importedSourceId: entry.importedSourceId,
	}) === buildSessionOriginKey({
		source: tab.sessionSource ?? entry.source,
		environment,
		filePath: tab.sessionPath,
		wslDistro: tab.wslDistro ?? entry.wslDistro,
		wslUser: tab.wslUser ?? entry.wslUser,
		importedSourceId: tab.importedSourceId ?? entry.importedSourceId,
	});
}

export class SessionCatalog {
	private entries: SessionCatalogEntry[] = [];
	/** Runtime-only records share the catalog lookup contract without durable storage. */
	private transientEntries = new Map<string, SessionCatalogEntry>();
	/** 侧栏删除过的 DSH host 会话：刷新/自动导入跳过；手动导入会清掉墓碑。 */
	private dismissedDshSessionIds = new Set<string>();
	private loaded = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private skipNextBackup = false;

	private identityContext: SessionCatalogContext;

	constructor(
		private readonly filePath: string,
		identityContext: SessionCatalogContext = {},
		private readonly resolveFilePath?: SessionFilePathResolver,
		private readonly fetchTitle?: SessionTitleFetcher,
	) {
		this.identityContext = { ...identityContext };
	}

	setIdentityContext(context: SessionCatalogContext): void {
		this.identityContext = { ...context };
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		let primaryError: unknown;
		try {
			const snapshot = await this.readCatalogFile(this.filePath);
			this.entries = snapshot.entries;
			this.dismissedDshSessionIds = snapshot.dismissedDshSessionIds;
		} catch (error) {
			primaryError = error;
			try {
				const snapshot = await this.readCatalogFile(this.backupFilePath());
				this.entries = snapshot.entries;
				this.dismissedDshSessionIds = snapshot.dismissedDshSessionIds;
				this.skipNextBackup = true;
			} catch (backupError) {
				if (isMissingFileError(primaryError) && isMissingFileError(backupError)) {
					this.entries = [];
					this.dismissedDshSessionIds = new Set();
				} else {
					// catalog 主文件与备份同时损坏是数据丢失信号，必须留 error 级日志供审计。
					// 不再向上抛：打包启动链会 await load()，抛错会让 whenReady 中断、窗口永不出现。
					void getAppLogger()?.error("session-catalog", "Catalog and backup both failed to load", {
						primary: primaryError instanceof Error ? primaryError.message : String(primaryError),
						backup: backupError instanceof Error ? backupError.message : String(backupError),
					});
					this.entries = [];
					this.dismissedDshSessionIds = new Set();
				}
			}
		}
		// Draft 只代表当前进程中的“尚未发送”编辑面：没有用户消息就没有
		// 可恢复的 Pi session。重启时清掉它们（仅限 pi 后端），避免空 Agent 在
		// 历史列表中永久残留。
		// 例外：DSH 会话的草稿必须保留。DSH 的 host 会话数据由 $DSH_HOME 持久化，
		// catalog 只是 id 映射；即使“创建后激活链路未走完”（attachRuntime 未把
		// status 置 active），重启后用户仍应在侧栏看到并重新激活它。若在此清掉，
		// host 侧会话会变成孤儿且无法从侧栏访问。带 dshSessionId 的异常中间态同样保留。
		const staleDrafts = this.entries.filter(
			(entry) => entry.status === "draft" && entry.backend !== "dsh",
		);
		if (staleDrafts.length > 0) {
			this.entries = this.entries.filter(
				(entry) => entry.status !== "draft" || entry.backend === "dsh",
			);
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 启动清理是 best-effort；内存已经不再暴露草稿，下一次启动仍会重试清理。
			}
		}

		// 兼容旧数据：pi 默认 sessionName（JSONL 文件名时间戳）曾被 onTitleChanged 写进 catalog。
		// 侧栏会显示一排日期，且 refreshAutoTitle 不再把首条消息当标题。加载时清成 Untitled。
		const timestampTitles = this.entries.filter((entry) => looksLikePiSessionFileStem(entry.title));
		if (timestampTitles.length > 0) {
			for (const entry of timestampTitles) entry.title = "Untitled";
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 修复是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：早期版本可能存有相对 filePath（pi 返回相对 cwd 的 sessionFile，
		// 如 sessionDir 配置为 ".pi/sessions"）。相对路径与扫描器绝对路径的 originKey
		// 不同 → 同一文件出现两条记录（侧栏重复显示），且文件操作落到错误位置。
		// 加载时用注入的 resolver 统一修正为绝对路径并重算 originKey。
		const repaired = this.repairRelativeFilePaths(this.entries);
		if (repaired) {
			this.entries = repaired;
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 修复是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：DSH 会话曾只按文件分支 attach（filePath/piSessionId 落盘，
		// dshSessionId 缺失）——标题同步（findByDshSessionId）与重启后 attach 恢复
		// 旧会话都依赖 dshSessionId。加载时把 backend=dsh 且缺 dshSessionId 的
		// 记录用 piSessionId（当时存的就是 host 会话 id）补齐。
		const migratedDsh = this.entries.some((entry) => (
			entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId
		));
		if (migratedDsh) {
			for (const entry of this.entries) {
				if (entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId) {
					entry.dshSessionId = entry.piSessionId;
				}
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：早期版本把 DSH 会话当 pi 会话 attach（filePath=host zstd 文件、
		// piSessionId=host 会话 id 落盘）。pi 侧逻辑会把 zstd 文件当 pi 会话文件
		// 处理（启动 pi exited code=1、导出/删除误判等）。dsh 条目只保留 dshSessionId，
		// filePath/piSessionId 一律清除（dshSessionId 已在上方迁移补齐）。
		const pollutedDsh = this.entries.some((entry) => (
			entry.backend === "dsh" && (Boolean(entry.filePath) || Boolean(entry.piSessionId))
		));
		if (pollutedDsh) {
			for (const entry of this.entries) {
				if (entry.backend !== "dsh") continue;
				delete entry.filePath;
				delete entry.piSessionId;
				entry.originKey = undefined;
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}
		this.loaded = true;
		if (this.skipNextBackup) {
			await this.writeSnapshot(this.entries);
		}
	}

	listEntries(): SessionCatalogEntry[] {
		this.assertLoaded();
		return [
			...this.entries.map(cloneEntry),
			...Array.from(this.transientEntries.values(), cloneEntry),
		];
	}

	get(id: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.transientEntries.get(id) ?? this.entries.find((candidate) => candidate.id === id);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 按 DSH host 会话 id 反查 catalog 记录（会话标题同步用；只读查询，不排队写）。
	 *  transient 草稿尚未 attach host 会话（无 dshSessionId），只需查持久 entries。 */
	findByDshSessionId(dshSessionId: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.entries.find((candidate) => candidate.dshSessionId === dshSessionId);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 侧栏删除过的 DSH host 会话。自动同步跳过；手动导入会清掉。 */
	listDismissedDshSessionIds(): Set<string> {
		this.assertLoaded();
		return new Set(this.dismissedDshSessionIds);
	}

	/** 删除 DSH 映射时记下墓碑，避免 host 目录还在时刷新又把会话导回来。 */
	async rememberDismissedDshSession(dshSessionId: string): Promise<void> {
		this.assertLoaded();
		const id = dshSessionId.trim();
		if (!id) return;
		await this.enqueueMutation((entries) => {
			if (this.dismissedDshSessionIds.has(id)) {
				return { value: undefined, changed: false };
			}
			this.dismissedDshSessionIds.add(id);
			return { value: undefined, changed: true };
		});
	}

	createAnonymous(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
	}): SessionRecord {
		this.assertLoaded();
		const now = Date.now();
		const entry: SessionCatalogEntry = {
			id: randomUUID(),
			projectId: input.projectId,
			title: input.title,
			noSession: true,
			source: "pi",
			environment: input.environment,
			wslDistro: input.environment === "wsl" ? this.identityContext.wslDistro : undefined,
			wslUser: input.environment === "wsl" ? this.identityContext.wslUser : undefined,
			status: "active",
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			createdAt: now,
			updatedAt: now,
		};
		this.transientEntries.set(entry.id, entry);
		return this.recordFromEntry(entry);
	}

	removeTransient(id: string): boolean {
		this.assertLoaded();
		return this.transientEntries.delete(id);
	}

	getRecord(id: string): SessionRecord | undefined {
		const entry = this.get(id);
		return entry ? this.recordFromEntry(entry) : undefined;
	}

	findByFilePath(
		filePath: string,
		environment: SessionEnvironment,
	): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		const entry = this.entries.find((candidate) => (
			candidate.filePath &&
			candidate.environment === environment &&
			canonicalizeSessionPath(candidate.filePath, environment) === target
		));
		return entry ? cloneEntry(entry) : undefined;
	}

	async ensureRuntimeTarget(input: {
		projectId: string;
		title: string;
		source: SessionSource;
		environment: SessionEnvironment;
		filePath: string;
		wslDistro?: string;
		wslUser?: string;
		importedSourceId?: string;
		piSessionId?: string;
		/** fork/clone 产物注册时直接标记（parentSession 链接已由 pi 写入文件头，此处同源标记）。 */
		forked?: boolean;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		// 与 attachRuntime 同口径：进入 catalog 前归一化为绝对路径，保证 originKey 去重一致。
		const filePath = this.resolveFilePath
			? this.resolveFilePath(input.projectId, input.filePath, input.environment)
			: input.filePath;
		return this.enqueueMutation((entries) => {
			const originKey = buildSessionOriginKey({
				source: input.source,
				environment: input.environment,
				filePath,
				wslDistro: input.wslDistro,
				wslUser: input.wslUser,
				importedSourceId: input.importedSourceId,
			});
			let entry = entries.find((candidate) => {
				if (candidate.originKey === originKey) return true;
				if (!candidate.filePath) return false;
				return buildSessionOriginKey({
					source: candidate.source,
					environment: candidate.environment,
					filePath: candidate.filePath,
					wslDistro: candidate.wslDistro,
					wslUser: candidate.wslUser,
					importedSourceId: candidate.importedSourceId,
				}) === originKey;
			});
			const now = Date.now();
			if (!entry) {
				entry = {
					id: randomUUID(),
					projectId: input.projectId,
					originKey,
					title: input.title,
					source: input.source,
					environment: input.environment,
					filePath,
					wslDistro: input.wslDistro,
					wslUser: input.wslUser,
					importedSourceId: input.importedSourceId,
					piSessionId: input.piSessionId,
					forked: input.forked,
					status: "active",
					createdAt: now,
					updatedAt: now,
				};
				entries.push(entry);
			} else {
				entry.projectId = input.projectId;
				entry.originKey = originKey;
				entry.title = input.title;
				entry.source = input.source;
				entry.environment = input.environment;
				entry.filePath = filePath;
				entry.wslDistro = input.wslDistro;
				entry.wslUser = input.wslUser;
				entry.importedSourceId = input.importedSourceId;
				entry.piSessionId = input.piSessionId;
				// fork 标记只增补不清空：同一文件可能先以普通扫描注册、后经 fork 注册逻辑走到这里。
				if (input.forked) entry.forked = true;
				entry.status = "active";
				entry.updatedAt = now;
			}
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async createDraft(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		source?: SessionSource;
		backend?: AgentBackend;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		permissionPreset?: string;
		/** DSH agent 预设（会话「模式」）草稿期预选；外部会话导入时来自 host 会话 header。 */
		agentPreset?: string;
		/** 外部（dsh-web 等）会话导入：host 会话已存在，条目直接置 active（重启不清理）。 */
		dshSessionId?: string;
		/**
		 * DSH 外部会话的真实活跃时间（磁盘日志文件 mtime）。自动同步每轮全量重导，
		 * 不带这个就用 Date.now()，会话每次重启被顶到启动时刻、永远排在 pi 会话上面。
		 * 语义与 pi 会话一致（扫描器用文件 mtime 当 updatedAt）。
		 */
		updatedAt?: number;
		/** 纠正归属时保留已有真实标题；占位名（cwd 末段）由调用方决定是否覆盖。 */
		keepExistingTitle?: boolean;
		/**
		 * 手动找回（配置页导入 / 归档恢复）才清删除墓碑。
		 * 自动同步禁止带这个：否则删映射的同时刷新还在跑，createDraft 会把墓碑清掉再写回侧栏。
		 */
		restoreDismissed?: boolean;
	}): Promise<SessionRecord> {
		this.assertLoaded();
		const entry = await this.enqueueMutation((entries) => {
			const now = Date.now();
			// 幂等去重：DSH 外部会话按 host 会话 id 唯一映射。同一 dshSessionId 重复
			// 导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）时
			// 不再新建条目，只更新标题/项目归属——否则侧栏出现两条同 host 会话记录，
			// 且删除其一后另一条仍可加载同一 host 数据（「重复导入」用户问题）。
			if (input.dshSessionId) {
				const dismissed = this.dismissedDshSessionIds.has(input.dshSessionId);
				const existing = entries.find((candidate) => (
					candidate.dshSessionId === input.dshSessionId
				));
				// 用户已删映射、host 目录还在：自动同步不得再建条目。手动找回才允许。
				if (dismissed && !input.restoreDismissed && !existing) {
					throw new Error("DISMISSED_DSH_SESSION");
				}
				const forgotten = input.restoreDismissed
					? this.dismissedDshSessionIds.delete(input.dshSessionId)
					: false;
				if (existing) {
					const nextTitle = input.keepExistingTitle ? existing.title : input.title;
					const agentPresetChanged = input.agentPreset !== undefined && existing.agentPreset !== input.agentPreset;
					const changed = forgotten || (
						existing.projectId !== input.projectId ||
						existing.title !== nextTitle ||
						existing.backend !== input.backend ||
						agentPresetChanged ||
						existing.status !== "active" ||
						// mtime 变化也落盘：修正历史被顶高的 updatedAt，否则排序永远错
						existing.updatedAt !== (input.updatedAt ?? now)
					);
					existing.projectId = input.projectId;
					existing.title = nextTitle;
					existing.backend = input.backend;
					existing.status = "active";
					// 外部会话 header 携带的 preset 变化（host 会话 header 是权威）随导入同步
					if (input.agentPreset !== undefined) existing.agentPreset = input.agentPreset;
					// 排序语义：用磁盘日志文件 mtime（真实活跃时间），不再顶到导入时刻
					existing.updatedAt = input.updatedAt ?? now;
					return { value: cloneEntry(existing), changed };
				}
			}
			const nextEntry: SessionCatalogEntry = {
				id: randomUUID(),
				projectId: input.projectId,
				title: input.title,
				source: input.source ?? "pi",
				environment: input.environment,
				backend: input.backend,
				wslDistro: input.environment === "wsl"
					? this.identityContext.wslDistro
					: undefined,
				wslUser: input.environment === "wsl"
					? this.identityContext.wslUser
					: undefined,
				// 带 dshSessionId = 导入已有 host 会话（数据在 $DSH_HOME），
				// 不是「尚未发送」的草稿：置 active，重启清理/重新打开都按真实会话处理。
				status: input.dshSessionId ? "active" : "draft",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				permissionPreset: input.permissionPreset,
				agentPreset: input.agentPreset,
				dshSessionId: input.dshSessionId,
				createdAt: now,
				// 外部会话导入带 mtime（真实活跃时间）；pi 草稿没有该字段，仍用当前时刻
				updatedAt: input.updatedAt ?? now,
			};
			entries.push(nextEntry);
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async update(
		id: string,
		patch: Partial<Pick<
			SessionCatalogEntry,
			"title" | "backend" | "updatedAt"
		>> & {
			model?: { provider: string; modelId: string } | null;
			thinkingLevel?: string | null;
			permissionPreset?: string | null;
			/** DSH agent 预设（会话「模式」）：草稿期预选；null = 清除预选。 */
			agentPreset?: string | null;
			proxy?: SessionProxyOverride | null;
			/** 切到生图后端时甩开 pi 会话文件引用（null = 清空）。 */
			filePath?: string | null;
			piSessionId?: string | null;
			/** fork 标记：仅显式 true 时置位（fork 身份元数据；(fork) 后缀已物理写入标题）。 */
			forked?: boolean | null;
		},
	): Promise<SessionRecord> {
		this.assertLoaded();
		const transient = this.transientEntries.get(id);
		if (transient) {
			if (patch.title !== undefined) transient.title = patch.title;
			if (patch.model !== undefined) transient.model = patch.model ?? undefined;
			if (patch.thinkingLevel !== undefined) transient.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) transient.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) transient.agentPreset = patch.agentPreset ?? undefined;
			if (patch.backend !== undefined) transient.backend = patch.backend;
			// 切到生图后端时需甩开 pi 会话文件（filePath/piSessionId 置空），否则残留文件引用
			if (patch.filePath !== undefined) transient.filePath = patch.filePath ?? undefined;
			if (patch.piSessionId !== undefined) transient.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) transient.forked = true;
			// null = 清除覆盖恢复跟随全局
			if (patch.proxy !== undefined) transient.proxy = patch.proxy ?? undefined;
			transient.updatedAt = patch.updatedAt ?? Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, id);
			if (patch.title !== undefined) nextEntry.title = patch.title;
			if (patch.model !== undefined) nextEntry.model = patch.model ?? undefined;
			if (patch.thinkingLevel !== undefined) nextEntry.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) nextEntry.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) nextEntry.agentPreset = patch.agentPreset ?? undefined;
			if (patch.backend !== undefined) nextEntry.backend = patch.backend;
			if (patch.filePath !== undefined) nextEntry.filePath = patch.filePath ?? undefined;
			if (patch.piSessionId !== undefined) nextEntry.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) nextEntry.forked = true;
			// null = 清除覆盖恢复跟随全局
			if (patch.proxy !== undefined) nextEntry.proxy = patch.proxy ?? undefined;
			nextEntry.updatedAt = patch.updatedAt ?? Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
		/** DSH agent 预设（会话「模式」）：attach/新建后 host 回写（host 会话 header 是权威）。 */
		agentPreset?: string;
		/** 真正开聊后再把 DSH 草稿抬成 active；预热只绑 host id，不抬。 */
		promoteToActive?: boolean;
		/** 归档恢复等手动找回才清删除墓碑；激活/fork 回写不得把用户删过的 id 解禁。 */
		restoreDismissed?: boolean;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		return this.enqueueMutation((entries) => {
			const entry = this.requireEntry(entries, input.sessionId);
			// pi 可能上报相对 cwd 的 sessionFile：写入 catalog 前归一化为绝对路径，
			// 否则与扫描器绝对路径 originKey 不一致，同一文件会出现两条记录。
			const filePath =
				input.filePath && this.resolveFilePath
					? this.resolveFilePath(
							entry.projectId,
							input.filePath,
							entry.environment,
						)
					: input.filePath;
			const previousFilePath = entry.filePath;
			// DSH 的 sessionPath 是 host zstd，不是 pi JSONL；写进 filePath 会让渲染层
			// 把空会话当成有磁盘历史（起始页 / 骨架来回抽）。
			if (filePath && entry.backend !== "dsh") entry.filePath = filePath;
			if (input.piSessionId) entry.piSessionId = input.piSessionId;
			if (input.dshSessionId) {
				entry.dshSessionId = input.dshSessionId;
				// 只有明确找回才清墓碑。激活回写同一 host id 时如果清掉，
				// 用户删映射后迟到的 attach 会让下次自动同步再导回来。
				if (input.restoreDismissed) {
					this.dismissedDshSessionIds.delete(input.dshSessionId);
				}
			}
			// attach/新建时 host 回写的实际 preset（草稿预选可能被 host 修正为部署默认）
			if (input.agentPreset !== undefined) entry.agentPreset = input.agentPreset;
			// DSH 预热/激活也会 attach host id，但此时还没有用户消息。
			// 不能把草稿抬成 active：渲染层会把「active + dshSessionId」当成有历史，
			// 输入一半整页换成「正在加载历史」骨架。导入路径 createDraft({dshSessionId})
			// 已经是 active；真正开聊后由 prompt dispatch 再 promoteToActive。
			if (
				input.promoteToActive &&
				input.dshSessionId &&
				!entry.filePath &&
				entry.status === "draft"
			) {
				entry.status = "active";
			}
			if (entry.filePath) {
				const pathUnchanged = Boolean(
					previousFilePath &&
					canonicalizeSessionPath(previousFilePath, entry.environment) ===
						canonicalizeSessionPath(entry.filePath, entry.environment),
				);
				const nextOriginKey = pathUnchanged && entry.originKey
					? entry.originKey
					: this.originKeyForEntry(entry);
				entry.originKey = nextOriginKey;
				entry.status = "active";

				const duplicateIndex = nextOriginKey
					? entries.findIndex((candidate) => (
						candidate.id !== entry.id && candidate.originKey === nextOriginKey
					))
					: -1;
				if (duplicateIndex >= 0) {
					const duplicate = entries[duplicateIndex];
					entry.model ??= duplicate.model;
					entry.thinkingLevel ??= duplicate.thinkingLevel;
					entry.importedSourceId ??= duplicate.importedSourceId;
					entry.createdAt = Math.min(entry.createdAt, duplicate.createdAt);
					entries.splice(duplicateIndex, 1);
				}
			}
			entry.updatedAt = Date.now();
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async remove(id: string): Promise<boolean> {
		this.assertLoaded();
		if (this.transientEntries.delete(id)) return true;
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => entry.id === id);
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	/**
	 * 归档/删除父会话时清掉整棵子树。
	 *
	 * 磁盘侧 `SessionScanner.archive/delete` 会把 sibling `<stem>/` 一并移走，但
	 * `remove(id)` 只摘一条；`mergeScanned` 只增改不删，列表缓存会把失去父节点的
	 * 子会话孤儿提升成顶层行，再点开就是残留聊天框。匿名会话和草稿没有 filePath，
	 * 不会被当成后代。其它项目即使路径碰巧相似，也按 projectId 隔离。
	 */
	async removeWithDescendants(id: string): Promise<string[]> {
		this.assertLoaded();
		const parent = this.transientEntries.get(id) ?? this.entries.find((entry) => entry.id === id);
		if (!parent) return [];
		const projectEntries = this.listEntries().filter((entry) => entry.projectId === parent.projectId);
		const ids = collectSessionSubtreeIds(projectEntries, parent);

		const removed: string[] = [];
		for (const sessionId of ids) {
			if (this.transientEntries.delete(sessionId)) removed.push(sessionId);
		}
		const persistedIds = ids.filter((sessionId) => !removed.includes(sessionId));
		if (persistedIds.length === 0) return removed;

		const persistedRemoved = await this.enqueueMutation((entries) => {
			const idSet = new Set(persistedIds);
			const next = entries.filter((entry) => !idSet.has(entry.id));
			const actuallyRemoved = entries.filter((entry) => idSet.has(entry.id)).map((entry) => entry.id);
			if (actuallyRemoved.length === 0) return { value: [] as string[], changed: false };
			entries.splice(0, entries.length, ...next);
			return { value: actuallyRemoved, changed: true };
		});
		return [...removed, ...persistedRemoved];
	}

	/**
	 * 将 draft 会话提升为 active：生图草稿已把历史落盘到 ImageSession 独立存储后调用，
	 * 避免重启时被 staleDrafts 清理逻辑剔掉（否则侧栏没有入口，历史无法恢复）。
	 * 非 draft / 匿名会话幂等：只更新 updatedAt。
	 */
	async promoteToActive(sessionId: string): Promise<SessionRecord | undefined> {
		this.assertLoaded();
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (transient.status === "draft") transient.status = "active";
			transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (nextEntry.status === "draft") nextEntry.status = "active";
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * 删除侧栏项目时清掉该项目下全部 catalog 映射（含 DSH 导入）。
	 * host 会话文件仍在 $DSH_HOME，但不再自动挂回侧栏；用户手动导入才会再出现。
	 */
	async removeByProjectId(projectId: string): Promise<number> {
		this.assertLoaded();
		for (const [id, entry] of this.transientEntries) {
			if (entry.projectId === projectId) this.transientEntries.delete(id);
		}
		return this.enqueueMutation((entries) => {
			const next = entries.filter((entry) => entry.projectId !== projectId);
			const removed = entries.length - next.length;
			if (removed === 0) return { value: 0, changed: false };
			entries.splice(0, entries.length, ...next);
			return { value: removed, changed: true };
		});
	}

	async removeByFilePath(
		filePath: string,
		environment: SessionEnvironment,
	): Promise<boolean> {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => (
				entry.filePath &&
				entry.environment === environment &&
				canonicalizeSessionPath(entry.filePath, environment) === target
			));
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	async mergeScanned(
		projectId: string,
		summaries: SessionSummary[],
		context: SessionCatalogContext = this.identityContext,
	): Promise<SessionRecord[]> {
		this.assertLoaded();
		// 轻量列表扫描的 summary 不带 name（listPathSummary 只 stat，见 SessionScanner）；
		// 新文件/占位标题需要补名，已有标题的文件若 mtime 变化也需有界回读——pi-tui `/name`
		// 会在 JSONL 末尾追加 session_info，否则项目刷新和重启 Session 都只会继续使用旧 catalog 标题。
		// 同一次读头部顺带校验会话头有效性：invalidOrigins 收集被判定为非有效会话
		// 的 originKey（transcript 等无 type 头的产物，#168），下面据此清洗与拒绝。
		const { names: fetchedNames, authoritative: fetchedAuthoritativeByOrigin, invalid: invalidOrigins, parents: fetchedParents, forked: fetchedForked } =
			await this.collectScannedTitles(summaries, context);
		return this.enqueueMutation((entries) => {
			let changed = false;

			// 清洗存量脏数据：pi-subagents artifactDir="session"（默认）的产物转储
			// 曾被旧版扫描误注册成 active 条目，导致每个子代理在侧栏「嵌套 + 顶层平铺」
			// 重复显示。扫描端已排除这些文件，但 mergeScanned 只增改不删，存量条目会
			// 永远留在 catalog 里；这里按同一路径规则移除并落盘（仅 pi 来源，导入会话不受影响）。
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index]!;
				if (entry.source !== "pi" || !entry.filePath) continue;
				if (!isInSubagentArtifactsDir(entry.filePath)) continue;
				entries.splice(index, 1);
				changed = true;
			}

			// 清洗会话头校验失败的存量条目：本轮补名读取判定为非有效会话的文件
			// （transcript 等无 type 头的产物，即便不在 subagent-artifacts 目录）。
			// 仅 pi 来源；导入会话由各自导入器保证格式，不参与本校验。
			if (invalidOrigins.size > 0) {
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const entry = entries[index]!;
					if (entry.source !== "pi") continue;
					if (!entry.originKey || !invalidOrigins.has(entry.originKey)) continue;
					entries.splice(index, 1);
					changed = true;
				}
			}

			// 防御性过滤：扫描端漏网（subagent-artifacts）或会话头校验失败的产物不得注册新条目。
			const acceptedSummaries = summaries.filter((summary) => {
				if (summary.source === "pi" && isInSubagentArtifactsDir(summary.filePath)) return false;
				if (invalidOrigins.has(buildSummaryOriginKey(summary, context))) return false;
				return true;
			});

			const byOrigin = new Map(
				entries
					.filter((entry) => entry.originKey)
					.map((entry) => [entry.originKey!, entry]),
			);
			const summaryById = new Map<string, SessionSummary>();

			// Restore model/thinking from the session file when the catalog lacks them.
			// (Explicit user picks are already stored on the entry and are preserved.)
			function inheritSessionMeta(entry: SessionCatalogEntry, summary: SessionSummary) {
				if (!entry.model && summary.model) {
					entry.model = { ...summary.model };
					changed = true;
				}
				if (!entry.thinkingLevel && summary.thinkingLevel) {
					entry.thinkingLevel = summary.thinkingLevel;
					changed = true;
				}
			}

			for (const summary of acceptedSummaries) {
				const originKey = buildSummaryOriginKey(summary, context);
				const fetchedTitle = fetchedNames.get(originKey);
				// 权威性：命中 session_info（或显式 name 行）才允许覆盖 catalog 已有真实标题。
				// 首条消息回退（nameFromSessionInfo === false）是弱信号——会话文件变大后
				// session_info 可能落在扫描器头/尾窗口的盲区，弱回退不得把用户/自动命名冲掉。
				const fetchedAuthoritative = fetchedAuthoritativeByOrigin.get(originKey) ?? true;
				// 平铺子代理（tintinweb 形态）父关系回补：轻量扫描不带 parentSessionPath，
				// 标题回读时若探测到父（<agent>#<8hex> + parentSession header）则用拾取值；
				// 普通会话/用户 fork 不探测到该值，保持 summary/旧值原样。
				const fetchedParent = fetchedParents.get(originKey);
				// fork 标记回填：仅头部探测确认（parentSession + 非 tintinweb 形态）时置 true；
				// 有父关系（子代理折叠）的会话不标记——fork 与子代理是两种形态。
				const fetchedForkedFlag = fetchedForked.get(originKey);
				const importedSourceId = getImportedSessionSourceId(summary);
				let entry = byOrigin.get(originKey);
				if (!entry) {
					const now = summary.updatedAt || Date.now();
					entry = {
						id: randomUUID(),
						projectId,
						originKey,
						// listPathSummary 没有 name；readSummary 若仍带回时间戳文件名，也不能当标题。
						// summary.name（全量解析）优先，头部补名次之，最后才回退文件名 stem。
						title: catalogDisplayTitle(summary.name)
							|| catalogDisplayTitle(fetchedTitle)
							|| scannedFileStemTitle(summary.filePath),
						source: summary.source ?? "pi",
						environment: getSessionEnvironment(summary),
						filePath: summary.filePath,
						wslDistro: summary.wsl ? context.wslDistro : undefined,
						wslUser: summary.wsl ? context.wslUser : undefined,
						importedSourceId,
						status: "active",
						parentSessionPath: summary.parentSessionPath ?? fetchedParent,
						forked: (summary.parentSessionPath ?? fetchedParent) ? undefined : fetchedForkedFlag,
						createdAt: now,
						updatedAt: now,
					};
					entries.push(entry);
					byOrigin.set(originKey, entry);
					changed = true;
				} else {
					// 旧 catalog 可能已经保存了时间戳文件名；不能在清洗失败时用 entry.title 回退，
					// 否则每次扫描都会把这个错误标题原样保留下来，重启后仍显示时间戳。
					// 已存在真实标题时，弱回退（首条消息文本）不得覆盖（2026-09 现场：
					// 自动命名 session_info 被第二轮消息挤出窗口盲区后被消息文本冲掉）；
					// 权威回读（session_info 命中）与占位标题升级不受此限。
					const nextTitle = catalogDisplayTitle(summary.name)
						|| (fetchedAuthoritative || isPlaceholderCatalogTitle(entry.title)
							? catalogDisplayTitle(fetchedTitle)
							: undefined)
						|| catalogDisplayTitle(entry.title)
						|| scannedFileStemTitle(summary.filePath);
					// 父关系最终值：新探测值优先，缺失时保留旧值（轻量扫描恒缺省，不能清掉已持久化的父）。
					const nextParent = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
					// fork 标记同样只增补、不清空：未探测到（轻量扫描/普通会话）保留持久化值。
					const nextForked = nextParent ? entry.forked : (fetchedForkedFlag || entry.forked);
					if (
						entry.projectId !== projectId ||
						entry.filePath !== summary.filePath ||
						entry.title !== nextTitle ||
						entry.source !== (summary.source ?? "pi") ||
						entry.environment !== getSessionEnvironment(summary) ||
						entry.wslDistro !== (summary.wsl ? context.wslDistro : undefined) ||
						entry.wslUser !== (summary.wsl ? context.wslUser : undefined) ||
						entry.importedSourceId !== importedSourceId ||
						entry.status !== "active" ||
						entry.parentSessionPath !== nextParent ||
						entry.forked !== nextForked ||
						entry.updatedAt !== summary.updatedAt
					) {
						entry.projectId = projectId;
						entry.filePath = summary.filePath;
						entry.title = nextTitle;
						entry.source = summary.source ?? "pi";
						entry.environment = getSessionEnvironment(summary);
						entry.wslDistro = summary.wsl ? context.wslDistro : undefined;
						entry.wslUser = summary.wsl ? context.wslUser : undefined;
						entry.importedSourceId = importedSourceId;
						entry.status = "active";
						// 子会话的父子关系可能随后续扫描才被识别（parent 文件出现/路径推断补全），
						// 变化必须计入 changed 才会落盘，否则重拉后仍以孤儿平铺。
						// 平铺子代理（tintinweb 形态）的父来自头部探测（fetchedParent，见上方）。
						// 注意：轻量扫描（listPathSummary）不读正文、parentSessionPath 恒为缺省，
						// 直接用缺省值覆盖会清掉上轮探测/持久化的父关系（重启后孤儿平铺）；
						// 故此处只增补、不清空——新值优先，其次保留旧值。
						entry.parentSessionPath = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
						entry.forked = nextForked;
						entry.updatedAt = summary.updatedAt;
						changed = true;
					}
				}
				summaryById.set(entry.id, summary);
				inheritSessionMeta(entry, summary);
			}

			const records = entries
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => this.recordFromEntry(entry, summaryById.get(entry.id)));
			const idByPath = new Map<string, string>();
			for (const record of records) {
				if (!record.filePath) continue;
				idByPath.set(
					canonicalizeSessionPath(record.filePath, record.environment),
					record.id,
				);
			}
			for (const record of records) {
				if (!record.parentSessionPath) continue;
				record.parentSessionId = idByPath.get(
					canonicalizeSessionPath(record.parentSessionPath, record.environment),
				);
			}
			return {
				value: records.sort((left, right) => right.updatedAt - left.updatedAt),
				changed,
			};
		}).then((records) => [
			...Array.from(this.transientEntries.values())
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => this.recordFromEntry(entry)),
			...records,
		].sort((left, right) => right.updatedAt - left.updatedAt));
	}

	/** 对新文件/占位标题，或文件版本相对 catalog 发生变化的条目读取标题。
	 *  unchanged 的真实标题不读盘，避免周期扫描重复 I/O；mtime 变化则回读头尾以同步
	 *  pi-tui `/name` 追加的 session_info。同一次读取顺带校验会话头有效性（#168）：transcript 等无 type 头的产物
	 *  被标记 invalid，mergeScanned 据此拒绝索引并清洗存量条目。
	 *  tintinweb 平铺子代理（@tintinweb/pi-subagents）会话名固定 <agent>#<8hex>：
	 *  一旦标题回填该形态而条目仍无父关系，说明它是历史扫描遗留的孤儿（旧版 catalog
	 *  不含 parentSessionPath），需要重新读头部回补（见 fetchTitle 返回的 parentSessionPath）。
	 *  用户 fork 的名字由用户命名、通常不匹配该模式，不会被额外唤醒读盘。 */
	private async collectScannedTitles(
		summaries: SessionSummary[],
		context: SessionCatalogContext,
	): Promise<{ names: Map<string, string>; authoritative: Map<string, boolean>; invalid: Set<string>; parents: Map<string, string>; forked: Map<string, boolean> }> {
		const names = new Map<string, string>();
		const authoritative = new Map<string, boolean>();
		const invalid = new Set<string>();
		const parents = new Map<string, string>();
		const forked = new Map<string, boolean>();
		if (!this.fetchTitle) return { names, authoritative, invalid, parents, forked };
		const byOrigin = new Map(
			this.entries.filter((entry) => entry.originKey).map((entry) => [entry.originKey!, entry]),
		);
		const wanted: Array<{ originKey: string; filePath: string }> = [];
		for (const summary of summaries) {
			const originKey = buildSummaryOriginKey(summary, context);
			// readSummary 全量路径已携带权威标题，无需再次读盘。
			if (catalogDisplayTitle(summary.name)) continue;
			const existing = byOrigin.get(originKey);
			if (existing) {
				const tintinwebOrphan = existing.source === "pi"
					&& !existing.parentSessionPath
					&& /^[^#]+#[0-9a-f]{8}$/i.test(existing.title);
				const fileVersionChanged = existing.updatedAt !== summary.updatedAt;
				// 已有真实标题且文件版本未变时跳过；变化通常意味着 pi 追加消息/改名，
				// 头尾窗口读取会用最后一条 session_info 更新标题，成本仍受 128KB 上限约束。
				if (!isPlaceholderCatalogTitle(existing.title) && !tintinwebOrphan && !fileVersionChanged) continue;
			}
			wanted.push({ originKey, filePath: summary.filePath });
		}
		if (wanted.length === 0) return { names, authoritative, invalid, parents, forked };
		// 有界并行读头部；限制并发避免 WSL 环境一次拉起过多 wsl.exe。
		// 单个失败降级为无标题/不拒绝，不影响扫描结果。
		const CONCURRENCY = 8;
		let cursor = 0;
		const workers = Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
			while (cursor < wanted.length) {
				const item = wanted[cursor++];
				const result = await this.fetchTitle!(item.filePath).catch(() => undefined);
				if (!result) continue;
				if (result.name) {
					names.set(item.originKey, result.name);
					authoritative.set(item.originKey, result.nameFromSessionInfo !== false);
				}
				// valid 显式为 false 才拒绝；缺省（读不到/未校验）保留原行为
				if (result.valid === false) invalid.add(item.originKey);
				// 平铺子代理（tintinweb 形态）回补父关系：来源只推断自 filename，
				// 不以 summary 的 source 过滤，避免引用文件与扫描来源不一致时漏补。
				if (result.parentSessionPath) parents.set(item.originKey, result.parentSessionPath);
				// pi fork/branch 会话标记（parentSession header + 非 tintinweb 形态）：只在探测到
				// 才写 true，不写 false——普通会话/子代理不该反向清掉已持久化的标记。
				if (result.forked === true) forked.set(item.originKey, true);
			}
		});
		await Promise.all(workers);
		return { names, authoritative, invalid, parents, forked };
	}

	private recordFromEntry(
		entry: SessionCatalogEntry,
		summary?: SessionSummary,
	): SessionRecord {
		return {
			id: entry.id,
			projectId: entry.projectId,
			title: catalogDisplayTitle(summary?.name) || catalogDisplayTitle(entry.title) || "Untitled",
			noSession: entry.noSession,
			source: summary?.source ?? entry.source,
			environment: summary ? getSessionEnvironment(summary) : entry.environment,
			backend: entry.backend,
			filePath: summary?.filePath ?? entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: summary
				? getImportedSessionSourceId(summary)
				: entry.importedSourceId,
			parentSessionPath: summary?.parentSessionPath ?? entry.parentSessionPath,
			forked: entry.forked,
			projectPath: summary?.projectPath,
			preview: summary?.preview ?? "",
			messageCount: summary?.messageCount ?? 0,
			status: entry.status,
			model: entry.model ? { ...entry.model } : undefined,
			thinkingLevel: entry.thinkingLevel,
			permissionPreset: entry.permissionPreset,
			agentPreset: entry.agentPreset,
			dshSessionId: entry.dshSessionId,
			proxy: entry.proxy ? { ...entry.proxy } : undefined,
			createdAt: entry.createdAt,
			updatedAt: summary?.updatedAt ?? entry.updatedAt,
			wsl: summary?.wsl,
			codexSessionId: summary?.codexSessionId,
			codexThreadSource: summary?.codexThreadSource,
			codexParentThreadId: summary?.codexParentThreadId,
			codexAgentRole: summary?.codexAgentRole,
			codexAgentNickname: summary?.codexAgentNickname,
		};
	}

	private originKeyForEntry(entry: SessionCatalogEntry): string | undefined {
		if (!entry.filePath) return undefined;
		return buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro ?? this.identityContext.wslDistro,
			wslUser: entry.wslUser ?? this.identityContext.wslUser,
			importedSourceId: entry.importedSourceId,
		});
	}

	/**
	 * 把条目中的相对 filePath 修正为绝对路径（通过注入的 resolver）。
	 * 返回新数组表示有变更；未注入 resolver 或无需修正时返回 undefined。
	 */
	private repairRelativeFilePaths(
		entries: SessionCatalogEntry[],
	): SessionCatalogEntry[] | undefined {
		const resolve = this.resolveFilePath;
		if (!resolve) return undefined;
		let changed = false;
		const next = entries.map((entry) => {
			if (!entry.filePath) return entry;
			const resolved = resolve(
				entry.projectId,
				entry.filePath,
				entry.environment,
			);
			if (!resolved || resolved === entry.filePath) return entry;
			changed = true;
			const repaired = { ...entry, filePath: resolved };
			// originKey 随路径变化重算，否则后续 mergeScanned/attachRuntime 仍按旧 key 去重
			if (repaired.originKey) repaired.originKey = this.originKeyForEntry(repaired);
			return repaired;
		});
		return changed ? next : undefined;
	}

	private requireEntry(
		entries: SessionCatalogEntry[],
		id: string,
	): SessionCatalogEntry {
		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry) throw new Error(`Session not found: ${id}`);
		return entry;
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("SessionCatalog.load() must complete before use");
	}

	private enqueueMutation<T>(
		mutate: (entries: SessionCatalogEntry[]) => { value: T; changed: boolean },
	): Promise<T> {
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				const nextEntries = this.entries.map(cloneEntry);
				const result = mutate(nextEntries);
				if (result.changed) {
					await this.writeSnapshot(nextEntries);
					this.entries = nextEntries;
				}
				return result.value;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private backupFilePath(): string {
		return `${this.filePath}.bak`;
	}

	private async readCatalogFile(filePath: string): Promise<{
		entries: SessionCatalogEntry[];
		dismissedDshSessionIds: Set<string>;
	}> {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionCatalogFile>;
		if (!Array.isArray(parsed.sessions)) {
			throw new Error(`Invalid Session catalog: ${filePath}`);
		}
		const entries = parsed.sessions.filter((entry): entry is SessionCatalogEntry => (
			typeof entry?.id === "string" &&
			typeof entry.projectId === "string" &&
			typeof entry.title === "string" &&
			(entry.environment === "native" || entry.environment === "wsl") &&
			(entry.status === "draft" || entry.status === "active")
		));
		if (entries.length !== parsed.sessions.length) {
			throw new Error(`Session catalog contains invalid records: ${filePath}`);
		}
		const dismissed = Array.isArray(parsed.dismissedDshSessionIds)
			? parsed.dismissedDshSessionIds.filter((id): id is string => (
				typeof id === "string" && id.trim().length > 0
			))
			: [];
		return {
			entries: entries.map(cloneEntry),
			dismissedDshSessionIds: new Set(dismissed),
		};
	}

	private async writeSnapshot(entries: SessionCatalogEntry[]): Promise<void> {
		const snapshot: SessionCatalogFile = {
			version: 1,
			sessions: entries.map(cloneEntry),
			// 旧 catalog 没有该字段；空数组也写出，重启后删除墓碑不丢。
			dismissedDshSessionIds: [...this.dismissedDshSessionIds],
		};
		await mkdir(dirname(this.filePath), { recursive: true });
		const nonce = randomUUID();
		const tempPath = `${this.filePath}.${nonce}.tmp`;
		const backupPath = this.backupFilePath();
		const backupTempPath = `${backupPath}.${nonce}.tmp`;
		try {
			const handle = await open(tempPath, "w");
			try {
				await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}

			if (!this.skipNextBackup) {
				try {
					await copyFile(this.filePath, backupTempPath);
					await renameWithRetry(backupTempPath, backupPath);
				} catch (error) {
					await unlink(backupTempPath).catch(() => undefined);
					if (isMissingFileError(error)) {
						// 首次写入：主文件还不存在，没有可备份的内容，属正常情况
					} else {
						// 备份轮换失败不能阻断 catalog 写入（新建会话等操作会因此失败）：
						// .bak 只是崩溃恢复的冗余副本，主文件仍是原子替换，旧内容在失败时原样保留。
						void getAppLogger()?.warn("session-catalog", "Backup rotation failed, continuing without backup", {
							cause: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			await renameWithRetry(tempPath, this.filePath);
			this.skipNextBackup = false;
		} finally {
			await unlink(tempPath).catch(() => undefined);
			await unlink(backupTempPath).catch(() => undefined);
		}
	}
}

export function didSessionPreferencesChange(
	entry: SessionCatalogEntry,
	patch: Pick<SessionCatalogEntry, "model" | "thinkingLevel">,
): boolean {
	return !equalModel(entry.model, patch.model) || entry.thinkingLevel !== patch.thinkingLevel;
}
