import { app } from "electron";
import { isLocalProject } from "../../shared/projectLocation";
import { agentEventTags } from "../../shared/ipc";
import type { SessionRecord } from "../../shared/types";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { acpMessagePage } from "../acp/acpMessagePage";
import { runForScatteredSubtreeFiles } from "../sessions/sessionSubtreeFiles";
import { findSessionMatches } from "../sessions/sessionFindMatches";
import { refreshModelList, fetchModelList } from "../pi/modelListCache";
import { removeProjectWithSessions } from "../projects/projectRemoval";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";
import type { WebServiceDependencies } from "../web/WebServiceManager";
import type { WebServiceContext } from "./webServiceContext";

/**
 * Web 服务依赖装配（第一部分）：令牌/事件订阅/项目与会话 CRUD/历史读取与检索/额度探针。
 *
 * 自 index.ts 的 `new WebServiceManager({...})` 对象字面量就地外移（2027-02 拆分），
 * 键顺序与代码逐字保持；晚装配的单例（catalog/运行时协调器/ACP/模型能力缓存/外网编排器）
 * 一律经 ctx 的 getter 现读，与搬迁前读取模块级 `let` 的时机一致。
 * 第二半在 webServiceDepsRuntime.ts，两半在 webService.ts 里按顺序拼成完整 deps。
 */
