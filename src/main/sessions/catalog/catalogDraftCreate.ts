import { randomUUID } from "node:crypto";
import type { AgentBackend, SessionChannel, SessionEnvironment, SessionModelPreference, SessionSource } from "../../../shared/types";
import type { SessionCatalogContext, SessionCatalogEntry, SessionTitleOrigin } from "../SessionCatalog";
import { type CatalogMutation, cloneEntry, cloneModelPreference } from "./catalogEntryProjection";

/** createDraft 的宿主持有面：DSH 墓碑集合（读 + 手动找回时删除）、身份上下文与写事务入口。
 *  墓碑必须用方法惰性取：写事务的读步会把宿主的 Set 换成磁盘上的新实例，抓引用会删错集合。 */
export type DraftCreateHost = {
	dismissedDshSessionIds(): Set<string>;
	readonly identityContext: SessionCatalogContext;
	enqueueMutation<T>(mutate: CatalogMutation<T>): Promise<T>;
};

export type CreateDraftInput = {
	projectId: string;
	title: string;
	environment: SessionEnvironment;
	/** 第 12 步：WSL 项目按自己的档案记录身份；缺省时回退 identityContext（兼容旧调用）。 */
	wslDistro?: string;
	wslUser?: string;
	source?: SessionSource;
	backend?: AgentBackend;
	model?: SessionModelPreference;
	thinkingLevel?: string;
	permissionPreset?: string;
	/**
	 * Fresh drafts remain eligible for their first PiDeck automatic or JSONL title,
	 * even when the provisional UI label is not literally "Untitled". Callers that
	 * import an already named external session must opt in to final ownership with
	 * titleOrigin: "manual".
	 */
	titleOrigin?: SessionTitleOrigin;
	/** DSH agent 预设（会话「模式」）草稿期预选；外部会话导入时来自 host 会话 header。 */
	agentPreset?: string;
	/** ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI。 */
	acpToolId?: string;
	/**
	 * 外部连接渠道（微信/飞书桥建的会话）。与 titleOrigin 独立：渠道只决定标志，
	 * 标题所有权由 titleOrigin 决定（IM 桥想要自动命名就不要传 titleOrigin）。
	 */
	channel?: SessionChannel;
	/** 侧边任务会话（右侧抽屉「侧边任务」面板持有）：与 channel 一样只是归属标志，不改变会话身份与运行时语义。 */
	sideTask?: boolean;
	/** 外部（dsh-web 等）会话导入：host 会话已存在，条目直接置 active（重启不清理）。 */
	dshSessionId?: string;
	/**
	 * fork 产物标记（DSH fork/clone 新建条目的身份元数据；pi 侧同名标记来自文件头探测）。
	 * (fork) 标题后缀已写进标题本身，这里只保留「是不是 fork 出来的会话」供列表/导航判断。
	 */
	forked?: boolean;
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
};

export async function createCatalogDraft(host: DraftCreateHost, input: CreateDraftInput): Promise<SessionCatalogEntry> {
	const entry = await host.enqueueMutation((entries) => {
		const now = Date.now();
		// 幂等去重：DSH 外部会话按 host 会话 id 唯一映射。同一 dshSessionId 重复
		// 导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）时
		// 不再新建条目，只更新标题/项目归属——否则侧栏出现两条同 host 会话记录，
		// 且删除其一后另一条仍可加载同一 host 数据（「重复导入」用户问题）。
		if (input.dshSessionId) {
			const dismissed = host.dismissedDshSessionIds().has(input.dshSessionId);
			const existing = entries.find((candidate) => candidate.dshSessionId === input.dshSessionId);
			// 用户已删映射、host 目录还在：自动同步不得再建条目。手动找回才允许。
			if (dismissed && !input.restoreDismissed && !existing) {
				throw new Error("DISMISSED_DSH_SESSION");
			}
			const forgotten = input.restoreDismissed ? host.dismissedDshSessionIds().delete(input.dshSessionId) : false;
			if (existing) {
				const nextTitle = input.keepExistingTitle ? existing.title : input.title;
				const agentPresetChanged = input.agentPreset !== undefined && existing.agentPreset !== input.agentPreset;
				const changed =
					forgotten ||
					existing.projectId !== input.projectId ||
					existing.title !== nextTitle ||
					existing.backend !== input.backend ||
					agentPresetChanged ||
					(input.forked === true && existing.forked !== true) ||
					existing.status !== "active" ||
					// mtime 变化也落盘：修正历史被顶高的 updatedAt，否则排序永远错
					existing.updatedAt !== (input.updatedAt ?? now);
				existing.projectId = input.projectId;
				existing.title = nextTitle;
				existing.backend = input.backend;
				existing.status = "active";
				// 外部会话 header 携带的 preset 变化（host 会话 header 是权威）随导入同步
				if (input.agentPreset !== undefined) existing.agentPreset = input.agentPreset;
				// fork 产物可能是外部同步先导入、fork 命令后到：标记只增补不清空。
				if (input.forked) existing.forked = true;
				// 排序语义：用磁盘日志文件 mtime（真实活跃时间），不再顶到导入时刻
				existing.updatedAt = input.updatedAt ?? now;
				return { value: cloneEntry(existing), changed };
			}
		}
		const nextEntry: SessionCatalogEntry = {
			id: randomUUID(),
			projectId: input.projectId,
			title: input.title,
			// 导入已有 host 会话（带 dshSessionId）标题已由 host 确认；纯草稿留一次领取机会。
			titleLocked: (input.titleOrigin ?? (input.dshSessionId ? "manual" : undefined)) !== undefined,
			titleOrigin: input.titleOrigin ?? (input.dshSessionId ? "manual" : undefined),
			source: input.source ?? "pi",
			environment: input.environment,
			channel: input.channel,
			// 只落 true：false 与缺省同义，不写进存档省得 JSON 里堆噪声字段
			sideTask: input.sideTask ? true : undefined,
			forked: input.forked ? true : undefined,
			backend: input.backend,
			// 第 12 步：显式身份优先；旧调用没有时仍回退全局上下文。
			wslDistro: input.environment === "wsl" ? (input.wslDistro ?? host.identityContext.wslDistro) : undefined,
			wslUser: input.environment === "wsl" ? (input.wslUser ?? host.identityContext.wslUser) : undefined,
			// 带 dshSessionId = 导入已有 host 会话（数据在 $DSH_HOME），
			// 不是「尚未发送」的草稿：置 active，重启清理/重新打开都按真实会话处理。
			status: input.dshSessionId ? "active" : "draft",
			model: cloneModelPreference(input.model),
			thinkingLevel: input.thinkingLevel,
			permissionPreset: input.permissionPreset,
			agentPreset: input.agentPreset,
			acpToolId: input.acpToolId,
			dshSessionId: input.dshSessionId,
			createdAt: now,
			// 外部会话导入带 mtime（真实活跃时间）；pi 草稿没有该字段，仍用当前时刻
			updatedAt: input.updatedAt ?? now,
		};
		entries.push(nextEntry);
		return { value: cloneEntry(nextEntry), changed: true };
	});
	return entry;
}
