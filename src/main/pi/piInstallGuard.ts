import type { PiInstallation } from "../../shared/types";

/**
 * 引导安装前的最后一道守卫：**本机已经有 pi 就不再装第二份**。
 *
 * 为什么需要它（而不是只靠 UI 不展示引导）：
 * 环境引导只在「自动检测没找到 pi」时才展示，但那套检测总有覆盖不到的地方
 *（用户把 pi 放在自定义目录、别名指向 JS 源文件、只在 GUI 看不见的 shell 里配了 PATH…）。
 * 一旦漏判，用户点一下「一键安装 pi」就会真的多出一份 —— 之后终端和 PiDeck 各用各的，
 * 更新也走两条路。所以安装动作本身必须再确认一次，这是硬约束，不是体验优化。
 *
 * 纯函数：不碰磁盘/进程，输入是已经探测好的安装列表，方便单测锁行为。
 */
export type PiInstallGuard =
	| { skip: true; installations: PiInstallation[] }
	/** 没有现成安装：放行，照常执行引导安装 */
	| { skip: false; installations: [] };

export function resolvePiInstallGuard(installations: readonly PiInstallation[]): PiInstallGuard {
	if (installations.length === 0) return { skip: false, installations: [] };
	// 原样回传探测结果（含版本/来源）：渲染层要拿它展示「已检测到 N 份安装，未安装新副本」
	// 并直接给选择列表，用户不必再点一次检测。
	return { skip: true, installations: [...installations] };
}
