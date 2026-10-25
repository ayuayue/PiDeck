/**
 * DSH_HOME 共享 / 并发冲突状态契约（主进程 → preload → 渲染层）。
 *
 * 背景（issue #189 问题 1）：PiDeck 默认用用户真实 `~/.dsh`，与 dsh CLI 共用
 * profiles / settings.yaml / 插件状态文件。DSH 官方约束是「同一 DSH_HOME 只允许
 * 一个 host」，两实例并存会互相覆盖状态。判定逻辑见主进程
 * `src/main/dsh/dshHomeSharing.ts`；本文件只放跨进程传输的形状。
 */

/** DSH_HOME 共享状态快照（配置页据此渲染共享/冲突提示）。 */
export type DshHomeSharingState = {
	/** 当前 home 是否由用户显式覆盖指定（覆盖 = 已隔离，不再提示共享）。 */
	usingOverride: boolean;
	/** 当前 home 是否等于默认 `~/.dsh`（与 dsh CLI 同一目录，存在互相覆盖风险）。 */
	sharesCliHome: boolean;
	/**
	 * 另一个「存活」DSH host 的 pid（锁文件记录且进程仍在，且不是本进程）。
	 * 只覆盖遵守 PiDeck 锁的实例（双 PiDeck）；外部 dsh CLI 不写该锁，
	 * 属已知检测盲区，故缺省不代表「一定没有并发」。
	 */
	externalHostPid?: number;
};
