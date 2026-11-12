/**
 * 会话 catalog 写入 IPC：草稿创建 / 引导页默认解析 / 匿名会话 / 记录更新（改名、切后端）/ 删除。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import { runForScatteredSubtreeFiles } from "../sessions/sessionSubtreeFiles";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { modelThinkingLevelOf } from "../../shared/modelThinkingLevels";
import { isDshAgentPresetLocked } from "../../shared/dshAgentPresetLock";
import type { AvailableModel, CreateSessionDraftInput, CreateAnonymousSessionInput, UpdateSessionRecordInput, SessionCommandError, SessionModelPreference, ResolveLaunchDefaultsInput, ResolvedLaunchDefaults } from "../../shared/types";
import { resolveLaunchDefaultOptions, isModelInModelsConfig } from "../sessions/launchDefaults";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import type { AppLogger } from "../logging/AppLogger";
import { isRecord, logSessionCommandFailure, parseSessionId } from "./sessionIpcInputGuards";
import type { SessionIpcDeps, DshBackendIpcDeps } from "./sessionIpc";

/** Normalize untrusted model input before it reaches the persisted catalog. */
function normalizeSessionModelPreference(input: unknown): SessionModelPreference | undefined {
	if (!isRecord(input) || typeof input.provider !== "string" || typeof input.modelId !== "string" || (input.modelName !== undefined && typeof input.modelName !== "string")) return undefined;
	const provider = input.provider.trim();
	const modelId = input.modelId.trim();
	if (!provider || !modelId || provider.length > 128 || modelId.length > 256 || (typeof input.modelName === "string" && input.modelName.length > 256)) return undefined;
	return createSessionModelPreference(provider, modelId, input.modelName);
}

function sessionCommandIpcError(error: SessionCommandError, appLogger: Pick<AppLogger, "warn">, mainCopy: (key: string, params?: Record<string, string | number>) => string): SessionCommandIpcError {
	logSessionCommandFailure(appLogger, error);
	return new SessionCommandIpcError(error, mainCopy);
}

export type SessionCatalogWriteIpcDeps = Pick<SessionIpcDeps, "projectStore" | "settingsStore" | "sessionScanner" | "sessionCatalog" | "sessionRuntimeCoordinator" | "agentManager" | "configManager" | "appLogger" | "mainCopy" | "createAnonymousSession"> & {
	/** 本组用到的 DSH 后端读口（未装配 = 无 DSH 后端）。 */
	dshBackend?: Pick<DshBackendIpcDeps, "canCreateDshSession" | "getDshRuntimeStatus">;
	/** 模型存在性校验数据源（capability 快照 ∪ CLI 缓存，与模型选择器同源）。 */
	selectableModels: () => AvailableModel[] | null | undefined;
};

