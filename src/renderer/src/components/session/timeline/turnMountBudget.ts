/**
 * 单轮步骤挂载预算：控制「一轮最多挂多少个步骤 DOM」。
 *
 * 为什么需要（2026-08 #213）：`turnRenderWindow` 只按轮数窗口裁剪，
 * 叠上主进程的 12 轮缓存窗口后，「12 轮 × 每轮几十条」是正常量级——
 * 但上下文超限后的极端会话里，单轮可以塞进上百个工具调用/思考段。
 * 此时轮数窗口完全不起作用：一个 `agent-run` 就能挂出上千个 ToolStep 子树
 * （每个含 Markdown/结果视图），渲染进程内存直接被打爆。
 *
 * 语义（与 turnRenderWindow 的「整轮保留」刻意不同，见下）：
 * - 默认只挂尾部 N 条步骤，顶部给「显示更早 N 条步骤」入口；
 * - 点开后本行全量挂载（内容从未丢失，只是默认不进 DOM）。
 *
 * 为什么这一层允许不整轮挂载：轮数窗口的完整性承诺是「不切开一个回答」——
 * 步骤条目本身是同一轮内的**过程**内容，且提供了显式展开入口，
 * 不存在「静默丢内容」。折叠态本就会整段卸载，挂载预算只是把
 * 「一次性全挂」换成「默认挂尾部 + 可展开」，退化路径有出口。
 */

/** 单轮默认挂载的步骤条目上限（思考/工具/中间回答统一计数）。 */
export const TIMELINE_MOUNTED_STEP_LIMIT = 120;

/**
 * 单个过程组的成员挂载上限（过程组显示模式下使用）。
 *
 * 语义从「每轮步骤」收敛成「每组步骤」——预算跟着风险走：
 * 新的过程组显示里，组体默认**不进 DOM**，只有用户点开的那一组才会把成员挂进来。
 * 所以「一次性挂载上千个重量级子树」的风险入口从「一轮」变成了「一个被展开的组」，
 * 预算就应该是每组一份，而不是每轮一份。
 *
 * 数值刻意复用既有常量：120 是 2026-08 OOM 治理时定下的档位，没有新的实测依据前
 * 不引入第二个未经调参的数字。
 */
export const PROCESS_GROUP_MEMBER_LIMIT = TIMELINE_MOUNTED_STEP_LIMIT;

/**
 * 大折叠栏内「一级节点」的挂载上限（组头 / 中间回复 / 重试错误行统一计数）。
 *
 * 为什么组头很轻、这一层仍然要设上限：**中间回复是重量级节点**——每段都会渲染一份
 * Markdown 正文，而一个带文本的工具回合就会产出一条中间回复。长任务一轮出现几十上百段
 * 中间回复是现实的（每条都同时是一个组边界），所以这一层不能因为「组头是个小按钮」就免检。
 *
 * 注意：这些预算成立的前提是「组体关闭时不挂载成员」。一旦有人把组体改成常驻挂载
 * （例如为了动画用 forceMount），预算就形同虚设——该前提必须由测试钉住。
 */
export const PROCESS_FOLD_NODE_LIMIT = TIMELINE_MOUNTED_STEP_LIMIT;

export interface MountedStepsWindow<T> {
	/** 实际挂载的条目（尾部窗口；未裁剪时是原数组引用，便于 memo）。 */
	items: readonly T[];
	/** 被默认折叠在窗口外的更早条目数（0 = 未裁剪）。 */
	hiddenCount: number;
}

/**
 * 按条目预算裁剪单轮步骤列表（纯函数，可单测）。
 *
 * 从尾部保留 limit 条：步骤是时序的，最新内容才是用户当下要看的；
 * 更早的步骤由调用方渲染「显示更早 N 条」入口，点击后以 showAll=true 重新调用。
 * limit <= 0 视为未启用预算（返回原列表）。
 */
export function boundMountedSteps<T>(items: readonly T[], limit: number = TIMELINE_MOUNTED_STEP_LIMIT, showAll = false): MountedStepsWindow<T> {
	if (showAll || limit <= 0 || items.length <= limit) {
		return { items, hiddenCount: 0 };
	}
	return {
		items: items.slice(items.length - limit),
		hiddenCount: items.length - limit,
	};
}
