/**
 * 宿主插件面板图标白名单：manifest `contributes.panels[].icon` 的唯一合法取值集。
 * 为什么白名单而不是自由字符串：lucide 图标是按名静态映射进 bundle 的（渲染层
 * `hostPluginPanelIcon.tsx` 的 Record），自由名字既无法映射也会诱导动态 import；
 * 校验（main）与映射（renderer）共用这一份契约，未知名字 fail-closed 拒装。
 */
export const HOST_PLUGIN_PANEL_ICON_NAMES = ["bar-chart", "activity", "database", "table", "calendar", "file-text", "terminal", "globe", "git-branch", "message", "clock", "layers"] as const;

export type HostPluginPanelIconName = (typeof HOST_PLUGIN_PANEL_ICON_NAMES)[number];

export const isHostPluginPanelIconName = (value: unknown): value is HostPluginPanelIconName => typeof value === "string" && (HOST_PLUGIN_PANEL_ICON_NAMES as readonly string[]).includes(value);
