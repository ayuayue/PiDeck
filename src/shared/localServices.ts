/**
 * PiDeck 自带的本地服务适配器清单（主进程实现，宿主插件只能「点名」不能「定义」）。
 *
 * 这里登记的每一项都是 PiDeck 自己写好的适配器：命令、参数、端口全部来自主进程常量，
 * 插件能提供的只有服务 ID，且 ID 必须命中这份白名单（manifest 校验阶段就拒）。
 * 因此「服务控制」不是「执行任意命令」——新增服务 = 在 src/main/localServices/ 加适配器
 * + 在这里登记 ID，插件侧的 manifest 校验随之放行，第三方插件无法自行扩展能力面。
 */
export const LOCAL_SERVICE_IDS = ["billion-context"] as const;
export type LocalServiceId = (typeof LOCAL_SERVICE_IDS)[number];

export function isLocalServiceId(value: unknown): value is LocalServiceId {
	return typeof value === "string" && (LOCAL_SERVICE_IDS as readonly string[]).includes(value);
}

/** 运行状态快照：uiUrl 由主进程适配器推导，插件不参与拼接，也就无法把浏览器引到别的地址。 */
export type LocalServiceStatus = {
	id: string;
	/** 外部 CLI 是否可用；未安装时 running 恒为 false 且 reason 说明原因。 */
	available: boolean;
	running: boolean;
	pid?: number;
	/** 运行中才有：服务自己的 Web UI 地址。 */
	uiUrl?: string;
	version?: string;
	/** 稳定原因码（可用时为空）：cli-missing / cli-failed / invalid-report / start-failed / start-timeout / stop-failed / stop-restarted。 */
	reason?: string;
};
