/**
 * dsh 会话在 runtime 不可用（未安装/损坏）时的统一「去安装」提示。
 *
 * 发送/重启/激活等入口复用：runtime 缺失时 DSH host 无法 fork，主进程只会抛
 * 模块解析的裸报错（Cannot find module @deepseek-ai/dsh-base …）。这里提前拦截，
 * 给出友好文案 + 直达「配置管理 → DSH」安装引导的动作按钮。
 */
import { t } from "../i18n";
import { showNotice } from "./notice";
import type { DshRuntimeState } from "../../../shared/types/dshRuntime";
import type { SettingsFocusTarget } from "../atoms/app-ui-atoms";

/** 配置管理 → DSH 后端分页（runtime 未装时概览页即安装引导）。 */
export const DSH_INSTALL_SETTINGS_TARGET: SettingsFocusTarget = {
	tab: "common",
	pane: "config",
	backendPane: "dsh",
};

export function showDshRuntimeBlockHint(
	openSettings: (target: SettingsFocusTarget) => void,
	state: DshRuntimeState,
	reason?: string,
	versions?: { installed?: string; declared?: string },
): void {
	const message =
		state === "broken"
			? t("dsh.runtime.sendBroken", { reason: reason ?? "" })
			: state === "outdated"
				? t("dsh.runtime.sendOutdated", {
						installed: versions?.installed ?? "",
						declared: versions?.declared ?? "",
					})
				: t("dsh.runtime.sendNotInstalled");
	showNotice(message, 8000, "info", undefined, {
		action: {
			label: t("dsh.runtime.installAction"),
			onClick: () => openSettings(DSH_INSTALL_SETTINGS_TARGET),
		},
	});
}
