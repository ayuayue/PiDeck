import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { BusySendDelivery } from "../../../shared/busySendDelivery";
import type { AgentBackend } from "../../../shared/types";
import { resolveEffectiveAgentBackend } from "../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "./dsh-atoms";
import {
  defaultExpandedSidebarProjects,
  readExpandedSidebarProjects,
} from "../utils/sidebarExpandedProjects";
import {
  DEFAULT_SIDEBAR_NAV_TAB,
  readSidebarNavTab,
  type SidebarNavTab,
} from "../utils/sidebarNavTab";

/** Settings overlay visibility is shared by Sidebar, Pi environment flow, and Session surface. */
export const settingsOpenAtom = atom(false);

/** 与 SettingsModal 侧栏 tab 对齐；深链/焦点目标用同一套 id，避免 Git 去设置落到上次记住的非「常用」页。 */
export type SettingsTabId =
	| "common"
	| "appearance"
	| "proxy"
	| "web"
	| "editors"
	| "git"
	| "dev"
	| "im"
	| "pet"
	| "sound"
	| "storage"
	| "usage"
	| "process"
	| "vision"
	| "imagegen";

/** 常用设置内部可滚动分区；目前只有 Git 摘要需要从面板直达。 */
export type SettingsSectionId = "git";

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
export const effectiveAgentBackendAtom = atom<AgentBackend>((get) =>
	resolveEffectiveAgentBackend(get(defaultAgentBackendAtom), get(dshRuntimeStatusAtom).state),
);

/**
 * 忙碌时发送消息的默认投递行为（设置项 busySendDelivery 的渲染层快照）。
 * App 在 settings 变化时写入；composer/发送链路在决策时刻读取，
 * 避免把 settings props 一路透传进深层 hook。默认与 main SettingsStore 保持一致。
 */
export const busySendDeliveryAtom = atom<BusySendDelivery>("steer");

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
export const compactMiddlePackagesAtom = atomWithStorage<boolean>(
	"pi-desktop:compact-middle-packages",
	true,
);

export const sidebarExpandedProjectIdsAtom = atom<ReadonlySet<string>>(
  (() => {
    const cached = readExpandedSidebarProjects(
      typeof window === "undefined" ? undefined : window.localStorage,
    );
    return cached ? new Set(cached) : defaultExpandedSidebarProjects();
  })(),
);

/** 侧栏 Chats/项目分段：localStorage 首屏缓存，settings.json 作权威来源。 */
export const sidebarNavTabAtom = atom<SidebarNavTab>(
  readSidebarNavTab(
    typeof window === "undefined" ? undefined : window.localStorage,
  ) ?? DEFAULT_SIDEBAR_NAV_TAB,
);

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
	/** 新一轮开始时收起上一轮（默认开：发送新消息后收起所有非最新轮，含手动展开的）。 */
	collapsePrevRunsOnNewTurn: boolean;
};

export const turnFlowSettingsAtom = atom<TurnFlowSettings>({
	expandInterimDuringStream: true,
	collapsePrevRunsOnNewTurn: true,
});

