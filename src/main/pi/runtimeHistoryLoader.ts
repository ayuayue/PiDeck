import { stat } from "node:fs/promises";
import type { AgentTab, ChatMessage, SessionMessagePage } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { PiProcess } from "./PiProcess";
import type { AppLogger } from "../logging/AppLogger";
import { SessionHistoryReader, applySessionContextEdits, boundTurnWindowStart } from "./SessionHistoryReader";
import type { StoppedMessageIdentityCache } from "./stoppedMessageIdentity";
import { mergeHistoryWithPreservedMessages, stabilizeProjectedIdsFromIdentities, stabilizeReloadedMessageIds } from "./historyMessages";
import { isRoleMessageRole } from "./sessionEntryIds";
import { estimateMessagesPayloadBytes } from "./messagePayloadSize";
import { countRoleMessagesBefore, stripToolResultForDelivery, trimHistoryMessages, turnTrimStartIndex } from "./agentUtils";

/**
 * 历史加载域协作方的窄接口：全部是「宿主已有单一事实」的读取/发布入口（列表、投影、节流、
 * 会话文件版本），不引入新状态；拆出后 AgentManager 只保留编排与生命周期。
 */
export interface RuntimeHistoryLoaderHost {
	requireRuntime(agentId: string): { tab: AgentTab; process: PiProcess };
	readonly agents: Map<string, { tab: AgentTab; process: PiProcess }>;
	isRemoteRuntime(projectId: string): boolean;
	readonly messages: Map<string, ChatMessage[]>;
	/** 会话历史读取器按需读取：宿主/测试可在构造后替换实现，注入值会读到旧对象。 */
	sessionHistoryReader(): SessionHistoryReader;
	readonly stoppedMessageIdentities: StoppedMessageIdentityCache;
	readonly messageHeadOffsetByAgent: Map<string, number>;
	readonly sessionFileVersionByAgent: Map<string, string>;
	readonly rpcTimeoutMs: number;
	readonly maxHistoryLoadTurns: number;
	readonly appLogger?: AppLogger;
	readonly translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readRecentMessagesFromSessionFile(sessionPath: string, maxTurns: number): Promise<RpcResponse>;
	scanCompactions(sessionPath: string): ReturnType<SessionHistoryReader["scanCompactions"]>;
	buildActiveBranchEntryIds(entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>, leafId: string): string[];
	convertAgentMessages(agentId: string, rawMessages: unknown[], activeEntryIds?: string[]): ChatMessage[];
	computeDisplayWindowStart(messages: ReadonlyArray<{ role?: string }>): number;
	rebindInFlightMessages(agentId: string, nextMessages: ChatMessage[], projectedMessages: ChatMessage[]): void;
	setMessageEmitWindowStart(agentId: string, start: number): void;
	scheduleMessageEmit(agentId: string, immediate?: boolean): void;
	refreshAutoTitle(agentId: string): boolean;
	emitState(): void;
	recordTiming(name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>): void;
	toSessionHostPath(sessionPath: string): string;
	clearAbortedDuringAsk(agentId: string): void;
}

/** 运行期历史窗口加载：`loadMessages` / 缓存优先翻页 / 压缩后单飞重载（拆分第六刀）。 */
export class RuntimeHistoryLoader {
	/** 压缩成功后的在途重载集合（单飞锁），语义见 reloadMessagesAfterCompaction 注释。 */
	private readonly compactionReloadInFlight = new Set<string>();

	constructor(private readonly host: RuntimeHistoryLoaderHost) {}

	private get sessionHistoryReader() {
		return this.host.sessionHistoryReader();
	}

	/** 宿主注入的翻译函数别名：搬出的实现保持 `this.translate(...)` 原样（契约测试按此形态断言）。 */
	private get translate() {
		return this.host.translate;
	}

