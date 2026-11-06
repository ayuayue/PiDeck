import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { BusySendDelivery } from "../../../shared/busySendDelivery";
import type { AgentBackend } from "../../../shared/types";
import { APP_DISPLAY_NAME_DEFAULT, type LogoStyle } from "../../../shared/types/settings";
import type { QuickMessagesSnapshot } from "../../../shared/types/quickMessages";
import type { ReplyActionsSnapshot } from "../../../shared/types/replyActions";
import { resolveEffectiveAgentBackend } from "../../../shared/types/dshRuntime";
import { isModuleHidden } from "../../../shared/hiddenModules";
import { dshRuntimeStatusAtom } from "./dsh-atoms";
import { activeWorkspacePageAtom, closeWorkspacePageAtom, openWorkspacePageAtom, workspacePageTabStateAtom } from "./workspace-page-atoms";
import type { SettingsFieldAnchorSlug } from "../utils/settingsFieldAnchors";
import { defaultExpandedSidebarProjects, readExpandedSidebarProjects } from "../utils/sidebarExpandedProjects";
import { DEFAULT_SIDEBAR_NAV_TAB, readSidebarNavTab, type SidebarNavTab } from "../utils/sidebarNavTab";

/**
 * 设置页是否「正在呈现」（会话列页面 Tab 的激活态）。真值只存一份：页面 Tab 状态。
 * 独立开关会让两者脱钩——关 Tab 后开关还开着，会话快捷键/终端面板仍被抑制。
 * 写 true = 打开并激活设置页 Tab；写 false = 关闭 Tab（页面子树卸载，未保存草稿随之丢弃，
 * 所以 Tab 栏的关闭叉必须先走设置页的脏数据确认，见 App 的 closeRequestRef）。
 */
export const settingsOpenAtom = atom(
	(get) => get(activeWorkspacePageAtom) === "settings",
	(_get, set, open: boolean) => {
		if (open) set(openWorkspacePageAtom, "settings");
		else set(closeWorkspacePageAtom, "settings");
	},
);

/** 设置页 Tab 是否打开（切到会话只是失活，仍为 true）：决定页面子树挂载还是卸载。 */
export const settingsPageOpenAtom = atom((get) => get(workspacePageTabStateAtom).tabs.includes("settings"));

/** Logo 风格的渲染层镜像（App.tsx 在 settings 变化时同步写入，照 announcement-atoms 模式）。
 *  LogoMark / PiTuiLogo / AppParts 侧栏 / AboutPopover 订阅，避免 settings props 透传链；
 *  Web 独立环境无人写入，保持默认 pi-tui（与 settings 默认同源），不引入额外通道。 */
export const logoStyleAtom = atom<LogoStyle>("pi-tui");

/** 自定义 logo 图片（data URL）的渲染层镜像；空串 = 未设置。
 *  只服务 logoStyle="custom" 的落点（LogoMark / 品牌区 / 关于弹层 / 来源标），
 *  未设置时各落点自行回落默认标——atom 里不放回落逻辑，免得多处订阅拿到不同结果。 */
export const customLogoAtom = atom<string>("");

/** 应用显示名称的渲染层镜像（已解析，空值已是 PiDeck）；品牌区与「关于」弹层订阅。 */
export const appDisplayNameAtom = atom<string>(APP_DISPLAY_NAME_DEFAULT);

/** 当前活跃编辑器 tab 的文件路径（无 tab 时为 null）：文件抽屉树行高亮用。
 *  由 useFileEditor 在 activeTab 变化时写入；抽屉树跨六个组件层级订阅，
 *  走 atom 避免 App→drawerPorts→DrawerSurface→DrawerContent→FilesPanel→FileNode 的 props 透传链。 */
export const activeEditorFileAtom = atom<string | null>(null);

