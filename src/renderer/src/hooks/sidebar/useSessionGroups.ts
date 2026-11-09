import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type { SessionGroup } from "../../../../shared/types";
import { desktopApi } from "../../desktopApi";
import { hostPluginCatalogAtom } from "../../atoms/host-plugin-atoms";
import { isSessionGroupsPluginEnabled } from "../../components/sidebar/sessionGroupsModel";

/**
 * 分组数据（宿主 store）：分组插件启用时取数并订阅 onChanged，停用/未安装返回空数组。
 *
 * 侧栏分组树与「项目列表去重」共用这一份数据：两处各自拉取会出现插件页保存后
 * 「分组里已出现、项目列表里还没消失」的短暂不一致。
 */
export function useSessionGroups(): SessionGroup[] {
	const pluginEnabled = isSessionGroupsPluginEnabled(useAtomValue(hostPluginCatalogAtom).catalog);
	const [groups, setGroups] = useState<SessionGroup[]>([]);
	useEffect(() => {
		// 插件没开就不取数、不订阅：分组是插件产出的数据，关掉后不应再出现在侧栏。
		if (!pluginEnabled) {
			setGroups([]);
			return;
		}
		let disposed = false;
		const refresh = () => {
			void desktopApi.sessionGroups
				.list()
				.then((next) => {
					if (!disposed) setGroups(next);
				})
				.catch(() => undefined);
		};
		refresh();
		const unsubscribe = desktopApi.sessionGroups.onChanged(refresh);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [pluginEnabled]);
	return groups;
}
