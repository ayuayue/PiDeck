import type { SessionRecord } from "../../shared/types";

/**
 * DSH 外部会话同步（跨工具兼容深化）：把 DSH_HOME 里由 dsh-web 等其他工具创建的
 * host 根会话映射进 PiDeck catalog，侧栏即可直接查看/加载/续聊。
 *
 * 本模块只做编排与纯策略（选项目、过滤已导入、标题归一），不碰 Electron：
 * - 幂等由 SessionCatalog.createDraft 的 dshSessionId 去重保证（重复导入只更新不新增）；
 * - 目标项目按会话自己的 cwd：已注册则挂入该项目，未注册则按该目录创建项目；
 *   只有没有 cwd 的会话才进入「外部会话」兑底项目（不能把不同目录堆在一起）；
 * - shouldRegisterCwd=false（已删项目 / 临时隔离目录 / 磁盘不存在）时跳过该条，
 *   既不建项目也不兑底；
 * - dismissedDshSessionIds（用户删过的 host 会话）批量同步跳过，避免目录还在时刷新复活；
 * - 标题优先官方投影缓存 / 日志 session/title / 首条提示回退；再缺才用 cwd 末段或 i18n。
 * - 批量同步禁止走 resolveHostTitle / sessions.history：那会 attach 冷会话，
 *   与 dsh-web 抢同一份 DSH_HOME（官方不支持双 host）。
 */

/** host sessions.list 的一行外部根会话（DshHost.listForeignSessions 的返回形状）。 */
export type DshForeignSessionItem = {
	dshSessionId: string;
	title?: string;
	cwd?: string;
	/** 会话创建时组合的 agent preset（header passthrough；导入后头部胶囊展示）。 */
	agentPreset?: string;
	updatedAt?: number;
};

/** 一次同步的结果统计（供配置页提示/日志）。 */
export type DshForeignSyncResult = {
	/** 本轮实际导入的会话数（含重复导入被去重吸收的——语义上仍是「已入册」）。 */
	imported: number;
	/** 已在 catalog 中、本轮跳过的会话数（仅在传入 knownIds 时统计）。 */
	skipped: number;
};

export type DshForeignSyncDeps = {
	/** host 侧外部根会话清单。 */
	listForeignSessions: () => Promise<DshForeignSessionItem[]>;
	/** 按目录找已注册项目（无匹配返回 null）。 */
	findProjectByPath: (cwd: string) => { id: string } | null;
	/** 兑底项目（仅无 cwd 时使用；惰性创建一次）。 */
	ensureFallbackProject: () => Promise<{ id: string }>;
	/**
	 * 会话有自己的工作目录但尚未注册项目时，按该目录创建/复用项目。
	 * 缺省则退回兑底（测试/旧装配）；生产必须提供，否则不同目录会堆在一起。
	 */
	ensureProjectForCwd?: (cwd: string) => Promise<{ id: string }>;
	/**
	 * 自动导入是否允许按该 cwd 建项目。
	 * 返回 false 时本条会话跳过（不兑底、不注册），避免已删/临时/缺失目录重启后复活。
	 */
	shouldRegisterCwd?: (cwd: string) => boolean | Promise<boolean>;
	/** catalog 映射写入（幂等：同 dshSessionId 已存在时更新并返回既有记录）。 */
	createDraft: (input: {
		projectId: string;
		title: string;
		environment: "native" | "wsl";
		backend: "dsh";
		dshSessionId: string;
		/**
		 * 会话真实活跃时间（磁盘日志文件 mtime）。批量同步每轮都会全量重导所有外部会话，
		 * 不带这个就用 Date.now()，DSH 会话每次重启被顶到启动时刻、永远排在 pi 会话上面。
		 * 语义与 pi 会话一致（扫描器用文件 mtime 当 updatedAt）。
		 */
		updatedAt?: number;
		agentPreset?: string;
		keepExistingTitle?: boolean;
		/** 仅手动导入为 true；批量同步不得清删除墓碑。 */
		restoreDismissed?: boolean;
	}) => Promise<SessionRecord>;
	/** 已映射记录（纠正归属时判断现有标题是不是 cwd 兑底占位）。 */
	getExistingDraft?: (dshSessionId: string) => { title: string } | undefined;
	/** 当前环境（native/wsl）。 */
	getEnvironment: () => "native" | "wsl";
	/**
	 * list 投影缺失标题时的兜底标题（i18n：DSH 会话）。
	 * 必须是惰性取值（函数或 getter）：装配对象在模块顶层创建时
	 * settingsStore 尚未赋值，eager `mainCopy()` 会在加载期崩溃。
	 */
	fallbackTitle: string | (() => string);
	/** 可选标题补全（仅单条手动导入用；批量同步不要传——会 attach host 会话）。 */
	resolveHostTitle?: (dshSessionId: string) => Promise<string | undefined>;
	/** 单条导入失败回调（不阻断其余会话；缺省静默）。 */
	onError?: (dshSessionId: string, error: unknown) => void;
	/** 用户主动删除过的 DSH host 会话。自动同步跳过；手动导入不走这里。 */
	dismissedDshSessionIds?: () => ReadonlySet<string>;
};