/** 与 SettingsModal 侧栏 tab 对齐；深链/焦点目标用同一套 id，避免 Git 去设置落到上次记住的非「常用」页。 */
export type SettingsTabId = "common" | "shortcuts" | "appearance" | "terminal" | "proxy" | "connections" | "web" | "editors" | "git" | "dev" | "im" | "pet" | "notification" | "storage" | "backup" | "usage" | "process" | "vision" | "imagegen" | "videogen" | "acp" | "hostplugins" | "memory";

/**
 * 设置页内可直达的锚点 slug（对应 DOM 上的 `id="settings-section-<slug>"`）。
 *
 * 两类来源：
 * - 固定分区 git / dsh-runner-node / dev-pi-rpc：历史深链在用，显式列出；
 * - 细粒度设置项：由 `utils/settingsFieldAnchors.ts` 的清单推导（`SettingsFieldAnchorSlug`），
 *   命令面板（Ctrl+P）搜到「某个具体设置项」时用它精确跳过去。
 *
 * 刻意**不**写成 `string`：锚点拼错时运行时只会「滚到空气」（useSettingsFocus 2s 后
 * 静默放弃，不报错不提示），编译期联合是能在提交前拦住它的唯一关口。
 * 这里只 `import type`，atoms ↔ utils 的类型循环会被完全擦除，没有运行时依赖。
 */
export type SettingsSectionId = "git" | "dsh-runner-node" | "dev-pi-rpc" | SettingsFieldAnchorSlug;

/** 设置窗口顶层分区：系统设置 / 配置管理（顶部 tab，样式同配置页 Pi/DSH 分页）。 */
export type SettingsPaneId = "settings" | "config";

export type SettingsFocusTarget = {
	tab: SettingsTabId;
	section?: SettingsSectionId;
	/** 打开时落在设置窗口的顶层分区；缺省为系统设置。侧栏「配置管理」入口带 "config"。 */
	pane?: "config";
	/**
	 * pane="config" 时要落在的配置管理内部分页（ConfigTab，如 "models"）；
	 * 深链（如圆球面板「去配置用量」）直达模型页，缺省保持上次位置。
	 */
	configTab?: "models" | "auth" | "settings" | "trust" | "mcp" | "raw";
	/** configTab="models" 时要定位的供应商名：ModelsTab 展开该卡片并滚动高亮。 */
	provider?: string;
	/**
	 * pane="config" 时要落在的配置管理后端分页（Pi 管理 / DSH 配置）；
	 * 缺省保持上次位置（loadLastConfigBackendPane，默认 pi）。
	 * 深链（如 DSH runtime 未装时的「去安装」）直达 DSH 配置页。
	 */
	backendPane?: "dsh" | "pi";
};

/**
 * 打开设置时要落到的 tab/分区。消费方（SettingsModal）应用后必须清空，
 * 否则下次从侧栏普通打开仍会抢走 tab（上次深链残留）。
 */
export const settingsFocusAtom = atom<SettingsFocusTarget | null>(null);

/**
 * 打开设置并可附带焦点。Git「去设置」走这里；侧栏齿轮仍只写 settingsOpenAtom，
 * 保留「恢复上次 tab」行为。
 */
export const openSettingsAtom = atom(null, (_get, set, target?: SettingsFocusTarget) => {
	set(settingsFocusAtom, target ?? null);
	set(settingsOpenAtom, true);
});

/**
 * 新建会话默认后端（设置项 defaultAgentBackend 的渲染层快照）。
 * App 在 settings 变化时写入；并行问询等不持有 settings props 的根级组件读取。
 * 默认 "pi"（与 SettingsStore.defaultSettings 保持一致，2026-12 兼容期调整）。
 */
export const defaultAgentBackendAtom = atom<AgentBackend>("pi");

