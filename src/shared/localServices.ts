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

/** 单个活实例的快照：uiUrl 同样由主进程适配器收口到回环，插件只能「点名」不能「注入地址」。 */
export type LocalServiceInstance = {
	pid: number;
	/** 该实例自己的 Web UI 地址（回环收口后）。 */
	uiUrl: string;
	version?: string;
};

/** 运行状态快照：uiUrl 由主进程适配器推导，插件不参与拼接，也就无法把浏览器引到别的地址。 */
export type LocalServiceStatus = {
	id: string;
	/** 外部 CLI 是否可用；未安装时 running 恒为 false 且 reason 说明原因。 */
	available: boolean;
	running: boolean;
	/** 主实例（实例列表的第一个）：单实例服务就是它唯一的进程。 */
	pid?: number;
	/** 运行中才有：主实例的 Web UI 地址。 */
	uiUrl?: string;
	version?: string;
	/** 支持多实例的服务（如 billion-context 的 lane daemon）：全部活实例，主实例在最前；缺失表示单实例。 */
	instances?: LocalServiceInstance[];
	/** 稳定原因码（可用时为空）：cli-missing / cli-failed / invalid-report / start-failed / start-timeout / stop-failed / stop-restarted。 */
	reason?: string;
};
