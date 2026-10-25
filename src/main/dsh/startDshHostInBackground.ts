/**
 * DSH host 的启动依赖；保持窄接口，便于在不 fork Electron utilityProcess 的测试中验证启动语义。
 */
export type DshHostStarter = {
	ensureStarted(): Promise<void>;
};

export type DshHostStartupLogger = {
	warn(scope: string, message: string, detail?: unknown): void | Promise<void>;
};

export type DshHostWarmupOptions = {
	/**
	 * 是否后台预热。缺省 true 保持旧语义；false 时本函数直接返回。
	 * 由装配层按「runtime 已安装 && 用户没手动停止过 host」判定：装了 runtime 就是用户
	 * 要用 DSH 的显式信号（host boot 约 20s，常驻约 200MB）；未安装或手动停止都不预热，
	 * 真正打开 DSH 会话/配置页/发消息时仍由 ensureStarted() 幂等拉起。
	 */
	enabled?: boolean;
};

/**
 * 在应用首帧之后按需预热 DSH host。
 * 不等待 boot 完成，避免 host 初始化、配置加载或异常影响主窗口可用性；发送链路仍由
 * ensureStarted() 幂等兜底。预热失败只记录诊断日志，用户可从配置概览手动重启恢复。
 */
export function startDshHostInBackground(host: DshHostStarter, logger: DshHostStartupLogger, options?: DshHostWarmupOptions): void {
	// 不用 DSH 的用户（默认后端 pi）跳过预热，避免 utilityProcess 空转占内存。
	if (options?.enabled === false) return;
	void host.ensureStarted().catch((error: unknown) => {
		void logger.warn("dsh-host", "Background DSH host startup failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
}