export function createWebSurfaceDeps(ctx: WebServiceContext) {
	const {
		settingsStore,
		appLogger,
		agentManager,
		dshAgentManager,
		dshHost,
		projectStore,
		sessionScanner,
		piLocator,
		configManager,
		getSessionCatalog,
		getSessionRuntimeCoordinator,
		getAcpAgentManager,
		getPiModelCapabilityCache,
		getRemoteAccessManager,
		mainCopy,
		shouldUseDevRendererUrl,
		sessionScannerForProject,
		wslSessionScannerFor,
		emitSessionRuntimeEvent,
		notifyCatalogRefreshed,
		createAnonymousSession,
		copyCatalogSession,
		exportCatalogSessionHtml,
		readCatalogSessionReferenceMessages,
		sessionMessageSearchInFile,
		sessionCommandIpcError,
		wechatServiceRef,
	} = ctx;

	return {
		// 令牌持久化回写：manager 内自动生成/轮换/手动修改后落盘，重启沿用同一令牌。
		persistToken: (state) => {
			void settingsStore.update({ webServiceToken: state.token, webServiceTokenGeneratedAt: state.generatedAt, webServiceTokenExpiresIn: state.expiresIn }).catch((error) => appLogger.error("[WebService] persist token failed", error));
		},
		// dev 模式（electron-vite dev 不产出 out/renderer 构建物）下，静态资源
		// 代理到 vite dev server，外部 Web 端加载重构后的 React 版页面并支持热更新；
		// 打包/正式构建走 out/renderer 构建产物，此值为空。
		devRendererUrl: shouldUseDevRendererUrl() ? process.env.ELECTRON_RENDERER_URL : undefined,
		// 订阅 pi agent 事件流：供 Web SSE 端点转发给浏览器（与 FeishuBridge 同源机制）。
		subscribePiEvents: (handler) => agentManager.addLocalEventListener((agentId, event) => handler(agentId, event as never)),
		// agentId → sessionId 路由：pi 事件只有 agentId，SSE 连接按 session 订阅。
		getSessionIdForAgent: (agentId) => getSessionRuntimeCoordinator().getSessionId(agentId),
		// 非 pi 后端（DSH）的通道事件：正文/思考/工具卡不在 pi 事件流里。只订 DSH 网关，
		// 不能订 compositeAgentGateway（它把 pi 的 agents:text-stream 一并转发，会与上面
		// 的 pi 事件源重复推帧）。agents:state 是数组无 agentId，天然被过滤。
		subscribeAgentChannelEvents: (handler) =>
			dshAgentManager.onOutput((channel, payload) => {
				const agentId = payload && typeof payload === "object" && "agentId" in payload ? (payload as { agentId?: unknown }).agentId : undefined;
				if (typeof agentId !== "string") return;
				handler(agentId, channel, payload);
			}),
		// ACP 后端的实时流：会话正文在 agents:message 投影快照里（全量替换），
		// 回合终态只在 agents:runtime-state 里（settleAcpTurn 在工具-only 回合不写任何标记）。
		// 同 DSH 只订各自的 manager，不订聚合网关（否则会把 pi 帧重复翻译一遍）。
		subscribeAcpChannelEvents: (handler) =>
			getAcpAgentManager()?.onOutput((channel, payload) => {
				const agentId = payload && typeof payload === "object" && "agentId" in payload ? (payload as { agentId?: unknown }).agentId : undefined;
				if (typeof agentId !== "string") return;
				handler(agentId, channel, payload);
			}) ?? (() => {}),
		// ACP 工具清单（只给 id/name，command/args/env 不外发）：Web 端后端选择器的 ACP 入口。
		// 未开启 ACP 或没有启用的工具时返回空数组，Web 端就不展示 ACP 选项。
		// EasyTier 托管配置下载：手机端「导入配置」用；未配置时返回空串（路由 404）
		getEasyTierConfigToml: () => getRemoteAccessManager()?.buildEasyTierConfigToml() ?? "",
		listAcpTools: () => {
			const settings = settingsStore.get();
			if (settings.acpEnabled !== true) return [];
			return (settings.acpTools ?? []).filter((tool) => tool.enabled).map((tool) => ({ id: tool.id, name: tool.name }));
		},
		// 宿主版本号：/api/state 的 version 投影，Web 端侧栏底栏展示。
		getAppVersion: () => app.getVersion(),
		listProjects: () => projectStore.list().filter(isLocalProject),
		createProject: (path) => projectStore.add(path, undefined, settingsStore.get().wslEnabled ? "wsl" : "windows"),
		deleteProject: async (projectId) => {
			if (!projectStore.get(projectId) || projectStore.get(projectId)?.kind === "chat") return false;
			const childIds = projectStore.listWorktreeChildren(projectId).map((child) => child.id);
			// 与 IPC 同一顺序：先清 catalog 引用再删项目（见 removeProjectWithSessions）。
			await removeProjectWithSessions({ projects: projectStore, sessions: getSessionCatalog() }, projectId, { childProjectIds: childIds });
			return true;
		},
		listModels: async (force?: boolean) => {
			const snapshot = force ? await getPiModelCapabilityCache()?.refresh() : await getPiModelCapabilityCache()?.ensure();
			return snapshot?.models ?? (force ? refreshModelList(piLocator, settingsStore, configManager) : fetchModelList(piLocator, settingsStore, configManager));
		},
		listSessions: async (projectId) => {
			const project = projectStore.get(projectId);
			return (await sessionScannerForProject(project)).list(project?.path);
		},
		listCatalogSessions: async (projectId) => {
			// 与桌面 sessionsListCatalog 同规则：重发/编辑 fork 化后被替换的旧会话
			// （supersededBy 已打标）从列表隐藏，否则 Web 端会出现「两个重复的会话」。
			if (!projectId) {
				return getSessionCatalog()
					.listEntries()
					.map((entry) => getSessionCatalog().getRecord(entry.id))
					.filter((record): record is SessionRecord => Boolean(record) && !record?.supersededBy);
			}
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			// 本地 sessionScanner 不能扫远端项目（远端会话扫描属 Phase 4）。
			if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			let projectPath = project.path;
			const settings = settingsStore.get();
			const wsl = resolveProjectWslIdentity(project, settings);
			if (wsl !== undefined) {
				projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
			}
			const scanner = wsl !== undefined ? await wslSessionScannerFor(wsl) : sessionScanner;
			const summaries = await scanner.list(projectPath);
			const scanned = await getSessionCatalog().mergeScanned(projectId, summaries, wsl !== undefined ? { wslDistro: wsl.distro, wslUser: wsl.user } : {});
			// 同上：supersededBy 隐藏规则与桌面列表一致（mergeScanned 可能重新接上被打标的旧会话）
			const records = scanned.filter((record) => !record.supersededBy);
			const bindings = getSessionRuntimeCoordinator().attachCatalogRuntimes(records);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			return records;
		},
		createSessionDraft: async (input) => {
			const project = projectStore.get(input.projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
			// 后端白名单（渲染层输入不可信）：只认 dsh/acp，其余按 pi；acp 必须带工具 id。
			const backend = input.backend === "dsh" ? "dsh" : input.backend === "acp" ? "acp" : undefined;
			const acpToolId = backend === "acp" && typeof input.acpToolId === "string" ? input.acpToolId : undefined;
			// ACP 的模型/思考由 agent CLI 自持（session/config options），PiDeck 的 models.json
			// 对它无意义：与桌面 IPC（sessionIpc createDraft 的 nonPiBackend 分支）同规，不写偏好。
			const acp = backend === "acp";
			// 晚装配单例在回调入口取一次当前实例（本块构造时 catalog 还未赋值）。
			const sessionCatalog = getSessionCatalog();
			const draft = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: projectWsl !== undefined ? "wsl" : "native",
				...(projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {}),
				backend,
				acpToolId,
				model: !acp && input.model ? createSessionModelPreference(input.model.provider, input.model.modelId, input.model.modelName) : undefined,
				thinkingLevel: acp ? undefined : input.thinkingLevel,
			});
			// standby 补热：与桌面 IPC（sessionIpc createDraft）同款——Web 建草稿即「马上要开聊」，
			// 趁用户输入空窗后台预热 pi 进程；首条消息经 activateRuntime 认领实现秒级启动。
			// fire-and-forget；ensure 幂等且受 standbyRuntimeEnabled 设置闸。
			if (draft.backend !== "dsh" && draft.backend !== "acp") agentManager.ensureStandbyAgent(draft.projectId);
			// Web 建的草稿不是渲染进程发的：不广播侧栏就一直看不到这一行（issue #436 同类缺口）。
			notifyCatalogRefreshed([draft.projectId]);
			return draft;
		},
		createAnonymousSession,
		updateSessionRecord: async (sessionId, patch) => {
			const entry = getSessionCatalog().get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
				// Keep the same manual-over-auto ordering as the IPC domain handler.
				await getSessionCatalog().claimTitleOwnership(sessionId);
				const target = getSessionRuntimeCoordinator().getTarget(sessionId);
				if (target) {
					const renamed = await getSessionRuntimeCoordinator().renameRuntime(target, title);
					if (!renamed.ok) throw sessionCommandIpcError(renamed.error);
				} else if (entry.filePath) {
					await sessionScanner.rename(entry.filePath, title);
				}
			}
			const updated = await getSessionCatalog().update(sessionId, {
				...patch,
				...(patch.model ? { model: createSessionModelPreference(patch.model.provider, patch.model.modelId, patch.model.modelName) } : {}),
				title: title || undefined,
			});
			// 改名/换模型都是从 Web 端改的，侧栏标题不重拉就一直停在旧名上（issue #436）。
			notifyCatalogRefreshed([updated.projectId]);
			return updated;
		},
		deleteSessionRecord: async (sessionId) => {
			const entry = getSessionCatalog().get(sessionId);
			if (!entry) return false;
			// Web 删除与桌面 IPC 同一策略：先解绑再删 catalog，agent 后台停。
			const sessionRuntimeCoordinator = getSessionRuntimeCoordinator();
			await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
			// 微信桥的绑定指向已删会话时必须一起清掉：留着它下次收信会拿旧 sessionPath
			// 去恢复一个刚被删掉的文件，聊天就永久卡在「会话创建失败」。
			// （飞书侧同样存在这个悬挂，但那是既存行为，不在微信通道的改动范围内。）
			wechatServiceRef.current?.removeBindingsForSession(sessionId);
			// 用记录上的本机路径：getLocalFilePath 对 ssh locator 会抛 UNSUPPORTED_PROJECT_LOCATION（远端记录没有本机文件可删）。
			if (entry.filePath) await sessionScanner.delete(entry.filePath);
			// 平铺子代理（与父会话同目录）不在 `<stem>/` 里：不单独清就会留着失去父节点的会话文件（#539）。
			if (entry.filePath) {
				const leftover = await runForScatteredSubtreeFiles({ catalog: getSessionCatalog(), sessionId, parentFilePath: entry.filePath, environment: entry.environment, run: (filePath) => sessionScanner.delete(filePath) });
				if (leftover.length > 0) void appLogger.warn("session", "Catalog session delete left scattered subtree files", { sessionId, failures: leftover });
			}
			// DSH 没有 session.delete：与 pi 端同语义删除——把 host 会话目录移入系统回收站
			// （可恢复；trashPath 失败时抛错由 IPC 呈现，拒绝静默硬删；目录已不在=幂等成功）。
			// cwd 取项目目录（DSH workspace 编码同源）；项目被移除过则扫 sessions 树兑底。
			if (entry.backend === "dsh" && entry.dshSessionId) {
				const project = projectStore.get(entry.projectId);
				await dshHost.deleteSession(entry.dshSessionId, project?.path ?? "");
				// 记下墓碑：host 目录已移出 sessions 树，避免刷新把残留索引/回收站路径再导回侧栏。
				await getSessionCatalog().rememberDismissedDshSession(entry.dshSessionId);
			}
			await getSessionCatalog().removeWithDescendants(sessionId);
			// 删除成功后才广播：渲染层收到事件会立刻重拉列表，早发会把刚删的行再拉回来一次。
			// 缺这一句 = 通过 Web API 删会话后桌面端留下幽灵行（issue #436）。
			notifyCatalogRefreshed([entry.projectId]);
			return true;
		},
		copySessionRecord: async (sessionId) => {
			const result = await copyCatalogSession(sessionId);
			if (result.cancelled) return result;
			// 副本同样是 Web 端发起的：不广播侧栏要等手动刷新才出现新行（issue #436）。
			const projectId = (result.targetSessionId ? getSessionCatalog().get(result.targetSessionId)?.projectId : undefined) ?? getSessionCatalog().get(sessionId)?.projectId;
			if (projectId) notifyCatalogRefreshed([projectId]);
			return result;
		},
		exportSessionRecordHtml: (sessionId) => exportCatalogSessionHtml(sessionId),
		readSessionReferenceMessages: (sessionId) => readCatalogSessionReferenceMessages(sessionId),
		readSessionMessages: async (sessionId) => {
			const entry = getSessionCatalog().get(sessionId);
			// DSH 会话没有 pi 会话文件：读 host 历史事件流的一页（有界），
			// 与分页路径同源；未挂载 DSH 后端时返回空窗口。
			if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
				const page = await dshAgentManager.readHistoryPage(entry.dshSessionId, undefined, { maxMessages: 1000 });
				return { messages: page.messages, total: page.total, windowStart: 0, truncated: false };
			}
			// ACP 会话同样没有 pi 会话文件：历史来自运行时投影 / 内存快照 / deck 侧归档
			// （readMessagesWithArchive 异步读口）。没有 acpSessionId（草稿）或归档为空时
			// 退化成空窗口，与分页接口同源（acpMessagePage 按轮次切片）。
			if (entry?.backend === "acp" && entry.acpSessionId) {
				const messages = await getAcpAgentManager().readMessagesWithArchive(entry.acpSessionId);
				return { messages, total: messages.length, windowStart: 0, truncated: false };
			}
			if (!entry?.filePath) return { messages: [], total: 0, windowStart: 0, truncated: false };
			// 有界加载窗口（9 轮 + 条目预算），不是全量历史：全量下发在大会话上会同时顶爆
			// 主进程与渲染层（#213）。更早历史请走分页接口（Web：/messages/page）。
			const window = await agentManager.readSessionLoadWindow(entry.filePath, sessionId, { projectId: entry.projectId });
			return { ...window, truncated: window.windowStart > 0 };
		},
		readSessionMessagePage: async (sessionId, before, pageSize) => {
			const entry = getSessionCatalog().get(sessionId);
			// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
			// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）。
			if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
				return dshAgentManager.readHistoryPage(entry.dshSessionId, before, { turnCount: pageSize });
			}
			// ACP 分页：归档/投影消息按轮次切片（与桌面 IPC sessions:catalog-read-message-page 同源）。
			if (entry?.backend === "acp" && entry.acpSessionId) {
				return acpMessagePage(await getAcpAgentManager().readMessagesWithArchive(entry.acpSessionId), before, pageSize);
			}
			if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
			return agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, undefined, { projectId: entry.projectId });
		},
		// 会话内全文检索（Web 搜索弹层）：与桌面 IPC sessions:search-in-session 同源口径——
		// 入参是 SessionRecord.id，后端身份一律从 catalog 解析（Web 端传不了路径）；pi 走
		// session-index sidecar（索引未就绪 → null，前端回退本地已加载搜索），DSH 走 host
		// 历史投影后本地词元匹配。命中 id 是 JSONL 行 id，与 Web 消息 id 同源可直接锚定。
		searchSessionMessages: async (sessionId, query) => {
			const entry = getSessionCatalog().get(sessionId);
			if (!entry) return null;
			if (entry.backend === "dsh") {
				const dshSessionId = entry.dshSessionId;
				const searcher = dshSessionId ? dshAgentManager : null;
				if (!dshSessionId || !searcher) return null;
				try {
					const found = await searcher.searchSessionMessages(dshSessionId, query);
					if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
					return {
						sessions: [{ filePath: `dsh:${dshSessionId}`, updatedAtMs: entry.updatedAt, matches: found.matches, hitCount: found.hitCount }],
						totalHitSessions: 1,
						truncated: found.hitCount > found.matches.length,
					};
				} catch {
					return null;
				}
			}
			// ACP：没有 pi JSONL，历史来自运行时投影 / 内存快照 / deck 侧归档（异步读口）。
			// 匹配规则与桌面 IPC 的 ACP 分支同源（findSessionMatches），命中 id 是投影消息 id。
			if (entry.backend === "acp") {
				const acpSessionId = entry.acpSessionId;
				if (!acpSessionId) return null;
				try {
					const messages = await getAcpAgentManager().readMessagesWithArchive(acpSessionId);
					const found = findSessionMatches(messages, query);
					if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
					return {
						sessions: [{ filePath: `acp:${acpSessionId}`, updatedAtMs: entry.updatedAt, matches: found.matches, hitCount: found.hitCount }],
						totalHitSessions: 1,
						truncated: found.hitCount > found.matches.length,
					};
				} catch {
					return null;
				}
			}
			if (!entry.filePath) return null;
			return sessionMessageSearchInFile(entry.filePath, query);
		},
		// 供应商额度用量：与桌面圆球面板同一份 ConfigManager 探针（含凭据脱敏与「未开启」门控）。
		fetchProviderUsage: (provider, backend) => configManager.fetchProviderUsage(provider, backend),
	} satisfies Partial<WebServiceDependencies>;
}
