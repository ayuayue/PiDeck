/**
 * 视觉桥配置有效性判定（纯函数，独立成文件以便单测）。
 *
 * 规则：开启状态（enabled:true）必须已选模型——没有模型视觉桥无法工作，属无效配置；
 * 关闭状态（enabled:false）允许空 provider/model——「关掉视觉桥」本身就是要保存的目标，
 * 拒绝会导致用户关不掉（与主进程 visionBridgeConfig.ts 的 sanitizeConfig 语义一致）。
 */
export function visionModelMissing(
	config: {
		enabled?: boolean;
		provider?: string;
		model?: string;
	} | null,
): boolean {
	return Boolean(config?.enabled && !config.provider && !config.model);
}
