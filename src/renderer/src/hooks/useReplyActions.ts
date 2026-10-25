import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import { replyActionsSnapshotAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import type { ReplyActionRule } from "../../../shared/types/replyActions";

/**
 * 回复快捷操作规则的读写入库（配置文件在 userData/reply-actions.json，主进程 ReplyActionRuleStore 负责读写）。
 *
 * 与 useQuickMessages 同一套约定：
 * - 消费方挂在互不相干的子树里（会话时间线尾部、设置页维护区），必须共享同一份「当前生效规则」，
 *   统一落在 replyActionsSnapshotAtom；
 * - 加载时机只有一处（挂载即读文件）；配置文件是唯一数据源，设置页「重新读取」再读一遍磁盘，
 *   用户手工编辑的改动不需要重启应用。
 *
 * 语义：items 即文件内容（主进程已清洗）；save 是整体覆盖写，成功后快照被主进程回传的清洗
 * 结果替换（坏 trigger 丢弃、按 text 去重、超限截断都在主进程，界面永远显示文件真实内容）。
 */
export function useReplyActions() {
	const [snapshot, setSnapshot] = useAtom(replyActionsSnapshotAtom);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	/** 从文件重新读一次；返回本次快照供调用方直接使用，失败返回 null，不拿旧缓存冒充最新规则。 */
	const refresh = useCallback(async () => {
		try {
			const next = await desktopApi.replyActions.get();
			setSnapshot(next);
			setError(null);
			return next;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return null;
		}
	}, [setSnapshot]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** 整体保存规则数组（空数组 = 清空）。返回是否成功，调用方可据此决定要不要提示。 */
	const save = useCallback(
		async (items: ReplyActionRule[]): Promise<boolean> => {
			setSaving(true);
			try {
				const result = await desktopApi.replyActions.save(items);
				if (!result.ok) {
					setError(result.error);
					return false;
				}
				setSnapshot(result.snapshot);
				setError(null);
				return true;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return false;
			} finally {
				setSaving(false);
			}
		},
		[setSnapshot],
	);

	/** 用系统默认程序打开规则文件；文件不存在时主进程会先生成（内容 = 当前规则）。 */
	const openFile = useCallback(async () => {
		try {
			await desktopApi.replyActions.openFile();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	return {
		/** 当前生效规则（文件内容）；加载完成前为空数组。 */
		items: snapshot?.items ?? [],
		/** 随包内置规则：恢复默认的来源，资源文件缺失时为空数组。 */
		defaults: snapshot?.defaults ?? [],
		defaultsAvailable: snapshot?.defaultsAvailable ?? false,
		filePath: snapshot?.filePath ?? "",
		/** 首次读文件尚未返回。 */
		loading: snapshot === null,
		saving,
		error,
		save,
		/** 重新从磁盘读一遍：用户手工编辑了规则文件时手动同步界面。 */
		refresh,
		openFile,
	};
}
