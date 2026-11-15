import { useCallback } from "react";
import type { createStore } from "jotai";
import { agentProfilesAtom, pendingAgentBindingAtom, projectInventoryAtom } from "../../atoms";
import { buildAgentSessionTitle } from "../../components/agents/agentIconCodec";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import { createSessionOnce } from "../../utils/sessionCreation";
import type { NoticeKind } from "../../utils/notice";
import type { AgentBackend, AgentProfile, Project, SessionLaunchPreferences, SessionRecord } from "../../../../shared/types";
import type { SessionWorkspaceChrome } from "../useSessionWorkspaceChrome";

/**
 * 会话创建入口族：新建草稿/匿名会话（选中 + 登记常驻 Tab）、问题反馈会话、
 * 智能体「发送到会话」与「使用」。
 *
 * App 只负责接选中态、在途闸门与草稿写入；动作实现、文案与同项目单次创建语义都在这里。
 * 「新建会话」与引导页首发必须共用同一份在途注册表（issue #481）：两条入口都在等
 * createDraft 的 IPC 往返，各建一条就会在 Tab 栏留下没人写过的空标签。
 */
export interface AppSessionCreationDeps {
	store: ReturnType<typeof createStore>;
	activeProjectId: string | undefined;
	effectiveAgentBackend: AgentBackend;
	projects: Project[];
	setSessionDraft: (input: { sessionId: string; value: string | ((current: string) => string) }) => void;
	selectSessionCommand: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void;
	selectProjectCommand: (projectId: string) => void;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	upsertSession: (session: SessionRecord) => void;
	workspaceChrome: SessionWorkspaceChrome;
	runCreateSessionDraft: (projectId?: string, preferences?: SessionLaunchPreferences, backend?: AgentBackend) => Promise<SessionRecord | undefined>;
	runCreateAnonymousSession: (projectId?: string, preferences?: SessionLaunchPreferences) => Promise<SessionRecord | undefined>;
	/** 每个项目在途的草稿创建：与 ensureSessionForSend 共用同一份注册表 */
	pendingDraftCreationRef: { current: Map<string, Promise<SessionRecord | undefined>> };
	/** 最近一条由「+」/侧栏新建落地的草稿：引导页首发据此复用，避免再建一条空会话 */
	lastCreatedDraftIdRef: { current: string | undefined };
}

export interface AppSessionCreation {
	createSessionDraftWithTab: (projectId?: string, preferences?: SessionLaunchPreferences, backend?: AgentBackend) => Promise<SessionRecord | undefined>;
	createAnonymousSessionWithTab: (projectId?: string, preferences?: SessionLaunchPreferences) => Promise<SessionRecord | undefined>;
	handleFeedbackCreateSession: (prompt: string) => Promise<boolean>;
	handleAgentSendToSession: (payload: { agentId: string; text: string }) => Promise<boolean>;
	handleAgentUseAgent: (agent: AgentProfile) => Promise<boolean>;
}