	/**
	 * 缓存优先的历史翻页：运行中会话的「加载更早对话」先在主进程内存缓存（最近 12 轮）里切片，
	 * 命中则零文件 IO；未命中返回 null，调用方回退 SessionHistoryReader 读文件。
	 *
	 * 游标：beforeEntryId 优先（跨下标空间稳定）；before 为文件绝对下标时先解析成 entryId 再查缓存。
	 * 命中边界：锚点条目必须在缓存中且不是缓存第一条（第一条之前没有缓存内容，交给文件路径）。
	 * 返回页的 nextBefore/nextBeforeEntryId 统一换算回文件下标空间，渲染层续页协议不变。
	 */
	async tryReadRuntimeTurnPage(sessionPath: string, agentId: string, options: { beforeEntryId?: string; before?: number; turnCount?: number }): Promise<SessionMessagePage | null> {
		const runtime = this.host.agents.get(agentId);
		const list = this.host.messages.get(agentId);
		if (!runtime || !list || list.length === 0) return null;
		// 防御：运行时已切到别的会话（替换/重绑）时禁止用其缓存应答本会话的翻页，
		// 交给文件路径（调用方以稳定 sessionId 经 coordinator 解析，此处兜底双保险）。
		if (runtime.tab.sessionPath && this.host.toSessionHostPath(runtime.tab.sessionPath) !== this.host.toSessionHostPath(sessionPath)) {
			return null;
		}

		let pos = -1;
		if (options.beforeEntryId) {
			pos = list.findIndex((m) => m.meta?.entryId === options.beforeEntryId);
		} else if (options.before !== undefined) {
			const entryId = await this.sessionHistoryReader.resolveEntryIdAtPosition(sessionPath, options.before);
			if (!entryId) return null;
			pos = list.findIndex((m) => m.meta?.entryId === entryId);
			// 锚点是缓存最旧条目：缓存里没有比它更早的内容，交给文件路径
			if (pos === 0) return null;
		}
		if (pos < 0) return null;

		const turnCount = Math.min(Math.max(1, Math.floor(options.turnCount ?? 3)), SessionHistoryReader.maxTurnPageSize());
		const roles = list.map((m) => ({ role: m.role, byteLength: 0 }));
		const start = boundTurnWindowStart(roles, pos, turnCount, SessionHistoryReader.maxPageWindowEntries());
		if (start >= pos) return null;
		const page = list.slice(start, pos);
		// 窗口首条常常不是用户/助手消息，而是压缩摘要卡片或工具结果：这两类在会话文件里没有
		// 对应 entry（摘要卡片无条目、工具结果并入上一轮），拿它的 entryId 必然为空，
		// 于是 nextBefore 与 nextBeforeEntryId 双双缺席——渲染层据此判定「已到文件头」，
		// 「加载更多对话」不显示、上滚也不翻页（2026-10 反馈：恢复会话后只剩 9 轮）。
		// 这里向后扫描取第一条带 entryId 的消息当续页锚点：下一页会多回几条与窗口重叠的
		// 消息，渲染层 prefix 合并按 entryId 去重，不会重复渲染（见 prependSessionMessagePageAtom）。
		const pickAnchorEntryId = (items: typeof list): string | undefined => {
			for (const item of items) {
				const id = item?.meta?.entryId;
				if (typeof id === "string" && id) return id;
			}
			return undefined;
		};
		// 回退锚点只能在 page **之前**找，且取离 page 最近的（倒序扫）：
		// 若回退到整个 list，一旦窗口首条无 entryId，锚点必然落到请求锚点自身（list[pos]），
		// nextBefore 原地踏步——每次点「加载更多对话」都返回同一页，界面毫无变化
		// （2026-10 反馈：按钮出现了但点了没反应；关掉 runtime 走文件路径就正常）。
		const pickAnchorEntryIdBefore = (end: number): string | undefined => {
			for (let i = end - 1; i >= 0; i -= 1) {
				const id = list[i]?.meta?.entryId;
				if (typeof id === "string" && id) return id;
			}
			return undefined;
		};
		// 窗口已经贴到缓存最旧条目（start === 0）时**不必**在这里拦：下面 pickAnchorEntryId(page)
		// 取到的是 page 首条的 entryId，它对应文件里的真实位置，nextBefore 因此严格小于本次
		// 锚点，下一次请求会以 pos === 0 再进来、page 为空、落到下面的 !oldestEntryId 分支交回
		// 文件路径——推进不会原地踏步。此前这里直接 return null，把「缓存里还有一整页可用」
		// 的请求也推给磁盘，续页白读一次文件（2026-11 真机：点刻度定位慢）。
		const oldestEntryId = pickAnchorEntryId(page) ?? pickAnchorEntryIdBefore(start);
		// 缓存里没有能当锚点的更早条目：缓存这条线索到此为止，交给文件路径按数值 before 继续翻。
		if (!oldestEntryId) return null;
		// 文件位置 0 = 锚点就在文件头，即「没有更早历史」：必须给 null，与文件路径
		// readTurnPageCore 的 `nextBefore: start > 0 ? start : null` 同一口径。
		// 给 0 的话渲染层按 `nextBefore !== null` 判定还有更早历史，于是「加载更多对话」
		// 永远挂在第一条消息上方，点一次只换来一页空数据、界面毫无变化（2026-12 真机）。
		const anchorPosition = await this.sessionHistoryReader.resolveEntryPosition(sessionPath, oldestEntryId);
		const hasEarlier = typeof anchorPosition === "number" && anchorPosition > 0;
		const nextBefore = hasEarlier ? anchorPosition : null;
		const total = await this.sessionHistoryReader.getActiveEntryCount(sessionPath);
		// 与文件路径同口径的会话文件版本：渲染层据此检测压缩/外部改写并丢弃已缓存的历史前缀
		// （indexVersion 缺失会让 cache 页沿用旧版本，压缩后前缀失效不可见）。
		const indexVersion = await this.sessionHistoryReader.getSessionIndexVersion(sessionPath);
		void this.host.appLogger?.info("agent", "Runtime history cache hit", {
			agentId,
			start,
			pos,
			pageCount: page.length,
			// 续页锚点打出来：「加载更多对话」不出现时，先看这两位是不是都空。
			nextBeforeEntryId: hasEarlier ? oldestEntryId : null,
			nextBefore,
		});
		return {
			// 与文件路径/全量 flush 同口径瘦身：缓存页也必须剥离 meta.result，
			// 否则一次缓存命中会把主进程保留的完整工具结果带回渲染层，
			// 历史前缀的内存会随翻页快速膨胀。
			messages: stripToolResultForDelivery(page),
			total,
			nextBefore,
			...(hasEarlier ? { nextBeforeEntryId: oldestEntryId } : {}),
			indexVersion,
		};
	}
	async loadMessages(agentId: string, skipEntries = false, earlyMessagesPromise?: Promise<RpcResponse>, options?: { preserveMessagesAfter?: number }) {
		const t0 = Date.now();
		const runtime = this.host.requireRuntime(agentId);
		// 远端会话的会话文件在远端：**本地历史读取不参与**。本机 reader 要么读到本机同名路径、
		// 要么 ENOENT 后把会话标成加载失败（用户看到一张凭空的错误卡）。
		// 也不用 `get_messages` 顶替：它会把整段历史打成单行 JSON，PiRpcClient 在 stdout 回调里
		// 同步 JSON.parse 会冻住主进程（见下一条注释），远端历史窗口读取属下一批。
		if (this.host.isRemoteRuntime(runtime.tab.projectId)) {
			return this.host.messages.get(agentId) ?? [];
		}

		const process = runtime.process;
		const { deckSessionId, sessionPath } = runtime.tab;
		// create() 起步的后台历史加载先于协调器 bind 启动：捕获到的 runtimeGeneration 是
		// undefined，随后首次 bind 才写入具体代际。「未绑定 → 首次绑定」是同一运行时的绑定
		// 动作，不是「换了运行时」——按值比较会把新 runtime 的首次历史加载全部误取消，
		// 窗口永远为空（Issue #350：重启后历史加载被取消 → 渲染层只拿到未初始化的空窗口）。
		// 因此首次观察到具体代际时记下它，之后仍严格比较：重新绑定后的迟到结果照常取消。
		let expectedGeneration = runtime.tab.runtimeGeneration;
		const assertCurrentRuntime = () => {
			// 历史读取跨多个 await；发布消息、分页游标和压缩计数前必须仍属于原运行时。
			if (this.host.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.sessionPath !== sessionPath) throw new Error("History load cancelled: runtime changed");
			if (expectedGeneration === undefined) expectedGeneration = runtime.tab.runtimeGeneration;
			else if (runtime.tab.runtimeGeneration !== expectedGeneration) throw new Error("History load cancelled: runtime changed");
		};

		// 有会话文件时禁止再发 get_messages：pi 会把整段历史打成单行 JSON，
		// PiRpcClient 在 stdout data 回调里同步 JSON.parse，主进程事件循环被堵住，
		// 窗口关闭/最小化/设置都点不了。earlyPromise / JSONL 尾部读取才是安全路径。
		const messagesPromise = earlyMessagesPromise ?? (sessionPath ? this.host.readRecentMessagesFromSessionFile(sessionPath, this.host.maxHistoryLoadTurns) : process.client.request({ type: "get_messages" }, this.host.rpcTimeoutMs));

		// 有会话文件时禁止 get_entries：pi 把整棵 entry 树打成单行 JSON，
		// PiRpcClient 同步 JSON.parse 会再冻一次窗口。entryId 从 JSONL 索引取，
		// 与尾部窗口消息一一对应。skipEntries 仍保留给无文件/显式跳过路径。
		let entriesPromise: Promise<{ data?: unknown } | undefined> | undefined;
		const useFileEntryIds = Boolean(sessionPath);
		if (!skipEntries && !useFileEntryIds) {
			entriesPromise = process.client
				.request(
					{
						type: "get_entries",
					},
					15_000,
				)
				.catch(() => {
					// get_entries 失败时不阻塞消息加载；编辑/删除走 fallback（_piDeckMsgSeq 计数）
					void this.host.appLogger?.warn("agent", "Failed to get_entries for entryId mapping", { agentId });
					return undefined;
				});
		}

		const [response, entriesResult] = await Promise.all([messagesPromise, entriesPromise ?? Promise.resolve(undefined)]);
		assertCurrentRuntime();
		const t1 = Date.now();

		const rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];

