/**
 * 会话消息读取 IPC：全量消息 / 分支树 / 子代理 / 任务快照 / 消息分页。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import type { SessionRecord, SessionBranchTree, SessionMessagePage, SessionModelPreference } from "../../shared/types";
import { dshUnavailablePageFor } from "../dsh/dshManualStop";
import { dshRuntimeMissingPageFor } from "../dsh/dshRuntimeMissing";
import { dshSessionModelPatch } from "../dsh/dshSessionModelSync";
import { missingSessionFilePage } from "../sessions/sessionFileMissingPage";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "../pi/derivedSubagents";
import { isRecord, parseSessionId } from "./sessionIpcInputGuards";
import { acpMessagePage } from "../acp/acpMessagePage";
import type { SessionIpcDeps, DshBackendIpcDeps } from "./sessionIpc";

function parseSessionPageCursor(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_SESSION_PAGE_CURSOR");
	return value;
}

function parseSessionPageSize(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("INVALID_SESSION_PAGE_SIZE");
	return value;
}

function parseSessionPageOptions(value: unknown): { beforeEntryId?: string } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "beforeEntryId")) throw new Error("INVALID_SESSION_PAGE_OPTIONS");
	if (value.beforeEntryId === undefined) return {};
	if (typeof value.beforeEntryId !== "string" || !value.beforeEntryId.trim() || value.beforeEntryId.length > 256) throw new Error("INVALID_SESSION_PAGE_OPTIONS");
	return { beforeEntryId: value.beforeEntryId };
}

export type SessionMessageReadIpcDeps = Pick<SessionIpcDeps, "sessionCatalog" | "sessionRuntimeCoordinator" | "agentManager" | "appLogger" | "getMainWindow" | "readImageSessionMessages" | "readRemoteSessionHistoryPage" | "readVideoSessionMessages"> & {
	/** 本组用到的 DSH 后端读口（未装配 = 无 DSH 后端）。 */
	dshBackend?: Pick<DshBackendIpcDeps, "readDshHistoryPage" | "readAcpMessages" | "readDshSessionModel">;
};

