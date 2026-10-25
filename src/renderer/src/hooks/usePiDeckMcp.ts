/** Desktop MCP consent editor; lifecycle guards keep late responses out of unmounted panels. */
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { PiDeckMcpState } from "../../../shared/types/piDeckMcp";
import type { McpConfigFile } from "../../../shared/types/mcp";

export function usePiDeckMcp() {
	const [state, setState] = useState<PiDeckMcpState | null>(null);
	const [projectIds, setProjectIds] = useState<string[]>([]);
	// 授权草稿：通配与写开关不进 state 校验，只在 apply 时与 projectIds 一起提交。
	const [allProjects, setAllProjects] = useState(false);
	const [allowControl, setAllowControl] = useState(false);
	// 智能体写能力草稿：与 allowControl 同一次 apply 提交，关闭时一并撤回。
	const [allowAgentWrite, setAllowAgentWrite] = useState(false);
	// 定时任务写能力草稿：同一套提交/撤回规则。
	const [allowAutomationWrite, setAllowAutomationWrite] = useState(false);
	// 收藏写能力草稿（新增/删除本机收藏，含任意文本）。
	const [allowFavoritesWrite, setAllowFavoritesWrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const pending = useRef(false);
	const refresh = useCallback(async () => {
		if (pending.current) return;
		pending.current = true;
		const epoch = generation.current;
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.piDeckMcp.getState();
			if (generation.current !== epoch) return;
			if (!result.ok) {
				setError(result.code);
				return;
			}
			setState(result.value);
			setProjectIds(result.value.projectIds);
			setAllProjects(result.value.allProjects);
			setAllowControl(result.value.allowControl);
			setAllowAgentWrite(result.value.allowAgentWrite);
			setAllowAutomationWrite(result.value.allowAutomationWrite);
			setAllowFavoritesWrite(result.value.allowFavoritesWrite);
			setError(result.value.error ?? null);
		} catch {
			if (generation.current === epoch) setError("operation-failed");
		} finally {
			if (generation.current === epoch) {
				pending.current = false;
				setBusy(false);
			}
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			generation.current++;
			pending.current = false;
		};
	}, [refresh]);

	const apply = useCallback(
		async (enabled: boolean) => {
			if (pending.current) return;
			pending.current = true;
			const epoch = generation.current;
			setBusy(true);
			setError(null);
			try {
				// 关闭 = 撤回全部授权：写开关一并落回安全默认，重新启用时必须显式重选。
				const result = await desktopApi.piDeckMcp.setAccess(
					enabled ? { enabled, projectIds, allProjects, allowControl, allowAgentWrite, allowAutomationWrite, allowFavoritesWrite } : { enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false },
				);
				if (generation.current !== epoch) return;
				if (result.ok) {
					setState(result.value);
					setProjectIds(result.value.projectIds);
					setAllProjects(result.value.allProjects);
					setAllowControl(result.value.allowControl);
					setAllowAgentWrite(result.value.allowAgentWrite);
					setAllowAutomationWrite(result.value.allowAutomationWrite);
					setAllowFavoritesWrite(result.value.allowFavoritesWrite);
				} else {
					setError(result.code);
					// Failure can have stopped the listener: never keep displaying stale running state.
					const latest = await desktopApi.piDeckMcp.getState();
					if (generation.current === epoch && latest.ok) setState(latest.value);
				}
			} catch {
				if (generation.current === epoch) setError("operation-failed");
			} finally {
				if (generation.current === epoch) {
					pending.current = false;
					setBusy(false);
				}
			}
		},
		[projectIds, allProjects, allowControl, allowAgentWrite, allowAutomationWrite, allowFavoritesWrite],
	);

	/** Sensitive connection config lives only for this operation, not in component/atom state. */
	const withConnection = useCallback(async (action: (config: McpConfigFile) => Promise<boolean>) => {
		if (pending.current) return false;
		pending.current = true;
		const epoch = generation.current;
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.piDeckMcp.connection();
			if (generation.current !== epoch) return false;
			if (!result.ok) {
				setError(result.code);
				return false;
			}
			const ok = await action(result.value);
			if (!ok && generation.current === epoch) setError("operation-failed");
			return ok && generation.current === epoch;
		} catch {
			if (generation.current === epoch) setError("operation-failed");
			return false;
		} finally {
			if (generation.current === epoch) {
				pending.current = false;
				setBusy(false);
			}
		}
	}, []);
	return { state, projectIds, setProjectIds, allProjects, setAllProjects, allowControl, setAllowControl, allowAgentWrite, setAllowAgentWrite, allowAutomationWrite, setAllowAutomationWrite, allowFavoritesWrite, setAllowFavoritesWrite, busy, error, refresh, apply, withConnection };
}
