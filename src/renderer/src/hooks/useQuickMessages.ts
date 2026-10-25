import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import { quickMessagesSnapshotAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";

/**
 * 快捷消息的读写入库（配置文件在 userData/quick-messages.json，主进程 QuickMessageStore 负责读写）。
 *
 * 为什么要有这层 hook 而不是各组件直接调 desktopApi：
 * - 两个消费方挂在互不相干的子树里（composer 底栏弹框、设置页维护区），必须共享同一份
 *   「当前生效条目」，否则设置页改完弹框还是旧清单 → 统一落在 quickMessagesSnapshotAtom；
 * - 加载时机只有一处（挂载即读文件，见 refresh）；配置文件是唯一数据源，因此弹框每次打开、
 *   以及设置页的「重新读取」都再读一遍磁盘，用户手工编辑的改动不需要重启应用。
 *
 * 语义：items 即文件内容（主进程已 normalize）；save 是整体覆盖写，成功后快照会被主进程
 * 回传的清洗结果替换（去重、去首尾空白、超限截断都在主进程，界面因此永远显示文件真实内容）。
 */
export function useQuickMessages() {
	const [snapshot, setSnapshot] = useAtom(quickMessagesSnapshotAtom);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	/** 从文件重新读一次；返回本次快照供合并命令直接使用，失败返回 null，不能拿旧缓存冒充最新内置清单。 */
	const refresh = useCallback(async () => {
		try {
			const next = await desktopApi.quickMessages.get();
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

	/** 整体保存条目数组（空数组 = 清空）。返回是否成功，调用方可据此决定要不要提示。 */
	const save = useCallback(
		async (items: string[]): Promise<boolean> => {
			setSaving(true);
			try {
				const result = await desktopApi.quickMessages.save(items);
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

	/** 用系统默认程序打开配置文件；文件不存在时主进程会先生成（内容 = 当前清单）。 */
	const openFile = useCallback(async () => {
		try {
			await desktopApi.quickMessages.openFile();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	return {
		/** 当前生效条目（文件内容）；加载完成前为空数组。 */
		items: snapshot?.items ?? [],
		/** 随包内置清单：用户清空后「恢复默认」的来源，资源文件缺失时为空数组。 */
		defaults: snapshot?.defaults ?? [],
		defaultsAvailable: snapshot?.defaultsAvailable ?? false,
		filePath: snapshot?.filePath ?? "",
		/** 首次读文件尚未返回。 */
		loading: snapshot === null,
		saving,
		error,
		save,
		/** 重新从磁盘读一遍：用户手工编辑了配置文件时（打开弹框/点「重新读取」）手动同步界面。 */
		refresh,
		openFile,
	};
}