		// 解析 entryId 列表（需要先于 convertAgentMessages，用于把消息关联到 pi 的会话分支）。
		let activeEntryIds: string[] | undefined;
		if (useFileEntryIds && sessionPath) {
			// 只数消费 entryId 槽位的角色消息：getRecentActiveEntryIds 按同一规则过滤
			// （pi 0.86 的 role:"system" 条目不算槽位，见 sessionEntryIds.isRoleMessageRole）。
			const roleCount = rawMessages.reduce<number>((count, message) => {
				const role = (message as { role?: unknown } | undefined)?.role;
				return count + (isRoleMessageRole(role) ? 1 : 0);
			}, 0);
			activeEntryIds = await this.sessionHistoryReader.getRecentActiveEntryIds(sessionPath, roleCount).catch(() => undefined);
			assertCurrentRuntime();
		} else if (entriesResult) {
			const entriesData = entriesResult.data as { entries?: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>; leafId?: string } | undefined;
			if (entriesData?.entries && entriesData?.leafId) {
				activeEntryIds = this.host.buildActiveBranchEntryIds(entriesData.entries, entriesData.leafId);
			}
		}

		// 按对话轮次截断（保留最近若干轮 user 消息）。压缩摘要不是 user 消息，会被此逻辑保留在尾部，
		// 因此下方会单独把它插到最前面，确保不被按 user 轮次切掉。
		const trimmed = trimHistoryMessages(rawMessages);
		const trimmedStart = turnTrimStartIndex(rawMessages);