export function registerSessionMessageReadIpc(deps: SessionMessageReadIpcDeps): void {
	const { sessionCatalog, sessionRuntimeCoordinator, agentManager, appLogger, getMainWindow, readImageSessionMessages, readRemoteSessionHistoryPage, readVideoSessionMessages, dshBackend } = deps;
	const { readDshHistoryPage, readAcpMessages, readDshSessionModel } = dshBackend ?? {};
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);
	/**
	 * 历史页读取后把文件里的最后模型/思考档位补回 catalog。
	 * 仅补缺失字段，避免旧历史读取覆盖用户后来明确选择的值；运行中 runtime
	 * 有自己的 state，历史回放不参与覆盖。
	 */
	const backfillHistoricalSessionMetadata = async (sessionId: string, metadata: Pick<SessionMessagePage, "model" | "thinkingLevel">): Promise<void> => {
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend === "dsh" || !localSessionFilePath(sessionId)) return;
		if (entry.model && entry.thinkingLevel) return;
		if (!metadata.model && !metadata.thinkingLevel) return;
		try {
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend === "dsh" || !localSessionFilePath(sessionId)) return;
			const patch: {
				model?: SessionModelPreference;
				thinkingLevel?: string;
				updatedAt: number;
			} = { updatedAt: current.updatedAt };
			if (!current.model && metadata.model) patch.model = createSessionModelPreference(metadata.model.provider, metadata.model.modelId, undefined);
			if (!current.thinkingLevel && metadata.thinkingLevel) {
				patch.thinkingLevel = metadata.thinkingLevel;
			}
			if (!patch.model && patch.thinkingLevel === undefined) return;
			const updated = await sessionCatalog.update(sessionId, patch);
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "Historical session metadata backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	/**
	 * DSH 历史会话的模型/档位补录（冷读 host 投影，不激活会话）。
	 *
	 * 为什么需要：`SessionRecord.model` 只在用户「通过 PiDeck 改模型」时写入，历史/外部
	 * DSH 会话的模型只存在 host 会话投影（modelSelection.next ?? lastUsed）里。catalog 缺
	 * model 时底栏回退「部署默认模型」这个全局单值——线上案例：会话实际 magpie/group/free，
	 * 底栏却显示部署默认 magpie/group/auto（用户表现为「改了一个会话，其他会话的模型显示
	 * 也跟着变」）。打开会话读历史时顺带冷读一次补回 catalog，之后底栏/选择器就有真值。
	 *
	 * 与 pi 的同名补录同纪律：只补缺失字段、不覆盖用户显式选择（dshSessionModelPatch 保证）；
	 * updatedAt 沿用当前值，避免「打开会话」把侧栏排序搅乱。运行中会话由 runtime state 展示，
	 * 不参与补录（host 投影的 next 是临时态，不写入持久记录）。失败只记日志、不影响历史展示。
	 */
	const backfillDshSessionModel = async (sessionId: string): Promise<void> => {
		if (!readDshSessionModel) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend !== "dsh" || !entry.dshSessionId) return;
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		if (entry.model && entry.thinkingLevel) return;
		try {
			const selection = await readDshSessionModel(entry.dshSessionId);
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend !== "dsh") return;
			const patch = dshSessionModelPatch(current, selection);
			if (!patch) return;
			const updated = await sessionCatalog.update(sessionId, { ...patch, updatedAt: current.updatedAt });
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "DSH session model backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	/**
	 * 冷启动里程碑（3/3）：首个会话列表返回。前两个里程碑（app ready / first window shown）
	 * 记在 index.ts，但用户真正看到内容要等这次扫描结束；scanMs 单独拆出来，才能区分
	 * 「窗口起得慢」和「会话扫描慢」（侧栏扫描是唯一未进 sidecar 的机械成本，见
	 * docs/archive/plans/session-data-plane-plan.md §7）。只在首个请求记录一次，切项目不再刷屏。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessages, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		const sessionFilePath = localSessionFilePath(sessionId);
		// DSH 会话没有 pi 会话文件：全量读走 host 历史事件流（一次拉最大页），
		// 与分页路径同源；未装配 readDshHistoryPage 时返回空数组。
		if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
			const page = await readDshHistoryPage(entry.dshSessionId, undefined, { maxMessages: 1000 });
			// 与分页路径同源：打开会话顺带补录 host 会话模型（冷读，不激活）。
			void backfillDshSessionModel(sessionId);
			return page.messages;
		}
		// ACP 会话历史:agent 侧 load 重放(权威) + 运行时内存投影 + deck 侧归档(重启/换机后
		// 的唯一来源)。无 runtime 时读归档,仍是空才返回空数组(渲染层显示起始页)。
		if (entry?.backend === "acp") {
			return readAcpMessages ? await readAcpMessages(entry.acpSessionId ?? "") : [];
		}
		if (entry?.backend === "imagegen") {
			// imagegen 后端会话：历史独立存 ImageSessionStore，不走 pi 文件
			return (await readImageSessionMessages?.(sessionId)) ?? [];
		}
		if (entry?.backend === "videogen") {
			// videogen 后端会话：历史独立存 VideoSessionStore（任务占位/终态按消息 id 折叠）
			return (await readVideoSessionMessages?.(sessionId)) ?? [];
		}
		if (!sessionFilePath) return [];
		// 有界「加载窗口」（9 轮 + 条目预算），不是全量历史：整量读出在大会话上
		// 会同时顶爆主进程与渲染层（#213）；需要更早历史走 readRecordMessagePage。
		const window = await agentManager.readSessionLoadWindow(sessionFilePath, sessionId, entry ? { projectId: entry.projectId } : undefined);
		const messages = window.messages;
		const metadata = await agentManager.readSessionDisplayMetadata(sessionFilePath);
		await backfillHistoricalSessionMetadata(sessionId, metadata);
		return messages;
	});
	/** 会话分支树（右侧抽屉「分支」面板）：只读文件索引，无需活 runtime；DSH/imagegen 无 pi 文件返回 null。 */
	ipcMain.handle(ipcChannels.sessionsGetBranchTree, async (_event, sessionId: unknown): Promise<SessionBranchTree | null> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid branch-tree request");
		const entry = sessionCatalog.get(sessionId);
		// DSH / imagegen / videogen 会话没有 pi JSONL：面板按空态处理，不报错。
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen" || entry.backend === "acp") return null;
		return agentManager.readSessionBranchTree(entry.filePath);
	});
	/** 子代理列表：从会话文件 subagents:record + catalog 子会话回填合成。 */
	ipcMain.handle(ipcChannels.sessionsListSubagents, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) return [];
		// 锚点对账要在读取侧做（liveRuntimeStartedAt）：record 完成时才写，运行中
		// 子代理只剩 start 锚点，不传对账时间会一律合成 stopped，面板在子代理
		// 实际运行期间误显「已停止」（issue #300）。本代派发的锚点 → running。
		const liveTarget = sessionRuntimeCoordinator.getTarget(sessionId);
		const liveTab = liveTarget ? agentManager.list().find((t) => t.id === liveTarget.agentId) : undefined;
		let records = await agentManager.readSessionSubagentRecords(entry.filePath, { liveRuntimeStartedAt: liveTab?.createdAt });
		// acp_delegate 推导条目在会话无活 runtime 时残留的 running 视为已终止：
		// 终态通知没写进文件（进程被杀/崩溃）的委托在历史会话里永远是 running，
		// 会误导为仍在运行；活会话保持 running，由后续通知/桥接覆盖。
		// 与 start 锚点残留合成 stopped 同一语义（见 downgradeStaleRunning）。
		if (!liveTarget) {
			if (!sessionRuntimeCoordinator.isActivating(sessionId)) {
				records = downgradeStaleRunning(records);
			}
		} else {
			// 活 runtime 也要对账：本代 runtime 启动（tab.createdAt）之前派发的
			// running/queued 已随上一代 pi 进程消亡，永远等不到终态写盘。渲染层
			// hook 在绑定出现时会重新拉取本列表，激活完成后即看到降级结果
			//（2026-09-14 用户环境实测：真实活动子代理 0，历史投影仍显示 33 个
			// running；启动之后派发的异步运行不受影响，保持 running）。
			if (liveTab?.createdAt) {
				records = downgradeRunningStartedBefore(records, liveTab.createdAt);
			}
		}
		// 回填 childSessionPath：按 parentSessionPath === 本会话 filePath 收集所有子会话，
		// 再按子会话名 `${type}#${id前8位}` 精确匹配。
		const children = sessionCatalog
			.listEntries()
			.filter((e) => e.parentSessionPath === entry.filePath)
			.map((e) => sessionCatalog.getRecord(e.id))
			.filter((r): r is NonNullable<typeof r> => r != null);
		for (const record of records) {
			const namePrefix = `${record.type}#${record.id.slice(0, 8)}`;
			const child = children.find((s) => (s.title ?? "").startsWith(namePrefix));
			const childSessionPath = child?.locator?.kind === "local" ? child.locator.filePath : undefined;
			if (childSessionPath) record.childSessionPath = childSessionPath;
			if (child) record.childSessionId = child.id;
		}
		// 列举子代理时顺带刷新会话级性能区间（按 id 幂等覆盖，重复列举不会膨胀）；
		// 读接口不推状态事件，避免把「看子代理列表」变成高频 runtime 推送。
		if (liveTarget?.agentId) {
			agentManager.syncSubagentPerfSpans(liveTarget.agentId, records, { emit: false });
		}
		return records;
	});
	/** 会话级 todo 快照：从会话文件 pi-deck-todo custom 条目重建最新计划（历史会话任务 tab）。 */
	ipcMain.handle(ipcChannels.sessionsListSessionTodo, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		// DSH/生图/生视频会话无 pi 会话文件，无 todo 快照
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen") return undefined;
		return agentManager.readSessionTodo(entry.filePath);
	});

	ipcMain.handle(ipcChannels.sessionsCatalogReadMessagePage, async (_event, rawSessionId: unknown, rawBefore?: unknown, rawPageSize?: unknown, rawOptions?: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const before = parseSessionPageCursor(rawBefore);
		const pageSize = parseSessionPageSize(rawPageSize);
		const options = parseSessionPageOptions(rawOptions);
		const entry = sessionCatalog.get(sessionId);
		// 顺序要求（2026-10 修复）：远端分流必须在 `localSessionFilePath(sessionId)` **之前**——那一步对 ssh locator
		// 抛稳定码，放在前面会让整个远端分支变成不可达的死代码（重启后打开远端会话读不到历史的真因；运行中会话走
		// runtime 内存消息，所以真机验收当时没抓到）。
		// 远端会话的 catalog 记录是 ssh locator（`normalizeEntryLocator` 已清空 filePath）：本地路径读取对它
		// 永远不存在，落到下面的「无会话文件」分支会把远端历史读成空页并被 force 写进缓存。这里按 locator
		// 路由到远端有界读取（同一个 SessionMessagePage 契约，渲染层无需分叉）。
		const remoteLocator = entry?.locator?.kind === "ssh" ? entry.locator : undefined;
		if (remoteLocator) {
			// 游标含义：本地页是「活动分支消息下标」，这里是**远端文件字节偏移**（上一个窗口首行的偏移）；
			// 两者都是 number|null 的同一契约字段。`options.beforeEntryId` 是本地缓存路径的锚点，对远端不适用。
			if (!readRemoteSessionHistoryPage) throw new Error("REMOTE_SESSION_HISTORY_UNAVAILABLE");
			try {
				return await readRemoteSessionHistoryPage({ hostId: remoteLocator.hostId, locator: remoteLocator, ...(typeof before === "number" ? { before } : {}) });
			} catch (error) {
				// 失败必须是**可见的结构化失败**：渲染层靠 reject 显示明确错误态，而不是拿到空页
				// 当成「这个会话没有历史」（远端路径/命令行/远端 stderr 都不进日志，只记稳定码与身份）。
				appLogger.warn("session", "Read remote session history page failed", {
					sessionId,
					hostId: remoteLocator.hostId,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
		if (entry?.backend === "acp") return acpMessagePage((await readAcpMessages?.(entry.acpSessionId ?? "")) ?? [], before, pageSize);
		// 顺序要求（2026-10 修复）：本机路径解析必须在远端分流之后 —— ssh 条目的 filePath 在规范化时
		// 已被清空，一旦远端分支被挪到它后面就会变成不可达的死代码。合并后本机路径就是 dev 的
		// `entry.filePath`（不再额外调 localSessionFilePath：它对 ssh 抛稳定码，且夹具无需提供该端口）。
		// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
		// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）；
		// 第三条参数在 pi 路径是「轮数」，所以 DSH 这里按 turnCount 传（main 侧换算消息预算）。
		if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
			try {
				const page = await readDshHistoryPage(entry.dshSessionId, before, { turnCount: pageSize });
				// 打开会话（首屏/上翻）顺带把 host 会话模型补录回 catalog：
				// 冷会话真值只在 host 投影里，缺 model 时底栏会错误显示全局部署默认。
				void backfillDshSessionModel(sessionId);
				return page;
			} catch (error) {
				// 手动停止态下历史读取必然失败且不会自愈（预热/按需兜底/崩溃重启全被门控）：
				// 转成带原因的空页，让渲染层出「运行时已停止 + 启动 host」专态，而不是把
				// host 未运行报成「会话文件已删除/路径失效」——DSH 会话没有 pi 会话文件。
				// 其余错误（host 崩溃 / 文件损坏）继续抛，渲染层按普通失败处理。
				// 运行时未安装（#375）与手动停止一样属于「可解释的不可用」，同样不该把原始
				// MODULE_NOT_FOUND 抛给渲染层；其余错误（host 崩溃 / 文件损坏）继续抛。
				const unavailable = dshUnavailablePageFor(error) ?? dshRuntimeMissingPageFor(error);
				if (unavailable) return unavailable;
				throw error;
			}
		}
		if (entry?.backend === "imagegen" || entry?.backend === "videogen" || !entry?.filePath) {
			// imagegen/videogen 后端会话（可能残留无意义 pi filePath）或纯生图草稿：
			// 走独立存储恢复历史（生图 ImageSession / 生视频 VideoSession），避免落到不存在的 pi 文件
			const independentMessages = entry?.backend === "videogen" ? ((await readVideoSessionMessages?.(sessionId)) ?? []) : ((await readImageSessionMessages?.(sessionId)) ?? []);
			if (independentMessages.length > 0) {
				return {
					messages: independentMessages,
					total: independentMessages.length,
					nextBefore: null,
				};
			}
			return { messages: [], total: 0, nextBefore: null };
		}
		// 读盘失败（文件被删/路径失效/解析异常）不能静默：渲染层靠 reject 显示明确错误态，
		// 否则「正在加载历史」骨架无限滞留（2026-08 生图会话文件缺失反馈）。
		try {
			let page: SessionMessagePage;
			// Pi 历史统一按完整轮次分页：磁盘会话首次打开、继续上翻、
			// 以及运行时窗口补历史都共享同一页边界和游标协议。
			// 缓存优先（2026-11）：运行中会话翻历史先在主进程内存缓存切片，命中免文件 IO；
			// 未命中（缓存未覆盖/非活跃会话）回退 SessionHistoryReader 读文件。
			// 注意：缓存按 transient agentId 键控，必须经 coordinator 把稳定 sessionId
			// 解析成当前运行时 agentId；解析不到（非活跃/终端绑定）直接走文件路径。
			if (options?.beforeEntryId || typeof before === "number") {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const cached = await agentManager
						.tryReadRuntimeTurnPage(entry.filePath, target.agentId, {
							beforeEntryId: options?.beforeEntryId,
							before,
							turnCount: pageSize,
						})
						.catch(() => null);
					if (cached) return cached;
				}
			}
			page = await agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, options?.beforeEntryId, { projectId: entry.projectId });
			await backfillHistoricalSessionMetadata(sessionId, page);
			return page;
		} catch (error) {
			// 文件还不存在（新建会话在发出第一条消息前不落盘，微信/飞书桥建的会话尤其常见）：
			// 这是「还没有内容」而不是读取故障，返回带原因的友好空页，
			// 避免把 ENOENT 报成「会话历史加载失败/文件已删除」（2026-10 微信 /new 反馈）。
			const missingFile = missingSessionFilePage(error);
			if (missingFile) {
				appLogger.info("session", "Read message page: session file not written yet", { sessionId, filePath: entry.filePath });
				return missingFile;
			}
			// 文件读取失败（被删/路径失效）先查 ImageSession 兜底，命中则直接恢复历史；
			// 都无记录才按失败处理（渲染层显示明确错误态 + 日志）。
			const imageSessionMessages = (await readImageSessionMessages?.(sessionId)) ?? [];
			if (imageSessionMessages.length > 0) {
				return {
					messages: imageSessionMessages,
					total: imageSessionMessages.length,
					nextBefore: null,
				};
			}
			appLogger.warn("session", "Read message page failed", {
				sessionId,
				filePath: entry.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
}
