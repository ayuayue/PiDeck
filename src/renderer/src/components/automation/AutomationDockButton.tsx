import { useAtomValue, useSetAtom } from "jotai";
import { Clock } from "lucide-react";
import { automationActiveRunsAtom, openAutomationPageAtom } from "../../atoms/automation-atoms";
import { automationModuleHiddenAtom } from "../../atoms/app-ui-atoms";
import { t } from "../../i18n";

/**
 * 侧栏顶部动作区的定时任务入口（新建会话 / 搜索会话下方）。
 * 点击打开（或激活）会话 Tab 栏里的定时任务页面 Tab；有正在执行的任务时，
 * 行尾显示呼吸蓝点，避免用户还要翻底栏 Dock。
 */
export function AutomationDockButton() {
	const openAutomationPage = useSetAtom(openAutomationPageAtom);
	const activeRuns = useAtomValue(automationActiveRunsAtom);
	// 外观设置→功能模块里隐藏了「定时任务」：只摘掉入口，调度器与已建任务不受影响
	const hidden = useAtomValue(automationModuleHiddenAtom);
	if (hidden) return null;
	const hasActive = activeRuns.length > 0;
	const label = hasActive ? `${t("automation.title")} (${activeRuns.length})` : t("automation.title");

	return (
		<button type="button" className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60" aria-label={label} title={label} onClick={() => openAutomationPage()}>
			<span className="relative shrink-0">
				<Clock className="size-4 text-muted-foreground" aria-hidden="true" />
				{hasActive && <span className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500 animate-pulse" aria-hidden="true" />}
			</span>
			<span className="min-w-0 flex-1 truncate font-medium">{t("automation.title")}</span>
			{hasActive && <span className="shrink-0 text-micro tabular-nums text-sky-500">{activeRuns.length}</span>}
		</button>
	);
}
