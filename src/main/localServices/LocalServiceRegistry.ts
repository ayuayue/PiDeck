import type { LocalServiceStatus } from "../../shared/localServices";

/** 一个本地服务的适配器：命令/参数/端口全部在主进程里写死，插件只能按 ID 点名。 */
export type LocalServiceAdapter = {
	readonly id: string;
	status(signal?: AbortSignal): Promise<LocalServiceStatus>;
	start(signal?: AbortSignal): Promise<LocalServiceStatus>;
	stop(signal?: AbortSignal): Promise<LocalServiceStatus>;
};

/**
 * 本地服务注册表：只有 PiDeck 自己装配进来的适配器存在。
 * 插件 manifest 里声明的服务 ID 已经在校验阶段比过 shared/localServices 白名单，
 * 这里再查一次表是为了兜住「白名单有、平台适配器没装」的情况（broker 返回 service-unavailable）。
 *
 * 启停轮询的取消不在这里做：它跟着宿主插件的授权绑定走（broker 的 AbortController），
 * 插件被撤销授权时立刻停掉还在等待的 start/stop，比进程级 dispose 更准。
 */
export class LocalServiceRegistry {
	private readonly adapters: Map<string, LocalServiceAdapter>;

	constructor(adapters: LocalServiceAdapter[]) {
		this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
	}

	get(id: string): LocalServiceAdapter | undefined {
		return this.adapters.get(id);
	}
}
