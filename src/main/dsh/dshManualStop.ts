/**
 * DSH host「用户手动停止」契约（单一数据源）。
 *
 * 场景：部分用户完全不用 DSH，但 host 是共享 utilityProcess（约 200MB 常驻），
 * 会被后台预热 / 按需兜底 / 崩溃自动重启 / runtime 安装后恢复等路径悄悄拉起。
 * 用户手动停止后必须 **只有用户显式启动** 才能再运行，因此：
 * - 所有自动拉起路径都要拒绝，且拒绝原因必须可辨识（不能混同于 boot 失败报红）；
 * - 判定与文案收敛在本模块：DshHost（策略层）与 DshHostProcess（进程层）
 *   都要用，放在任一侧都会形成循环 import；
 * - 历史读取失败也在本模块收敛成渲染层契约（dshUnavailablePageFor）。
 */
import type { SessionMessagePage } from "../../shared/types";

/** 「DSH host 已被用户手动停止」的错误文案（单一数据源）。 */
export const DSH_MANUALLY_STOPPED_ERROR = "DSH host is manually stopped";

/** 构造手动停止拒绝错误（进程层 fork 被门控时用）。 */
export function dshManuallyStoppedError(): Error {
	return new Error(DSH_MANUALLY_STOPPED_ERROR);
}

/** 判定错误是否为「手动停止」拒绝（非 boot 失败；调用方据此不报红、不重试）。 */
export function isDshManuallyStoppedError(error: unknown): boolean {
	return error instanceof Error && error.message === DSH_MANUALLY_STOPPED_ERROR;
}

/**
 * 历史读取失败 → 结构化「暂时不可读」页（渲染层契约，见 SessionMessagePage.unavailable）。
 *
 * 为什么需要：手动停止后 host 不会被任何自动路径拉起，DSH 历史读取必然失败；若按普通
 * 错误 reject，渲染层只能显示「会话历史加载失败 / 文件可能已删除或路径失效」——而 DSH
 * 会话根本没有 pi 会话文件，这句文案会把用户引向错误方向，且「重试」永远无效（手动停止
 * 态不会自愈）。转成带原因的空页后，渲染层可出「运行时已停止」专态 + 「启动 host」入口，
 * 一次点击即可恢复。
 *
 * 只认「手动停止」这一种可解释原因：其余错误（host 崩溃 / 会话文件损坏）返回 null，
 * 调用方继续按普通失败抛出——真实读取故障不能伪装成「点一下就好」的状态。
 */
export function dshUnavailablePageFor(error: unknown): SessionMessagePage | null {
	if (!isDshManuallyStoppedError(error)) return null;
	return { messages: [], total: 0, nextBefore: null, unavailable: "dsh-host-stopped" };
}