/**
 * 「有效」默认后端（AgentRuntimeProvider 阶段 1）：设置值经 DSH runtime 安装态钳制。
 *
 * 为什么是派生 atom 而不是在 App 的 settings effect 里一次性修正：安装态由 IPC 异步
 * 送达（初值 checking），晚于 settings 落 atom；派生能保证状态到位后所有消费方
 * （新建会话 / 并行问询 / 启动默认值）同帧收敛，不会留下「设置=dsh 但已不可用」的窗口。
 * 钳制规则是纯函数 resolveEffectiveAgentBackend（shared/types/dshRuntime，有单测）。
 */
export const effectiveAgentBackendAtom = atom<AgentBackend>((get) => resolveEffectiveAgentBackend(get(defaultAgentBackendAtom), get(dshRuntimeStatusAtom).state));

/**
 * 用户隐藏的功能模块（设置项 hiddenModules 的渲染层快照，清单见 shared/hiddenModules.ts）。
 * App 在 settings 变化时写入；不持有 settings props 的消费方（ConfigModal 的 Pi/DSH 分页、
 * composer 后端下拉）从这里读，设置保存后立即生效。默认空 = 全部显示。
 */
export const hiddenModulesAtom = atom<readonly string[]>([]);

/** DSH 后端入口是否隐藏：配置管理的 DSH 分页 + 新建会话的 DSH 后端选项。 */
export const dshModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "dsh"));

/** 生图入口是否隐藏：输入框后端下拉里的生图选项。 */
export const imageGenModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "imagegen"));

/** 生视频入口是否隐藏：输入框后端下拉里的生视频选项 + 生视频设置页。 */
export const videoGenModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "videogen"));

/**
 * 用户隐藏的输入框功能入口（设置项 hiddenComposerFeatures 的渲染层快照，清单见
 * shared/composerFeatures.ts）。App 在 settings 变化时写入；不持有 settings props 的
 * 消费方（ComposerBottomBar 的底栏入口）从这里读，设置保存后立即生效。默认空 = 全部显示。
 */
export const hiddenComposerFeaturesAtom = atom<readonly string[]>([]);

/** 流式状态条右侧的功能提示轮播是否被隐藏（设置 → 外观 → 功能模块）。 */
export const respondingTipsHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "respondingTips"));

/** 定时任务入口是否被隐藏：侧栏入口 + 项目菜单入口；已建任务照常按计划执行。 */
export const automationModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "automation"));

/** 智能体入口是否被隐藏：侧栏「智能体」入口；已保存的智能体与会话绑定照常生效。 */
export const agentsModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "agents"));

/** 收藏入口是否被隐藏：侧栏「收藏」入口；已收藏快照仍留在本机，命令面板仍可打开页面。 */
export const favoritesModuleHiddenAtom = atom((get) => isModuleHidden(get(hiddenModulesAtom), "favorites"));

/**
 * 发送消息后是否滚动到最新（设置项 scrollToLatestOnSend 的渲染层快照）。
 * App 在 settings 变化时写入；useSessionTimelineController 的发送定位 effect 在决策时刻
 * 用 store.get 读取（不订阅，避免设置改动重挂载时间线），默认开启。
 */
export const scrollToLatestOnSendAtom = atom(true);

/**
 * 忙碌时发送消息的默认投递行为（设置项 busySendDelivery 的渲染层快照）。
 * App 在 settings 变化时写入；composer/发送链路在决策时刻读取，
 * 避免把 settings props 一路透传进深层 hook。默认与 main SettingsStore 保持一致。
 */
export const busySendDeliveryAtom = atom<BusySendDelivery>("steer");

/**
 * 快捷消息快照（配置文件 userData/quick-messages.json，主进程 QuickMessageStore 读写）。
 *
 * 为什么放 atom 而不是组件 state：消费方在两条互不相干的子树里（composer 底栏弹框、
 * 设置页维护区），必须看到同一份「当前生效条目」，否则设置页改完弹框还是旧清单。
 * 读写入口统一走 useQuickMessages（加载 / 保存 / 打开配置文件），组件不直接 set。
 * null = 尚未读到文件（弹框先显示加载态，不把「还没读完」误报成「没有快捷消息」）。
 */