/** 标题归一：空串/纯空白视为缺失。 */
export function normalizeForeignTitle(title: string | undefined): string | undefined {
	return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/** catalog 中已映射的 host 会话 id 集合（导入过滤/去重用）。 */
export function knownForeignSessionIds(entries: ReadonlyArray<{ dshSessionId?: string }>): Set<string> {
	const known = new Set<string>();
	for (const entry of entries) {
		if (entry.dshSessionId) known.add(entry.dshSessionId);
	}
	return known;
}

/** 按 cwd 过滤出尚未导入的外部会话（纯函数）。 */
export function splitForeignSessions(items: readonly DshForeignSessionItem[], knownIds: ReadonlySet<string>): { pending: DshForeignSessionItem[]; imported: DshForeignSessionItem[] } {
	const pending: DshForeignSessionItem[] = [];
	const imported: DshForeignSessionItem[] = [];
	for (const item of items) {
		(knownIds.has(item.dshSessionId) ? imported : pending).push(item);
	}
	return { pending, imported };
}

/** 项目选择结果：已匹配 / 待按 cwd 注册 / 无目录兑底。 */
export type ForeignProjectPick = {
	/** 已能确定的项目 id；cwd 待注册时为空，由 ensureProjectForCwd 补上。 */
	projectId?: string;
	matched: boolean;
	/** 未注册但会话自带的工作目录，调用方应按此建项目，不能丢进兑底。 */
	cwdToRegister?: string;
};

/**
 * 决定外部会话的目标项目（纯策略）：
 * cwd 命中已注册项目 → 该项目；
 * cwd 存在但未注册 → 返回 cwdToRegister（按会话自己的目录建项目）；
 * 无 cwd → 兑底项目。
 */
export function pickProjectForForeignSession(item: DshForeignSessionItem, findProjectByPath: (cwd: string) => { id: string } | null, fallbackProjectId: string): ForeignProjectPick {
	if (item.cwd) {
		const matched = findProjectByPath(item.cwd);
		if (matched) return { projectId: matched.id, matched: true };
		return { matched: false, cwdToRegister: item.cwd };
	}
	return { projectId: fallbackProjectId, matched: false };
}

/** 解析兜底标题：字符串原样返回，函数在使用时再取（避免模块加载期调 i18n）。 */
export function resolveFallbackTitle(fallbackTitle: string | (() => string)): string {
	return typeof fallbackTitle === "function" ? fallbackTitle() : fallbackTitle;
}

/** 从 cwd 取侧栏可读名（末段目录）；无路径时返回 undefined。 */
export function cwdDisplayName(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const trimmed = cwd.replace(/[\\/]+$/, "").trim();
	if (!trimmed) return undefined;
	const parts = trimmed.split(/[\\/]/);
	const last = parts[parts.length - 1]?.trim();
	return last || undefined;
}

/** 目录末段 / i18n 兑底——不是 dsh-web 那种投影标题，纠正归属时可以被官方缓存覆盖。 */
export function isPlaceholderForeignTitle(title: string | undefined, cwd: string | undefined, fallbackTitle: string): boolean {
	const normalized = normalizeForeignTitle(title);
	if (!normalized) return true;
	if (normalized === fallbackTitle) return true;
	const folder = cwdDisplayName(cwd);
	return Boolean(folder && normalized === folder);
}

/** 解析最终标题：投影 > 可选 host 补全 > cwd 末段 > 兜底标题。 */
export async function resolveForeignSessionTitle(item: DshForeignSessionItem, fallbackTitle: string, resolveHostTitle?: (dshSessionId: string) => Promise<string | undefined>): Promise<string> {
	const projected = normalizeForeignTitle(item.title);
	if (projected) return projected;
	if (resolveHostTitle) {
		const hostTitle = await resolveHostTitle(item.dshSessionId);
		const normalized = normalizeForeignTitle(hostTitle);
		if (normalized) return normalized;
	}
	return cwdDisplayName(item.cwd) ?? fallbackTitle;
}

/**
 * 导入单个外部会话（幂等）。item 未给出时按 dshSessionId 从清单反查；
 * 目标项目与标题按上面的策略解析，最后经 createDraft 落 catalog（重复导入被吸收）。
 * @param allowHostTitle 仅手动单条导入为 true；批量同步必须 false，避免 attach。
 * @param keepExistingTitle 纠正归属时保留 catalog 已有「真实」标题。
 * 上一轮用 cwd 末段兑底的占位名不算真实标题：官方投影缓存有 title 时要覆盖上去。
 */
export async function importForeignSession(deps: DshForeignSyncDeps, dshSessionId: string, item?: DshForeignSessionItem, allowHostTitle = true, keepExistingTitle = false): Promise<SessionRecord> {
	// 手动单条导入（allowHostTitle）才清墓碑；批量同步与它同开关，避免刷新把刚删的映射写回。
	const restoreDismissed = allowHostTitle;
	let target = item;
	if (!target) {
		const items = await deps.listForeignSessions();
		target = items.find((candidate) => candidate.dshSessionId === dshSessionId);
	}
	if (!target) throw new Error(`Foreign DSH session not found: ${dshSessionId}`);
	const projectId = await resolveForeignProjectId(deps, target);
	// 批量同步禁止 host 标题补全：resolveHostTitle 会 sessions.history，抢 dsh-web。
	const fallback = resolveFallbackTitle(deps.fallbackTitle);
	const title = await resolveForeignSessionTitle(target, fallback, allowHostTitle ? deps.resolveHostTitle : undefined);
	const existing = deps.getExistingDraft?.(dshSessionId);
	const projected = Boolean(normalizeForeignTitle(target.title));
	// 已有真实标题且本轮仍没有投影名：保住旧名，避免 cwd 末段盖掉 host 回写。
	// 已有占位名但本轮读到投影：必须写回，否则侧栏永远停在目录名。
	const retainTitle = keepExistingTitle && existing && !isPlaceholderForeignTitle(existing.title, target.cwd, fallback) && !projected;
	return deps.createDraft({
		projectId,
		title,
		environment: deps.getEnvironment(),
		backend: "dsh",
		dshSessionId,
		// 排序语义：updatedAt 用磁盘日志文件 mtime，而不是导入时刻——
		// 否则每轮全量重导都会把 DSH 会话顶到“现在”，重启后永远排在 pi 会话上面。
		...(target.updatedAt !== undefined ? { updatedAt: target.updatedAt } : {}),
		...(target.agentPreset ? { agentPreset: target.agentPreset } : {}),
		...(retainTitle ? { keepExistingTitle: true } : {}),
		...(restoreDismissed ? { restoreDismissed: true } : {}),
	});
}

/**
 * 解析最终项目 id：已注册 → 用该项目；有 cwd 未注册 → 按目录建项目；无 cwd → 兑底。
 * 有自己目录时绝不进兑底，否则 dsh-web 里按 workspace 分开的会话会堆在「外部会话」里。
 */
export async function resolveForeignProjectId(deps: DshForeignSyncDeps, item: DshForeignSessionItem): Promise<string> {
	const picked = pickProjectForForeignSession(item, deps.findProjectByPath, "__fallback__");
	if (picked.matched && picked.projectId) return picked.projectId;
	if (picked.cwdToRegister) {
		if (deps.shouldRegisterCwd && !(await deps.shouldRegisterCwd(picked.cwdToRegister))) {
			// 已删记录 / 临时隔离目录 / 磁盘不存在：不建项目、也不塞进兑底。
			throw new Error("FOREIGN_CWD_NOT_REGISTERED");
		}
		if (deps.ensureProjectForCwd) {
			return (await deps.ensureProjectForCwd(picked.cwdToRegister)).id;
		}
	}
	// 无 cwd，或装配未提供按目录建项目（测试/旧路径）才兑底。
	return (await deps.ensureFallbackProject()).id;
}

/**
 * 全量同步外部会话：catalog 未映射的导入；已映射的也再走一遍以按 cwd 纠正归属
 * （上一版把未注册目录全塞进兑底，启动时要把它们拆回各自目录）。
 * 单条失败只记日志不阻断其余。
 */
export async function syncForeignSessions(deps: DshForeignSyncDeps, knownIds?: ReadonlySet<string>): Promise<DshForeignSyncResult> {
	const items = await deps.listForeignSessions();
	let imported = 0;
	let skipped = 0;
	// 已在 catalog 的也再导入一遍：createDraft 按 dshSessionId 幂等更新项目归属，
	// 把上一版堆在「外部会话」兑底里的会话拆回各自 cwd 对应的项目。
	for (const item of items) {
		// 墓碑每次现读：同步开始时拍快照会漏掉循环中途的右键删除，
		// 再叠上 createDraft 清墓碑，删掉的映射就会写回侧栏。
		const dismissed = deps.dismissedDshSessionIds?.() ?? new Set<string>();
		if (dismissed.has(item.dshSessionId)) {
			skipped += 1;
			continue;
		}
		const alreadyKnown = Boolean(knownIds?.has(item.dshSessionId));
		try {
			await importForeignSession(deps, item.dshSessionId, item, false, alreadyKnown);
			if (alreadyKnown) skipped += 1;
			else imported += 1;
		} catch (error) {
			// 主动拒绝注册的 cwd、或用户已删映射：计入 skipped，不是导入失败。
			if (error instanceof Error && (error.message === "FOREIGN_CWD_NOT_REGISTERED" || error.message === "DISMISSED_DSH_SESSION")) {
				skipped += 1;
				continue;
			}
			deps.onError?.(item.dshSessionId, error);
		}
	}
	return { imported, skipped };
}
