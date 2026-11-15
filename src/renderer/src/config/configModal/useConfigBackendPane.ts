import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { dshModuleHiddenAtom } from "../../atoms";
import { loadLastConfigBackendPane, rememberConfigBackendPane } from "./configModalStorage";

type ConfigBackendPaneDeps = {
	/** 项目资源管理器只服务 Pi 侧资源：固定 Pi 页，不继承上次选择。 */
	resourceOnly: boolean;
	focusBackendPane: "dsh" | "pi" | undefined;
	/** 切换 Pi/DSH 页时关闭用量查询弹窗（它是 per-provider 的，跨页悬挂会被误认为自动弹出）。 */
	setUsageProbeDialog: (value: null) => void;
};

/**
 * 配置管理顶层后端分页（Pi / DSH）：记住上次位置、模块隐藏时回落，以及切换时的持久化。
 * 新建会话默认后端跟随设置项 defaultAgentBackend（默认 pi），与此处配置管理入口相互独立。
 */
export function useConfigBackendPane({ resourceOnly, focusBackendPane, setUsageProbeDialog }: ConfigBackendPaneDeps) {
	/** 配置管理顶层后端分页：以 Pi 为主（默认 Pi，且 Pi 标签在左），dsh 页在右。
	 *  新建会话默认后端跟随设置项 defaultAgentBackend（默认 pi），与此处配置管理入口相互独立。
	 *  弹窗每次打开都会重建 state，这里从 localStorage 恢复上次选定的后端分页。 */
	const [backendPane, setBackendPane] = useState<"dsh" | "pi">(resourceOnly ? "pi" : (focusBackendPane ?? loadLastConfigBackendPane));
	/**
	 * 用户隐藏了 DSH 模块（设置 → 外观 → 功能模块）：不渲染 Pi/DSH 分页头，弹窗固定在 Pi 页。
	 * 深链点名 DSH 页（runtime 提示「去安装」等）时例外：用户是主动要去，此时保留分页头供切回 Pi。
	 */
	const dshModuleHidden = useAtomValue(dshModuleHiddenAtom);
	const dshPaneHidden = dshModuleHidden && focusBackendPane !== "dsh";
	useEffect(() => {
		// 上次停在 DSH 页、或弹窗开着时在设置里隐藏了 DSH：回到 Pi 页，避免停在一个没有入口的页面。
		// 只改本次弹窗的 state，不覆写 localStorage 记忆——恢复显示后仍回到用户上次的选择。
		if (dshPaneHidden) setBackendPane("pi");
	}, [dshPaneHidden]);
	/** 切换后端分页并持久化：退出配置管理再进入时停留在上次选定的后端。 */
	const selectBackendPane = useCallback(
		(value: string) => {
			const next = value === "pi" ? "pi" : "dsh";
			setBackendPane(next);
			// 用量查询弹窗是 per-provider 的：切换 Pi/DSH 页时关闭，
			// 避免「从认证页点开、切到模型页后弹窗还挂着」的越界出现（用户反馈的闪现 bug）。
			setUsageProbeDialog(null);
			rememberConfigBackendPane(next);
		},
		[setUsageProbeDialog],
	);

	return { backendPane, selectBackendPane, dshPaneHidden };
}
