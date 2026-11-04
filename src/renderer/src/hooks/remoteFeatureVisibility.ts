import type { RemoteHostListResult } from "../../../shared/types/remoteHost";

/**
 * 远端能力的通道门禁（纯函数，配 tests/remoteChannelGate.test.mjs）。
 *
 * 判据只有一个来源：`update:get-channel` 上报的 `devBuild`（见 useRemoteFeatureAvailable）。
 * 这里只描述「拿到这个值之后界面怎么处理」，不碰 React、不读 atom，方便对真模块做行为断言。
 */

/** 只有明确拿到 `false`（正式包）才隐藏入口；`undefined`（通道信息还没到）先照常渲染，否则 dev 通道会先闪掉入口。 */
export function isRemoteEntryVisible(available: boolean | undefined): boolean {
	return available !== false;
}

/**
 * 「添加项目」里的远端入口 = 通道允许 **且** 真的有一台可登记的主机。
 *
 * 只看通道不够：一台可用主机都没有时，这个入口点进去只会落到登记弹框的 no-host 阶段，
 * 于是「添加项目」多一层什么都没带来的下拉。可用主机为空（`false`）或清单还没读到
 * （`undefined`）都先不出现——晚一步出现比先给一个用不了的入口更好。
 */
export function isRemoteAddProjectVisible(available: boolean | undefined, hostsConfigured: boolean | undefined): boolean {
	return isRemoteEntryVisible(available) && hostsConfigured === true;
}

/**
 * `remote:hosts-list` → 「有没有一台可登记的主机」。
 *
 * 口径与登记弹框一致：已验证且未禁用（未验证的主机没有信任锚，连接必然失败）。
 * 未启用/读不到清单返回 `undefined`：不把「读不到」当成「没有主机」，调用方保留上一次结论。
 */
export function readRemoteHostsConfigured(result: RemoteHostListResult): boolean | undefined {
	if (!result.ok) return undefined;
	return result.hosts.some((host) => host.verified && !host.disabled);
}

/**
 * 设置页布局按通道收口：门禁关闭时把「连接」tab 从布局里整条剔除。
 * 是剔除而不是置灰——不给入口比给了再报「未启用」更符合「正式包不提这个」。
 */
export function applyRemoteGateToSettingsLayout<T extends { id: string }>(layout: readonly T[], available: boolean | undefined): readonly T[] {
	return isRemoteEntryVisible(available) ? layout : layout.filter((entry) => entry.id !== "connections");
}
