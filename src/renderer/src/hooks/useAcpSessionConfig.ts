import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { AcpSessionConfigOption } from "../../../shared/types/acp";

/**
 * ACP 会话级配置(configOptions 规范路径)的渲染层状态:
 * 挂载/agentId 变化时拉一次枚举,订阅 acp:session-config-changed 增量更新
 * (set 响应与 config_option_update 通知共用同一事件)。
 *
 * agentId 按 runtime 隔离:事件带 agentId,旧 agent 的迟到事件被过滤;
 * agent 未提供 configOptions 时 options 为 undefined(调用方隐藏选择器)。
 * 失败静默为 undefined(切换/关闭瞬间的 IPC 失败不值得打扰用户)。
 */
export function useAcpSessionConfig(agentId: string | undefined, backend: string | undefined) {
	const [options, setOptions] = useState<AcpSessionConfigOption[] | undefined>(undefined);

	const enabled = backend === "acp" && typeof agentId === "string" && agentId.length > 0;

	useEffect(() => {
		if (!enabled || !agentId) {
			setOptions(undefined);
			return;
		}
		let cancelled = false;
		void desktopApi.acp
			.getSessionConfig(agentId)
			.then((result) => {
				if (!cancelled) setOptions(result ?? undefined);
			})
			.catch(() => undefined);
		const unsubscribe = desktopApi.acp.onSessionConfigChanged((event) => {
			if (event.agentId === agentId) setOptions(event.options);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [enabled, agentId]);

	const setOption = useCallback(
		async (optionId: string, value: string | boolean) => {
			if (!agentId) return;
			try {
				// 响应即 agent 回传的完整整表,直接整表替换(与事件同构)
				setOptions(await desktopApi.acp.setSessionConfig(agentId, optionId, value));
			} catch {
				// agent 拒绝该值(枚举漂移)等失败:保持现状,用户在下拉里仍能看到当前值
			}
		},
		[agentId],
	);

	return { options, setOption };
}