export function useAppSessionCreation(deps: AppSessionCreationDeps): AppSessionCreation {
	const { store, activeProjectId, effectiveAgentBackend, projects, setSessionDraft, selectSessionCommand, selectProjectCommand, showToast, upsertSession, workspaceChrome, runCreateSessionDraft, runCreateAnonymousSession, pendingDraftCreationRef, lastCreatedDraftIdRef } = deps;

	/**
	 * 新建会话：选中 + 登记常驻 Tab（chrome 与 selection 在 App 边界组合）。
	 *
	 * 同一项目同一时刻只跑一条创建（issue #481）：入口在等 IPC 往返时引导页
	 * 输入框仍可发送，两条链路各建一条会话就会在 Tab 栏留下没人写过的空标签；
	 * 后到者复用先到者的会话，选择与 Tab 登记本来就幂等。
	 */
	const createSessionDraftWithTab = useCallback(
		async (projectId?: string, preferences: SessionLaunchPreferences = {}, backend?: AgentBackend) => {
			const targetProjectId = projectId ?? activeProjectId;
			if (!targetProjectId) return undefined;
			return createSessionOnce(pendingDraftCreationRef.current, targetProjectId, async () => {
				const session = await runCreateSessionDraft(targetProjectId, preferences, backend);
				if (session) {
					lastCreatedDraftIdRef.current = session.id;
					workspaceChrome.registerOpenSession(session.id, "permanent");
				}
				return session;
			});
		},
		[activeProjectId, runCreateSessionDraft, workspaceChrome],
	);

	const createAnonymousSessionWithTab = useCallback(
		async (projectId?: string, preferences: SessionLaunchPreferences = {}) => {
			const session = await runCreateAnonymousSession(projectId, preferences);
			if (session) workspaceChrome.registerOpenSession(session.id, "permanent");
			return session;
		},
		[runCreateAnonymousSession, workspaceChrome],
	);

	/**
	 * 问题反馈「新建会话分析」：在活动项目新建草稿会话并选中，把 AI 提示词预填进
	 * 该会话输入框（composer 草稿）。pi 启动后会自动加载项目 AGENTS.md 与技能，
	 * 提示词里的诊断报告 + 项目上下文可让 pi 在正确约束下排查。
	 */
	const handleFeedbackCreateSession = useCallback(
		async (prompt: string): Promise<boolean> => {
			const session = await createSessionDraftWithTab();
			if (!session) return false;
			setSessionDraft({ sessionId: session.id, value: prompt });
			return true;
		},
		[createSessionDraftWithTab, setSessionDraft],
	);

	/**
	 * 划词工具「发送到会话」：在活动项目新建草稿会话（标题 = 智能体名），把角色设定经
	 * agentMessage 隐藏通道后发送。
	 * - message 是用户可见原文（会话气泡），agentMessage 是实际发给 pi 的载荷；AgentManager
	 *   在 agentMessage 非空时**整体替换** message，因此角色设定必须与原文拼在一起提交，
	 *   时间线仍只显示原文（与 AutomationRunCoordinator / 飞书桥接的同一写法）。
	 * - DSH 后端没有 agentMessage 通道且会拒收整条 prompt，角色设定退化为可见前缀；
	 *   ACP 走 acpTurnSettlement 的同名通道，可以照常隐藏。
	 * - 智能体偏好模型只在 pi 后端带入：DSH 的模型是 host route、ACP 由外部 CLI 决定，
	 *   直接塞 pi 的 provider/modelId 会把草稿偏好写成无效值。
	 * - 后端只保留 pi / dsh：ACP 需要用户先在草稿里点选外部 CLI 工具（这里没有该上下文，
	 *   硬塞 acp 会建出无法激活的草稿），生图/生视频后端没有「提示词 agent」语义。
	 *   其余后端一律回落 pi——智能体角色设定本来就是 pi 原生 agentMessage 的语言。
	 */
	const handleAgentSendToSession = useCallback(
		async ({ agentId, text }: { agentId: string; text: string }): Promise<boolean> => {
			const agent = store.get(agentProfilesAtom).find((profile) => profile.id === agentId);
			const project = projects.find((candidate) => candidate.id === activeProjectId);
			const trimmed = text.trim();
			if (!agent || !project || !trimmed) return false;
			const backend: AgentBackend = effectiveAgentBackend === "dsh" ? "dsh" : "pi";
			try {
				const title = buildAgentSessionTitle(agent);
				const session = await api.sessions.createDraft({
					projectId: project.id,
					title,
					backend,
					...(agent.model && backend === "pi" ? { model: agent.model } : {}),
				});
				upsertSession(session);
				selectSessionCommand(project.id, session.id, false);
				workspaceChrome.registerOpenSession(session.id, "permanent");
				const persona = agent.systemPrompt.trim();
				const hiddenPersona = session.backend !== "dsh";
				const payload = `${persona}\n\n${trimmed}`;
				const result = await api.sessions.sendPrompt({
					sessionId: session.id,
					requestId: crypto.randomUUID(),
					message: hiddenPersona ? trimmed : payload,
					...(hiddenPersona ? { agentMessage: payload } : {}),
				});
				if (!result.accepted) {
					showToast(result.error || t("agentInvoke.errorTitle"), 4000, "error");
					return false;
				}
				return true;
			} catch (error) {
				showToast(error instanceof Error ? error.message : String(error), 4000, "error");
				return false;
			}
		},
		[activeProjectId, effectiveAgentBackend, projects, selectSessionCommand, showToast, store, upsertSession, workspaceChrome],
	);

	/**
	 * 智能体「使用」：带着该智能体回到新会话页（不建会话、不发请求）。
	 *
	 * 目录由新会话页输入框上方的项目选择器决定，用户在那里换项目；待绑定智能体记在
	 * pendingAgentBindingAtom 里，首次发送时由 ensureSessionForSend 建会话并落绑定。
	 * 角色设定不预填：主进程在绑定会话的首次发送时把 systemPrompt 拼进 agentMessage
	 * （对 UI 隐藏，见 src/main/ipc/sessionIpc.ts 的 resolveSessionAgentInstruction）。
	 * 留在市场页（返回 false）只有一种情形：一个项目都没有，无处可去。
	 */
	const handleAgentUseAgent = useCallback(
		async (agent: AgentProfile): Promise<boolean> => {
			const liveProjects = store.get(projectInventoryAtom);
			const project = liveProjects.find((candidate) => candidate.id === activeProjectId) ?? liveProjects[0];
			if (!project) {
				showToast(t("agentMarket.useFailed", { error: t("feedback.ai.noProject") }), 4000, "error");
				return false;
			}
			store.set(pendingAgentBindingAtom, agent.id);
			selectProjectCommand(project.id);
			showToast(t("agentMarket.useArmed", { name: agent.name }), 2600);
			return true;
		},
		[activeProjectId, selectProjectCommand, showToast, store],
	);

	return { createSessionDraftWithTab, createAnonymousSessionWithTab, handleFeedbackCreateSession, handleAgentSendToSession, handleAgentUseAgent };
}
