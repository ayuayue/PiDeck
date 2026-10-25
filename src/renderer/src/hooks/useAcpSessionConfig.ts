import { useCallback, useEffect, useRef, useState } from "react";
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
	type Scope = { agentId: string; revision: number };
	const scopeRef = useRef<Scope | undefined>(undefined);
	const [snapshot, setSnapshot] = useState<{ scope: Scope; options?: AcpSessionConfigOption[] } | undefined>(undefined);
	const enabled = backend === "acp" && typeof agentId === "string" && agentId.length > 0;

	useEffect(() => {
		setSnapshot(undefined);
		if (!enabled || !agentId) return;
		const scope: Scope = { agentId, revision: 0 };
		scopeRef.current = scope;
		// 先订阅再读取；读取中的更新具有更高 revision，旧枚举不能覆盖新通知。
		const unsubscribe = desktopApi.acp.onSessionConfigChanged((event) => {
			if (scopeRef.current !== scope || event.agentId !== agentId) return;
			scope.revision += 1;
			setSnapshot({ scope, options: event.options });
		});
		const revision = scope.revision;
		void desktopApi.acp
			.getSessionConfig(agentId)
			.then((result) => {
				if (scopeRef.current === scope && scope.revision === revision) setSnapshot({ scope, options: result ?? undefined });
			})
			.catch(() => undefined);
		return () => {
			if (scopeRef.current === scope) scopeRef.current = undefined;
			unsubscribe();
		};
	}, [enabled, agentId]);

	const setOption = useCallback(
		async (optionId: string, value: string | boolean) => {
			const scope = scopeRef.current;
			if (!enabled || !agentId || scope?.agentId !== agentId) return;
			const revision = ++scope.revision;
			try {
				const options = await desktopApi.acp.setSessionConfig(agentId, optionId, value);
				// 复用的 Composer、runtime 重启、连续选择都可能让应答迟到。
				if (scopeRef.current === scope && scope.revision === revision) setSnapshot({ scope, options });
			} catch {
				// agent 拒绝该值时保留当前选项；切换/关闭后的 IPC 失败无需打扰用户。
			}
		},
		[enabled, agentId],
	);

	// effect 清理在 paint 后执行；首帧也必须屏蔽旧 scope，不能露出 A 枚举 + B setter。
	const options = enabled && snapshot?.scope === scopeRef.current && snapshot?.scope.agentId === agentId ? snapshot.options : undefined;
	return { options, setOption };
}
