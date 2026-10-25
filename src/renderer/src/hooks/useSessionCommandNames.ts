import { useEffect, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { sessionCommandsAtomFamily, sessionCommandsRefreshTickAtom } from "../atoms/session-commands-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { mergeCommands } from "../components/app/AppUtils";
import { requireSessionCommand, sameCommands, toRuntimeCommandTarget } from "../utils/sessionCommands";

const NO_SESSION = "";
const EMPTY_NAMES: Set<string> = new Set<string>();

/**
 * 加载某会话的 runtime 命令名单（历史消息 `/命令` chip 白名单）。
 *
 * - 按 sessionId 订阅 atom family，分屏/多栏各拿各的，不读全局聚焦态；
 * - runtime（agentId + generation）变化时重拉，迟到结果用 current 标志丢弃；
 * - 无会话/无 runtime/加载失败一律空集合（chip 白名单为空 = 按纯文本渲染，行为安全）。
 */
export function useSessionCommandNames(sessionId: string | undefined): Set<string> {
	const key = sessionId ?? NO_SESSION;
	const commands = useAtomValue(sessionCommandsAtomFamily(key));
	const setCommands = useSetAtom(sessionCommandsAtomFamily(key));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(key));
	// 热重载后扩展命令表会变，但 runtime generation 不变；tick 用来强制重新 get_commands。
	const refreshTick = useAtomValue(sessionCommandsRefreshTickAtom);
	// 依赖收窄（2027-02 性能审计）：原先依赖整个 runtime 对象，而每个 runtime 事件
	// 都会重建该对象（updatedAt 每次都变），于是状态/工具/用量推送都触发一次
	// listRuntimeCommands IPC + 全量重建 chip 白名单 Set + 下游重渲。命令表只随
	// agentId/generation（换 runtime）与热重载 tick 变化，按这两个标量取依赖。
	const runtimeAgentId = runtime?.agentId;
	const runtimeGeneration = runtime?.runtimeGeneration;

	useEffect(() => {
		const target = toRuntimeCommandTarget(key, runtimeAgentId, runtimeGeneration);
		if (!target) {
			setCommands((current) => (current.length === 0 ? current : []));
			return;
		}
		let current = true;
		void desktopApi.sessions
			.listRuntimeCommands(target)
			.then((result) => {
				if (!current) return;
				const next = requireSessionCommand(result).value;
				// 内容相同保留原数组引用：命令表通常不变，无谓换引用会让白名单 Set 与 chip 全量重建。
				setCommands((previous) => (sameCommands(previous, next) ? previous : next));
			})
			.catch(() => {
				if (current) setCommands((previous) => (previous.length === 0 ? previous : []));
			});
		return () => {
			current = false;
		};
		// runtime 对象本身不入依赖是有意的（见上方注释）
	}, [key, runtimeAgentId, runtimeGeneration, setCommands, refreshTick]);

	return useMemo(() => (commands.length === 0 ? EMPTY_NAMES : new Set(mergeCommands(commands).map((command) => command.name))), [commands]);
}