export function registerSessionCatalogWriteIpc(deps: SessionCatalogWriteIpcDeps): void {
	const { projectStore, settingsStore, sessionScanner, sessionCatalog, sessionRuntimeCoordinator, agentManager, configManager, appLogger, mainCopy, createAnonymousSession, selectableModels, dshBackend } = deps;
	const { canCreateDshSession, getDshRuntimeStatus } = dshBackend ?? {};
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);
	ipcMain.handle(ipcChannels.sessionsCatalogCreateDraft, async (_event, input: CreateSessionDraftInput) => {
		const project = projectStore.get(input.projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		// DSH runtime 门控（AgentRuntimeProvider 阶段 1）：runtime 不可用时拒绝新建
		// dsh 会话——渲染层已按安装态隐藏入口，这里是边界防御（设置残留 dsh /
		// 渲染层旧版本）。既有 dsh 会话不受影响（打开/发送走运行时链路，不在此处）。
		if (input.backend === "dsh" && canCreateDshSession?.() !== true) {
			// outdated（版本不一致）单独给文案：不是「没装」，是装了但不配套，
			// 用户需要的是重装而不是困惑于「明明装了却说未安装」。
			if (getDshRuntimeStatus?.().state === "outdated") {
				throw new Error(mainCopy("session.dshRuntimeOutdated"));
			}
			throw new Error(mainCopy("session.dshRuntimeNotInstalled"));
		}
		// Auto-fill model / thinkingLevel from pi config when the caller hasn't
		// provided them, so the composer bar shows the effective default.
		// DSH 后端不适用 pi 的模型配置（模型路由由 DSH host 自己的 settings 决定）：
		// **显式传入的 model 仍然接受**（issue #253）——引导页在 DSH 态下的点选必须带到会话上，
		// 否则 host 只能用部署默认（settings.yaml 的 agent-default-model），用户表现为
		// 「切到 DSH 后模型换不了」。与侧栏「新建会话后切 DSH 再选模型」走 updateRecord 的
		// 既有链路保持一致：只做形状归一化，不用 models.json 校验（DSH 的 provider 是
		// host route 名，不在 models.json 里，校验会把合法选择全丢掉）。模型是否被 host
		// 接受由激活时的 applyPreferences → DshAgentManager.setModel 裁决（host 拒绝时
		// 降级到部署默认并告警，不让创建失败）。
		// 缺省模型仍不从 pi 配置解析：DSH 没有可读的启动默认解析器（部署默认由 host 自己决定）。
		// 思考档位值域与 DSH 兼容（off/high/max 等），新会话默认档位同样填充——否则 DSH
		// 新会话的思考按钮只显示「思考」而非实际默认档位。
		let model = normalizeSessionModelPreference(input.model);
		let thinkingLevel = input.thinkingLevel;
		const nonPiBackend = input.backend === "dsh" || input.backend === "acp";
		if ((!nonPiBackend && !model) || !thinkingLevel) {
			try {
				const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
				// 引导页/渲染层显式传入的模型（如欢迎页偏好）也可能指向已删除的供应商/模型：
				// 校验其仍存在（models.json ∪ pi 目录，与选择器可选范围一致），不存在则交给
				// 解析器按欢迎页点选 → 配置默认 → enabledModels → lastUsed 的顺序兜底，
				// 避免新会话带着幽灵模型启动。
				if (!nonPiBackend && model) {
					if (
						typeof model.provider !== "string" ||
						typeof model.modelId !== "string" ||
						!isModelInModelsConfig(
							modelsResult.parsed,
							{
								provider: model.provider,
								modelId: model.modelId,
							},
							selectableModels(),
						)
					) {
						model = undefined;
					}
				}
				// 缺省填充与引导页展示共用同一解析器（launchDefaults），
				// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
				// 欢迎页偏好（renderer localStorage）同样经主进程校验存在性后按
				// 「欢迎页点选 > 显式默认 > enabledModels > 上次使用 > 空」参与解析；
				// explicit model（用户主动指名）仍优先于一切（input.model，见上方校验）。
				const defaults = resolveLaunchDefaultOptions({
					backend: input.backend,
					settings: settingsResult.parsed,
					models: modelsResult.parsed,
					// pi 目录（同步读）：lastUsed/welcomeModel 的存在性校验按
					// models.json ∪ capability 快照判定，与选择器可选范围一致。
					catalogModels: selectableModels(),
					// lastUsed 语义：用户最近一次实际发送所用模型；仅无显式默认与偏好时参与。
					lastUsedModel: settingsStore.get().lastUsedModel,
					welcomeModel: input.welcomeModel && typeof input.welcomeModel.provider === "string" && typeof input.welcomeModel.modelId === "string" ? input.welcomeModel : undefined,
				});
				if (!nonPiBackend && !model) {
					model = defaults.model;
				}
				if (!thinkingLevel) {
					// 每模型默认档位优先于全局默认，且必须按**最终生效的模型**查（显式传入的
					// model / welcomeModel 可能不是解析器选出的默认模型）：pi 在新建与切换模型时
					// 都按「显式选择 > 每模型默认 > 全局默认」解析再 clamp，这里同序才能保证
					// 首轮请求用的档位与引导页底栏展示的一致。DSH 无 pi 模型身份，跳过。
					const perModelThinkingLevel = !nonPiBackend && model && typeof model.provider === "string" && typeof model.modelId === "string" ? modelThinkingLevelOf(settingsResult.parsed, model.provider, model.modelId) : undefined;
					thinkingLevel = perModelThinkingLevel ?? defaults.thinkingLevel;
				}
			} catch {
				// Config read is best-effort; draft creation must never block.
			}
		}
		const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
		const draft = await sessionCatalog.createDraft({
			projectId: input.projectId,
			...(projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {}),
			title: input.title?.trim() || mainCopy("session.newTitle"),
			// 第 12 步：会话按项目档案记录环境；旧项目回退全局设置。
			environment: projectWsl !== undefined ? "wsl" : "native",
			// 后端透传：仅接受白名单枚举，其余视为 pi（渲染层不可信输入校验在边界）。
			backend: input.backend === "dsh" ? "dsh" : input.backend === "acp" ? "acp" : undefined,
			// ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI。
			acpToolId: input.backend === "acp" && typeof input.acpToolId === "string" ? input.acpToolId : undefined,
			model,
			thinkingLevel,
			// 渲染层输入不可信：侧边任务只认显式 true，其余（含任意真值）按普通会话建。
			sideTask: input.sideTask === true,
		});
		void appLogger.info("session", "Session draft created", {
			sessionId: draft.id,
			projectId: input.projectId,
			title: draft.title,
			model: draft.model,
		});
		// standby 补热：草稿创建是「用户马上要开聊」的最强信号，趁用户阅读/输入的空窗
		// 后台预热一个 pi 进程待命（fire-and-forget；ensure 幂等且受 standbyRuntimeEnabled 闸）。
		if (!nonPiBackend) agentManager.ensureStandbyAgent(input.projectId);
		return draft;
	});
	ipcMain.handle(ipcChannels.sessionsResolveLaunchDefaults, async (_event, input?: ResolveLaunchDefaultsInput): Promise<ResolvedLaunchDefaults> => {
		// 渲染层输入不可信：backend 只认白名单枚举，其余按非 DSH（pi）解析。
		const backend = input?.backend === "dsh" ? "dsh" : input?.backend === "acp" ? "acp" : undefined;
		try {
			const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
			return resolveLaunchDefaultOptions({
				backend,
				settings: settingsResult.parsed,
				models: modelsResult.parsed,
				// 与 createDraft 同源：存在性校验含 capability 快照（auth 渠道模型也在内），
				// 否则引导页预选与创建再次分叉。
				catalogModels: selectableModels(),
				// lastUsed 语义：引导页预选默认 = 用户最后一次实际使用的模型。
				lastUsedModel: settingsStore.get().lastUsedModel,
			});
		} catch {
			// 配置读取失败返回空默认：引导页退回「无预选」形态，不阻塞 UI；
			// 创建会话链路自身仍会 best-effort 重试。
			return {};
		}
	});
	ipcMain.handle(ipcChannels.sessionsCreateAnonymous, async (_event, input: CreateAnonymousSessionInput) => {
		// 与 createDraft 同一 DSH runtime 门控：匿名会话同样不能落在不可用后端上。
		if (input.backend === "dsh" && canCreateDshSession?.() !== true) {
			if (getDshRuntimeStatus?.().state === "outdated") {
				throw new Error(mainCopy("session.dshRuntimeOutdated"));
			}
			throw new Error(mainCopy("session.dshRuntimeNotInstalled"));
		}
		const result = await createAnonymousSession(input);
		void appLogger.info("session", "Anonymous session created", {
			sessionId: result.session.id,
			projectId: input.projectId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUpdate, async (_event, sessionId: string, patch: UpdateSessionRecordInput) => {
		// 渲染层输入不可信：侧边任务标记只认真值 true 与 null（清除），其余按「本次不改」处理。
		if (patch.sideTask !== undefined && patch.sideTask !== true && patch.sideTask !== null) {
			patch = { ...patch, sideTask: undefined };
		}
		const normalizedModel = patch.model === undefined ? undefined : patch.model === null ? null : normalizeSessionModelPreference(patch.model);
		if (patch.model !== undefined && patch.model !== null && !normalizedModel) {
			throw new Error(mainCopy("session.invalidModel"));
		}
		if (patch.model !== undefined) {
			patch = { ...patch, model: normalizedModel };
		}
		const entry = sessionCatalog.get(sessionId);
		if (!entry) throw new Error(mainCopy("session.notFound"));
		// 后端锁定（草稿期可改，激活后禁止）：pi 会话文件（JSONL）与 DSH 会话
		// （host session log）格式不同，中途切换会导致消息同步渲染不可靠。
		// 已 active 的会话拒绝 backend 变更（渲染层已隐藏入口，这里是边界防御）。
		// 未 active 但在预热激活中的会话**不**拒绝：旧实现在这里用 getTarget 当闸门，而预热期间
		// 绑定尚未建立（ACP 握手在 bind 之前），target 为空→闸门放行，旧激活随后才把旧后端进程
		// 绑到已经切走的会话上。现在改为主动作废旧激活（停进程 + 禁 bind），用户不用等握手。
		if (patch.backend !== undefined && patch.backend !== entry.backend) {
			if (entry.status === "active") throw new Error(mainCopy("session.backendLocked"));
			await sessionRuntimeCoordinator.cancelActivation(sessionId);
		}
		// ACP 换工具同理：激活链按工具表 spawn，旧工具的握手不得绑到已换工具的会话。
		if (patch.acpToolId !== undefined && patch.acpToolId !== entry.acpToolId && entry.status !== "active") {
			await sessionRuntimeCoordinator.cancelActivation(sessionId);
		}
		// 草稿会话切到非 pi 后端时回收本项目的 standby 预热进程：它服务不了这个会话，
		// 不主动丢就只能等 10min TTL 自然到期（用户反馈的「没用到还占着内存」）。
		// 放在锁定判定之后：已锁定的会话会先报错，不改状态也不回收进程。
		if (patch.backend !== undefined && patch.backend !== entry.backend && patch.backend !== "pi") {
			agentManager.releaseStandbyAgent(entry.projectId);
		}
		// DSH agent 预设同样创建即固定：激活会话的 preset 由 host 会话 header 权威持有，
		// 渲染层只读展示，拒绝任何运行时改写（未激活、还没有 host 会话的草稿才放行）。
		// 判据与渲染层胶囊共用 shared/dshAgentPresetLock：两边同源才不会出现
		// 「界面能点、主进程拒绝」的原始 IPC 报错。
		if (
			patch.agentPreset !== undefined &&
			patch.agentPreset !== entry.agentPreset &&
			isDshAgentPresetLocked({
				backend: entry.backend,
				status: entry.status,
				dshSessionId: entry.dshSessionId,
				hasRuntime: Boolean(sessionRuntimeCoordinator.getTarget(sessionId)),
			})
		) {
			throw new Error(mainCopy("session.agentPresetLocked"));
		}
		const title = patch.title?.trim();
		if (title && title !== entry.title) {
			// Reserve the catalog before the asynchronous pi rename. A late automatic-title
			// result must observe manual ownership even while set_session_name is in flight.
			await sessionCatalog.claimTitleOwnership(sessionId);
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) {
				const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
				if (!renamed.ok) throw sessionCommandIpcError(renamed.error, appLogger, mainCopy);
			} else if (sessionCatalog.getLocator(sessionId)?.kind === "ssh") {
				// 远端会话改名是**纯 catalog 记录操作**：PiDeck 的显示名就是 catalog 标题，上面已经用
				// claimTitleOwnership 占成 manual 终态（登记/自动标题都不会再覆盖它），因此不需要任何文件操作。
				// 这里刻意不走 localSessionFilePath：它对 ssh locator 抛稳定码，会让一次只改记录的改名失败。
				// 代价（已记录）：远端 JSONL 里的 name 行不变，pi 在远端的原生标题仍是旧名——远端文件写入
				// 属尚未交付的远端写面，不能在这里顺手补。有运行实例时改名走上面的 RPC 分支，与本分支无关。
				void appLogger.info("session", "Remote session renamed (catalog title only)", {
					sessionId,
					oldTitle: entry.title,
					newTitle: title,
				});
			} else {
				const sessionFilePath = localSessionFilePath(sessionId);
				if (sessionFilePath) {
					await sessionScanner.rename(sessionFilePath, title);
					void appLogger.info("session", "Session renamed (file)", {
						sessionId,
						oldTitle: entry.title,
						newTitle: title,
					});
				}
			}
		}
		return sessionCatalog.update(sessionId, {
			...patch,
			title: title || undefined,
			// 切到生图/生视频/ACP 后端时甩开 pi 会话文件引用：生图历史独立存 ImageSessionStore，
			// 生视频独立存 VideoSessionStore，ACP 会话由 agent CLI 自持（session/new 在远端）；
			// 残留 filePath 会让历史加载误落到不存在的 pi 文件（ENOENT 根因，imagegen 同款）。
			...(patch.backend === "imagegen" || patch.backend === "videogen" || patch.backend === "acp" ? { filePath: null, piSessionId: null } : {}),
		});
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDelete, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		if (!entry) return false;
		// 远端会话（ssh locator）没有本机会话文件，删除的语义只能是**纯本机记录操作**：
		// 移出 catalog 记录 + 记墓碑（下次远端扫描不再列为「可导入」）。本机语义是「删文件 + 移出记录」，
		// 这里只保留与它一致的那部分——
		// 1. 不调 `localSessionFilePath`（它对 ssh locator 抛稳定码，会让整个移除失败——就是今天的行为）；
		// 2. 不动本机回收站、不删/改任何本机文件；
		// 3. **零远端数据写入**：不改写远端 JSONL、不 move、不删除；
		// 4. 但“停进程 ≠ 改数据”：有运行实例时照本机「先杀后删」的先例先停掉它（见下）。
		// 真删远端文件是**另一个显式动作**（需二次确认），不在本批（见 docs/archive/remote/remote-write-plan.md §0）。
		const remoteLocator = entry.locator?.kind === "ssh" ? entry.locator : undefined;
		if (remoteLocator) {
			// 先停后摘记录（与本机删除同序）：留一个 `sessionId` 已不存在却仍绑定 runtime 的悬空会话会漏事件、
			// 生成幽灵条目，而且用户再也找不到停它的入口。这条链路是既有的「关闭 Agent」路径
			// （releaseRuntimeForDelete → agents.stop → 远端 runner 的停止信号 / 本地 ssh launcher 收尾），
			// **只终止进程，不做任何远端数据写入**——「停进程」与「改数据」是两件事，前者不碰任何会话文件。
			// 没有绑定/卡在 error 的中间态也走它：它先解绑再停，失败一次卡在 bound 的会话同样能移除。
			await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
			// 墓碑的键是**扫描侧的会话身份**（remoteSessionId，与 scan 的条目同值域）。G3 早期的远端记录
			// 可能只有 remotePath（同一个相对会话根的身份，见 readSshSessionLocator 的注释），所以按这个
			// 顺序取；两者都没有的历史记录（只有 hostId）本就永远匹配不上一次扫描，无需墓碑。
			const remoteSessionId = remoteLocator.remoteSessionId ?? remoteLocator.remotePath;
			if (typeof remoteSessionId === "string" && remoteSessionId.length > 0) {
				await sessionCatalog.rememberDismissedRemoteSession({ hostId: remoteLocator.hostId, remoteSessionId });
			}
			await sessionCatalog.removeWithDescendants(sessionId);
			// 只记身份（hostId/sessionId），不记路径、不记命令（与读取侧同一股敏纪律）。
			void appLogger.info("session", "Remote session record removed (tombstoned; remote file kept)", {
				sessionId,
				hostId: remoteLocator.hostId,
			});
			return true;
		}
		const sessionFilePath = localSessionFilePath(sessionId);
		// 删除即先杀后删：失败一次/卡在 bound 的会话也能删掉。
		// 仍按路径扫一遍游离 agent，避免只解绑 catalog 却留着进程。
		await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
		try {
			// DSH 没有 session.delete：host 目录会留在 $DSH_HOME。先记墓碑再删映射，
			// 否则 refreshProjectTree 的自动同步会把同一条再导入。运行中也允许删。
			if (entry.backend === "dsh" && entry.dshSessionId) {
				await sessionCatalog.rememberDismissedDshSession(entry.dshSessionId);
			}
			if (sessionFilePath) {
				const normalizedTarget = canonicalizeSessionPath(sessionFilePath, entry.environment);
				const usingAgent = agentManager
					.list()
					.find((agent) => agent.sessionPath && agent.sessionEnvironment === entry.environment && (entry.environment !== "wsl" || (agent.wslDistro === entry.wslDistro && agent.wslUser === entry.wslUser)) && canonicalizeSessionPath(agent.sessionPath, entry.environment) === normalizedTarget);
				if (usingAgent) {
					await sessionRuntimeCoordinator.stopAgentById(usingAgent.id).catch(() => undefined);
					await agentManager.stop(usingAgent.id).catch(() => undefined);
				}
				await sessionScanner.delete(sessionFilePath);
			}
			// 平铺子代理（与父会话同目录）不在 `<stem>/` 里，`scanner.delete` 覆盖不到：
			// 不单独处理就会「记录拖掉了、文件还在」，下次扫描变孤儿行（#539）。
			if (sessionFilePath) {
				const leftover = await runForScatteredSubtreeFiles({
					catalog: sessionCatalog,
					sessionId,
					parentFilePath: sessionFilePath,
					environment: entry.environment,
					run: (filePath) => sessionScanner.delete(filePath),
				});
				if (leftover.length > 0) void appLogger.warn("session", "Catalog session delete left scattered subtree files", { sessionId, failures: leftover });
			}
			// 磁盘会把 sibling `<stem>/` 一并删掉；catalog 必须同步摘掉整棵子树，
			// 否则 mergeScanned 只增改不删，子会话会孤儿提升成顶层行。
			await sessionCatalog.removeWithDescendants(sessionId);
			void appLogger.info("session", "Catalog session deleted", { sessionId, filePath: sessionFilePath });
			return true;
		} catch (error) {
			// 会话删除失败（文件删除失败/记录移除失败/会话使用中拦截）也要留痕，便于事后追踪。
			void appLogger.error("session", "Catalog session delete failed", {
				sessionId,
				filePath: sessionFilePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
}
