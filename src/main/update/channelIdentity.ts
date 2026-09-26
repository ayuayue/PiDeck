// src/main/update/channelIdentity.ts
// 编译期通道标记：由 electron.vite.config.ts:105 注入（PIDECK_DEV_BUILD=1 时为 true）。
// declare 写法与 src/main/utils/deepLinkScheme.ts 对 __PIDECK_DEV_BUILD__ 的用法一致。
declare const __PIDECK_DEV_BUILD__: boolean;

import type { UpdateChannel } from "../../shared/types/app";

/** 当前应用构建所属的更新通道（编译期确定，运行期不变）。 */
export function resolveUpdateChannel(): UpdateChannel {
	return __PIDECK_DEV_BUILD__ ? "dev" : "stable";
}