		// 身份向量必须与保留消息同步裁剪：activeEntryIds 按「消费槽位的角色消息」与 rawMessages
		// 一一对应，trim 丢弃头部整轮后，若仍把完整 activeEntryIds 交给 projector，保留消息会被
		// 绑定到会话最早的 entry——编辑/删除/重发将落到错误轮次（曾因 15 轮裁剪复现 q4→u1）。
		// compactionSummary/branchSummary 不消费槽位，prepend 到最前不影响对齐。
		let droppedRoleCount = 0;
		if (activeEntryIds && trimmedStart > 0) {
			droppedRoleCount = countRoleMessagesBefore(rawMessages, trimmedStart);
			activeEntryIds = activeEntryIds.slice(droppedRoleCount);
		}
		// 记录缓存头部在文件消息下标空间中的位置：无 entryId 的窗口（skipEntries 大历史路径）
		// 需要用它作为首次补历史的数值游标（渲染层 before=windowStartFilePos）。
		// 窗口条数必须用「message 条目数」而不是角色消息数：readRecordMessagePage 的数值 before
		// 是 activeMessageEntries 下标空间，而 0.86 起窗口里会夹 role:"system" 的 prompt/tool
		// 更新条目，少算会让「加载更多」锚点前移。（trimmedStart 之前的条目已滑出窗口）
		const windowEntryCount = Math.max(0, rawMessages.length - trimmedStart);
		let headOffset: number;
		if (useFileEntryIds && sessionPath && activeEntryIds) {
			// 文件 entryId 已是尾部窗口，不是全量分支：headOffset 必须用
			// 文件总数 - 窗口条数，否则「加载更多」会以为已经在文件头。
			const activeFileCount = await this.sessionHistoryReader.getActiveEntryCount(sessionPath).catch(() => activeEntryIds.length);
			assertCurrentRuntime();
			headOffset = Math.max(0, activeFileCount - windowEntryCount);
		} else if (activeEntryIds) {
			headOffset = droppedRoleCount;
		} else if (sessionPath) {
			// get_entries 失败/未启用（skipEntries）时同样尽力提供数值游标：
			// 否则渲染层「加载更多对话」因 entryId 锚点与 windowStartFilePos 双缺失而静默放弃，
			// 表现为点击无反应（2026-02 修复，此前仅 skipEntries 路径走此兑底）。
			// 最佳努力：文件活动消息数 - 窗口条数 ≈ 被裁头部长度（entryId 锚点仍是首选路径）。
			const activeFileCount = await this.sessionHistoryReader.getActiveEntryCount(sessionPath).catch(() => 0);
			assertCurrentRuntime();
			headOffset = Math.max(0, activeFileCount - windowEntryCount);
		} else {
			headOffset = -1; // 未知：不提供 windowStartFilePos，渲染层回退 entryId 锚点
		}

