/**
 * 项目会话目录「加载中」状态的兜底定时器（keyed watchdog）。
 *
 * 背景：侧栏展开项目时 setSessionCatalogLoadState 置 loading，正常由
 * 「runProjectSessionRefresh 成功/失败」或「主进程 catalog-refreshed 推送的静默拉取」
 * 揭开。但渲染层多个刷新入口共用 request 序号，序号被后发请求覆盖后，早先推送
 * 对应的静默拉取结果会被序号守卫丢弃；静默拉取 IPC 失败又会被 .catch 吞掉——
 * 两条路径都会让「正在加载历史会话」永远转圈（详见 useProjectSync）。
 *
 * 本模块提供「按 key 单代次」的定时器语义：
 * - schedule(key, ms, onFire)：取消该 key 的旧定时器并升代，保证只存在一个未触发兜底；
 * - cancel(key)：升代使旧定时器回调立即失效（任何权威状态变更都应调用）；
 * - cancelAll()：组件卸载时清理全部定时器。
 *
 * 使用约定：置 loading 时 schedule 兜底；任何状态变更（ready/error/新一轮 loading）
 * 都 cancel，从而保证「只有卡住的 loading 才会触发兜底」，且正常链路永远优先。
 */
export type WatchdogFire = () => void;

export function createKeyedWatchdog() {
	const versions = new Map<string, number>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	/** 调度（或替换）某个 key 的超时回调；返回本次的代次号。 */
	const schedule = (key: string, delayMs: number, onFire: WatchdogFire): number => {
		const version = (versions.get(key) ?? 0) + 1;
		versions.set(key, version);
		const previous = timers.get(key);
		if (previous !== undefined) clearTimeout(previous);
		timers.set(
			key,
			setTimeout(() => {
				// 代次不匹配 = 已被 cancel 或重新 schedule，旧回调必须失效
				if (versions.get(key) !== version) return;
				timers.delete(key);
				onFire();
			}, delayMs),
		);
		return version;
	};

	/** 使某个 key 尚未触发的回调立即失效（幂等）。 */
	const cancel = (key: string): void => {
		versions.set(key, (versions.get(key) ?? 0) + 1);
		const timer = timers.get(key);
		if (timer !== undefined) clearTimeout(timer);
		timers.delete(key);
	};

	/** 清理全部定时器（组件卸载/模块回收时调用）。 */
	const cancelAll = (): void => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		versions.clear();
	};

	return { schedule, cancel, cancelAll };
}

export type KeyedWatchdog = ReturnType<typeof createKeyedWatchdog>;