export const quickMessagesSnapshotAtom = atom<QuickMessagesSnapshot | null>(null);

/**
 * 回复快捷操作规则快照（配置文件 userData/reply-actions.json，主进程 ReplyActionRuleStore 读写）。
 * 与 quickMessagesSnapshotAtom 同一套约定：读写入口统一走 useReplyActions，
 * SessionReplyActions 只读 rules 展示，设置页经 save 落盘后整份替换快照。
 */
export const replyActionsSnapshotAtom = atom<ReplyActionsSnapshot | null>(null);

/**
 * 侧栏展开的项目 id 集合（有 id = 展开）。
 * Shared because project collapse also pauses App-level session polling.
 * 初值取 localStorage 首屏缓存，随后由 settings.json 覆盖为权威值。
 */
/**
 * 文件树「折叠中间包」开关（IDEA 式：单子目录且无文件的目录链合并成点分节点）。
 * 默认开，跨会话持久化（localStorage）。深包结构（Java/Maven、NestJS 等）用户反馈
 * 层级太深时树很丑，折叠后一行展示整条包链。
 */
export const compactMiddlePackagesAtom = atomWithStorage<boolean>("pi-desktop:compact-middle-packages", true);

export const sidebarExpandedProjectIdsAtom = atom<ReadonlySet<string>>(
	(() => {
		const cached = readExpandedSidebarProjects(typeof window === "undefined" ? undefined : window.localStorage);
		return cached ? new Set(cached) : defaultExpandedSidebarProjects();
	})(),
);

/** 侧栏 Chats/项目分段：localStorage 首屏缓存，settings.json 作权威来源。 */
export const sidebarNavTabAtom = atom<SidebarNavTab>(readSidebarNavTab(typeof window === "undefined" ? undefined : window.localStorage) ?? DEFAULT_SIDEBAR_NAV_TAB);

/**
 * 「新建项目后让侧栏揭示该行」请求：App 添加成功（本地目录 / WSL / 远端登记）后写入，侧栏
 * 据此切到项目所在分段、展开并滚进可视区——否则用户停在「聊天/活动」分段时，新项目所在
 * 分段根本没挂载，看起来就是「添加完没反应，要自己滚动才看得到」。
 *
 * 传「请求 + nonce」而不是直接暴露 DOM：写入方在 App，滚动容器在 SidebarContent。
 * 同一项目先移除再添加（id 不变）也必须能再次触发，所以只比 id 会让第二次静默失效。
 */
export type SidebarRevealProjectRequest = { projectId: string; nonce: number };
export const sidebarRevealProjectRequestAtom = atom<SidebarRevealProjectRequest | null>(null);
export const requestSidebarRevealProjectAtom = atom(null, (get, set, projectId: string) => {
	if (!projectId) return;
	set(sidebarRevealProjectRequestAtom, { projectId, nonce: (get(sidebarRevealProjectRequestAtom)?.nonce ?? 0) + 1 });
});

// useStreamdownRendererAtom 已移除：Streamdown 转正为唯一 markdown 引擎（迁移 react-markdown 完成）。

/**
 * 流式对话行为设置快照（App 从 settings 同步写入，TurnRow 直接订阅）。
 * 与 showThinking 的 props 透传不同：这两个开关影响深层 turn 组件，
 * 且变更低频（仅设置修改时），全局 atom 订阅成本可忽略。
 * 默认值与 main SettingsStore.defaultSettings 保持一致。
 */
export type TurnFlowSettings = {
	/** 流式对话时展开中间过程（默认开：最新轮流式输出时自动展开思考/工具详情）。 */
	expandInterimDuringStream: boolean;
	/** 是否按过程组合并显示思考/工具调用（默认开：连续思考/工具调用合并成过程组）。 */
	processGroupDisplay: boolean;
};

export const turnFlowSettingsAtom = atom<TurnFlowSettings>({
	expandInterimDuringStream: true,
	processGroupDisplay: true,
});
