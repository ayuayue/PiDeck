import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { Bot, CircleStop, Clock, Fingerprint, Puzzle, RefreshCw, RotateCw, Settings2, SquarePen, Star, Wrench } from "lucide-react";
import { buildSettingsCommands, type PaletteCommand } from "../../utils/commandPaletteCommands";
import { markCommandPaletteOnboardingSeen } from "../../components/overlays/CommandPaletteOnboarding";
import { openSettingsAtom } from "../../atoms/app-ui-atoms";
import { hostPluginCatalogAtom, hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { isModuleHidden } from "../../../../shared/hiddenModules";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";

/** 会话运行控制回调的最小切片（命令面板触发的动作，均由 App 域提供） */
export interface CommandPaletteActions {
	selectProjectCommand: (projectId: string) => void;
	restartActiveAgent: (agentId?: string) => Promise<void> | void;
	closeAgent: (agentId: string) => Promise<void> | void;
	runSessionControl: (sessionId: string, action: "reload") => Promise<void> | void;
	/** 打开会话 Tab 栏里的「定时任务」页面（功能模块可隐藏侧栏入口，命令面板保留直达路径）。 */
	openAutomationPage: () => void;
	/** 打开会话 Tab 栏里的「智能体」页面，同上。 */
	openAgentMarketPage: () => void;
	/** 打开会话 Tab 栏里的「收藏」页面，同上。 */
	openFavoritesPage: () => void;
	/** 打开「Pi 环境检测 / 安装引导」弹窗（dev 传 previewSetup 可直接看未安装态的一键安装面板）。 */
	openEnvironmentGuide: (options?: { previewSetup?: boolean }) => void;
}

/**
 * 命令面板域：面板开关状态、快捷键唤起订阅、命令列表构建。
 * - 唤起由主进程 before-input-event 广播（键位可在设置页改），输入框聚焦时跳过；
 * - 列表刻意不 memo：条目数在百级以内，t() 是模块级函数，memo 依赖无法表达
 *   「语言变了」，漏掉会出现「切完语言，面板里还是旧文案」。
 */
export function useCommandPalette({ activeProjectId, currentSessionId, activeAgentId, hiddenModules, actions }: { activeProjectId: string | undefined; currentSessionId: string | undefined; activeAgentId: string | undefined; hiddenModules: string[]; actions: CommandPaletteActions }) {
	const store = useStore();
	const { catalog: pluginCatalog } = useAtomValue(hostPluginCatalogAtom);
	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

	// 打开命令面板的唯一入口：顺手记下「用户已经知道这个功能了」，
	// 这样自己摸到快捷键的人不会再被启动引导打扰（引导只在完全没接触过时才有价值）。
	const openCommandPalette = useCallback(() => {
		markCommandPaletteOnboardingSeen();
		setCommandPaletteOpen(true);
	}, []);

	useEffect(() => {
		return api.app.onShortcutTriggered((id) => {
			if (id !== "openCommandPalette") return;
			const target = document.activeElement;
			if (target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
				return;
			}
			openCommandPalette();
		});
	}, [openCommandPalette]);

	const commandPaletteCommands: PaletteCommand[] = (() => {
		const commands: PaletteCommand[] = [];
		const actionGroup = t("command.groupActions");

		commands.push({
			id: "action:new-session",
			group: actionGroup,
			title: t("command.actionNewSession"),
			keywords: ["new", "新建", "会话", "session", "chat", "创建"],
			icon: SquarePen,
			run: () => {
				if (activeProjectId) actions.selectProjectCommand(activeProjectId);
			},
		});

		commands.push({
			id: "action:open-settings",
			group: actionGroup,
			title: t("command.actionOpenSettings"),
			keywords: ["settings", "设置", "偏好", "preferences", "配置"],
			icon: Settings2,
			run: () => store.set(openSettingsAtom, { tab: "common" }),
		});

		// Pi 环境检测：已装好 pi 的用户平时看不到这个弹窗，保留一个随时可打开的入口
		// （换机器、给用户排查「为什么起不了会话」时都用得上）。
		commands.push({
			id: "action:pi-environment-guide",
			group: actionGroup,
			title: t("command.actionPiEnvironment"),
			keywords: ["pi", "环境", "检测", "安装", "install", "environment", "node", "npm", "dsh"],
			icon: Wrench,
			run: () => actions.openEnvironmentGuide(),
		});

		// 开发专用：本机已装 pi 时也能看到未安装态的一键安装面板（不需要把 pi 从 PATH 里拿掉）。
		if (import.meta.env.DEV) {
			commands.push({
				id: "action:pi-environment-guide-preview",
				group: actionGroup,
				title: t("command.actionPiEnvironmentPreview"),
				keywords: ["pi", "预览", "preview", "安装引导", "环境检测"],
				icon: Wrench,
				run: () => actions.openEnvironmentGuide({ previewSetup: true }),
			});
		}

		// 页面式工作区（定时任务 / 智能体 / 收藏）：侧栏入口可被外观设置→功能模块收起，
		// 命令面板始终保留直达路径——隐藏后「找不回来」是最糟的结果。
		commands.push({
			id: "action:open-automation",
			group: actionGroup,
			title: t("command.actionOpenAutomation"),
			subtitle: isModuleHidden(hiddenModules, "automation") ? t("command.openHiddenPageHint") : undefined,
			keywords: ["定时任务", "自动化", "automation", "cron", "schedule", "任务计划"],
			icon: Clock,
			run: () => actions.openAutomationPage(),
		});
		commands.push({
			id: "action:open-agents",
			group: actionGroup,
			title: t("command.actionOpenAgents"),
			subtitle: isModuleHidden(hiddenModules, "agents") ? t("command.openHiddenPageHint") : undefined,
			keywords: ["智能体", "agent", "agents", "角色", "agent market"],
			icon: Bot,
			run: () => actions.openAgentMarketPage(),
		});
		commands.push({
			id: "action:open-favorites",
			group: actionGroup,
			title: t("command.actionOpenFavorites"),
			subtitle: isModuleHidden(hiddenModules, "favorites") ? t("command.openHiddenPageHint") : undefined,
			keywords: ["收藏", "favorite", "favorites", "bookmark", "收藏夹", "快照"],
			icon: Star,
			run: () => actions.openFavoritesPage(),
		});

		// 运行控制类命令只在有当前会话时才出现——没有目标时列出来只会点了没反应。
		//
		// 副标题刻意写「命令说明」而不是会话标题：会话标题是用户内容（自动命名出来的
		// 中文短语），摆在命令名下面会被直接读成这条命令的用途——曾把会话标题
		// 「检查 Git 更新与冲突情况」显示在「重启当前 Agent」下面，看起来像 Git 功能。
		// 命令名里的「当前」已经指明了作用对象。
		if (currentSessionId) {
			commands.push({
				id: "action:restart-agent",
				group: actionGroup,
				title: t("command.actionRestartAgent"),
				subtitle: t("command.actionRestartAgentDesc"),
				keywords: ["restart", "重启", "重开", "agent", "进程", "重新启动"],
				icon: RotateCw,
				run: () => void actions.restartActiveAgent(activeAgentId),
			});
			commands.push({
				id: "action:stop-agent",
				group: actionGroup,
				title: t("command.actionStopAgent"),
				subtitle: t("command.actionStopAgentDesc"),
				keywords: ["stop", "停止", "关闭", "agent", "进程", "结束"],
				icon: CircleStop,
				run: () => {
					if (activeAgentId) void actions.closeAgent(activeAgentId);
				},
			});
			commands.push({
				id: "action:reload-session",
				group: actionGroup,
				title: t("command.actionReloadSession"),
				subtitle: t("command.actionReloadSessionDesc"),
				keywords: ["reload", "重载", "重新加载", "刷新", "session"],
				icon: RefreshCw,
				run: () => void actions.runSessionControl(currentSessionId, "reload"),
			});
		}

		// 复制 Agent ID：无绑定（从未启动/已解绑）时没有可复制的值，不列出来
		if (activeAgentId) {
			commands.push({
				id: "action:copy-agent-id",
				group: actionGroup,
				title: t("command.actionCopyAgentId"),
				subtitle: activeAgentId,
				keywords: ["copy", "复制", "agent", "id", "标识"],
				icon: Fingerprint,
				run: () => void copyTextWithCopiedNotice(activeAgentId),
			});
		}

		for (const plugin of pluginCatalog?.plugins ?? []) {
			if (!plugin.enabled) continue;
			for (const command of plugin.manifest.contributes.commands)
				commands.push({
					id: `host-plugin:${plugin.manifest.id}:${command.id}`,
					group: t("hostPlugins.title"),
					title: command.title,
					subtitle: plugin.manifest.name,
					keywords: [plugin.manifest.id, plugin.manifest.name],
					icon: Puzzle,
					run: () => store.set(hostPluginPanelAtom, { pluginId: plugin.manifest.id, panelId: command.panelId }),
				});
		}
		commands.push(...buildSettingsCommands((target) => store.set(openSettingsAtom, target), hiddenModules));
		return commands;
	})();

	return { commandPaletteOpen, setCommandPaletteOpen, openCommandPalette, commandPaletteCommands };
}