		// 删除/编辑只向文件追加 context_edit，原文行仍留在尾部窗口里。运行态窗口必须
		// 应用与停止态同一份投影过滤，否则启动 Agent 后被删消息「复活」、编辑回退原文
		// （issue #482）。只过滤投影后的消息，rawMessages / activeEntryIds /
		// windowStartFilePos 仍按原始条数计算（getRecentActiveEntryIds 槽位对齐依赖它）。
		const contextEdits = useFileEntryIds && sessionPath ? await this.sessionHistoryReader.getSessionContextEdits(sessionPath).catch(() => undefined) : undefined;
		assertCurrentRuntime();

		// 解析会话文件里的压缩记录：拿到所有压缩段摘要 + 归档消息。
		// pi 的 get_messages 对压缩会话只返回压缩后的消息，通常不带压缩摘要；
		// 这里从原始会话文件补回：压缩摘要卡片 + 归档消息（支持展开查看压缩前内容）。
		// 若 RPC 已经返回了压缩/分支摘要，则不再重复补，避免时间线出现两张摘要卡片。
		let compactionSummaryRaw: unknown | null = null;
		let compactionCount: number | undefined;
		const rpcAlreadyHasSummary = rawMessages.some((m) => (m as { role?: unknown })?.role === "compactionSummary" || (m as { role?: unknown })?.role === "branchSummary");
		void this.host.appLogger?.info("agent", "Compaction check", {
			agentId,
			hasSessionPath: !!runtime.tab.sessionPath,
			rpcAlreadyHasSummary,
			rawMessageCount: rawMessages.length,
		});
		if (sessionPath) {
			const archiveData = await this.host.scanCompactions(sessionPath).catch((err) => {
				void this.host.appLogger?.warn("agent", "Failed to parse session archives", {
					agentId,
					sessionPath: runtime.tab.sessionPath,
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			});
			assertCurrentRuntime();
			if (archiveData && archiveData.compactions.length > 0) {
				void this.host.appLogger?.info("agent", "Session archives parsed", {
					agentId,
					compactionCount: archiveData.compactions.length,
					rpcAlreadyHasSummary,
				});

				const last = archiveData.compactions[archiveData.compactions.length - 1];

				if (!rpcAlreadyHasSummary) {
					// RPC 未返回摘要 → 我们自己创建压缩卡片（只带元信息，归档消息按需读取）
					compactionSummaryRaw = {
						role: "compactionSummary",
						summary: last.summary || this.translate("session.summaryPlaceholder"),
						timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(),
						meta: {
							compactionId: last.id || null,
							compactionCount: archiveData.compactions.length,
							firstKeptEntryId: last.firstKeptEntryId,
							tokensBefore: last.tokensBefore,
						},
					};
				}
				compactionCount = archiveData.compactions.length;
			}
		}

		// 将压缩摘要插到消息最前面（在 trim 之后，避免被按 user 轮次切掉）。
		const finalRaw = compactionSummaryRaw ? [compactionSummaryRaw, ...trimmed] : trimmed;
		// 文件版本与投影作为同一快照发布；stat 之后不再 await，避免读盘期间清理的状态被补回。
		let fileVersion: string | undefined;
		if (sessionPath) {
			try {
				const version = await stat(this.host.toSessionHostPath(sessionPath));
				fileVersion = `${version.mtimeMs}:${version.size}`;
			} catch {
				// 缺失文件仍可发布已读取的历史，但不能沿用旧版本。
			}
			assertCurrentRuntime();
		}
		this.host.messageHeadOffsetByAgent.set(agentId, headOffset);
		// 把压缩次数写回 tab，供前端（会话头/标签）展示"已压缩 N 次"。
		if (compactionCount !== undefined && runtime.tab.compactionCount !== compactionCount) {
			runtime.tab.compactionCount = compactionCount;
			this.host.emitState();
		}

		const projected = this.host.convertAgentMessages(agentId, finalRaw, activeEntryIds);
		// 投影之后按 meta.entryId 过滤/替换（与停止态、历史页同一个函数）：只有带 entryId 的
		// 消息参与，压缩摘要卡与实时消息原样保留。
		const messages = contextEdits ? applySessionContextEdits(projected, contextEdits) : projected;
		const t2 = Date.now();
		this.host.recordTiming("session.history.load", t0, {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
		});
		void this.host.appLogger?.info("agent", "Agent messages loaded", {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
			trimmedMessages: trimmed.length,
			// 下发体量（近似字节）：判断「渲染进程为何崩」的关键字段（#213）
			payloadBytes: estimateMessagesPayloadBytes(messages),
			requestMs: t1 - t0,
			convertMs: t2 - t1,
			totalMs: t2 - t0,
		});
		// abort 时 ask_question 的 answer 已被覆写为 null，不再需要跟踪
		this.host.clearAbortedDuringAsk(agentId);
		const nextMessages = stabilizeProjectedIdsFromIdentities(
			// 会话级身份延续：新 agent 首次投影时本地缓存为空，把 id 还原成 UI 手里的旧 id
			//（restart/崩溃重连后窗口重下发必须复用旧 key，否则渲染层整窗 remount、动画重放）。
			// list 是捕获先后的完整快照，这里只读不消费——同一会话后续 runtime 仍可继续对齐。
			this.host.stoppedMessageIdentities.list(runtime.tab.sessionPath ? this.host.toSessionHostPath(runtime.tab.sessionPath) : ""),
			stabilizeReloadedMessageIds(this.host.messages.get(agentId) ?? [], mergeHistoryWithPreservedMessages(messages, this.host.messages.get(agentId) ?? [], options?.preserveMessagesAfter)),
		);
		// 重载后把进行中的消息身份（activeAssistantMessageIds/toolMessageIds）从
		// 运行期副本重定向到投影版：后续事件继续更新投影版（位置正确、单份），
		// 避免「投影 partial + 运行期完整版」双份或事件 append 到错误轮次。
		this.host.rebindInFlightMessages(agentId, nextMessages, messages);
		this.host.messages.set(agentId, nextMessages);
		// 显示窗口 = 尾部 9 轮（DOM 3 / atom 9 / main 12 模型；轮次起点对齐 user 消息，
		// 与 disk 轮次分页同一约定；单轮再大也整轮显示，折叠完整性优先），
		// 但叠了条目预算：极端会话下窗口缩轮也不切半轮（#213）。
		this.host.setMessageEmitWindowStart(agentId, this.host.computeDisplayWindowStart(nextMessages));
		// 文件版本随本次加载快照：压缩/外部改写会改变 mtime:size，渲染层据此丢弃 disk 前缀
		if (sessionPath) {
			if (fileVersion !== undefined) this.host.sessionFileVersionByAgent.set(agentId, fileVersion);
			else this.host.sessionFileVersionByAgent.delete(agentId);
		}
		this.host.refreshAutoTitle(agentId);
		this.host.scheduleMessageEmit(agentId, true);
		return nextMessages;
	}
	/**
	 * 压缩成功后的消息重载（单飞）。
	 *
	 * 为什么需要单飞：一次重载 = 读盘整段窗口 + 投影 + 全量下发，是内存峰值最高的路径。
	 * compaction_end 是 RPC 事件，可能在同一时间窗内连发（自动重试的多次压缩、压缩与
	 * 用户发消息、与 agent_settled 后的 trimRuntimeCache 重叠），叠加在途重载会把峰值
	 * 翻好几倍（#213）。这里同一 agent 只保留一次在途：重载本身总在读文件，
	 * 期间到达的后续请求不需要再排一次（晚到的更新由下一次事件或本次读到的尾部覆盖）。
	 */
	reloadMessagesAfterCompaction(agentId: string) {
		if (this.compactionReloadInFlight.has(agentId)) return;
		this.compactionReloadInFlight.add(agentId);
		void this.loadMessages(agentId)
			.catch(() => undefined)
			.finally(() => {
				this.compactionReloadInFlight.delete(agentId);
			});
	}
}
