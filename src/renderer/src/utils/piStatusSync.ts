import type { PiInstallStatus } from "../../../shared/types";

/**
 * 「实时探测结果 > 持久化缓存」的版本校正规则（纯函数，配 tests/piStatusSync.test.mjs）。
 *
 * 为什么需要：settings.piInstall 只在探测时刷新，而 pi 会被外部升级（`npm install -g`、`pi update`
 * 都不经过 PiDeck）。应用运行期间用户升级完，「检查 Pi 更新」和安装列表都已经真跑过 `pi --version`
 * 拿到新版本，顶部状态却还停在缓存里的旧版本——实测同屏出现「已找到 1.1.0」与列表里的 v1.2.0，
 * 点「检查 Pi 更新」还提示「Pi 已是最新版本」，三处互相矛盾。
 *
 * 规则：任何一次真探测（`pi --version` 的结果）都与当前状态比对，不一致就以探测结果为准；
 * 返回 null 表示无需回写，调用方据此决定是否落盘 settings.piInstall。
 */
export function resolvePiStatusFromProbe(current: PiInstallStatus | null, probe: { command?: string; version?: string }): PiInstallStatus | null {
	// 探测不出版本（进程跑不起来/输出不可解析）不作为证据，保持现有展示
	if (!probe.version) return null;
	// 命令未知时沿用当前解析出的路径；连路径都没有就不回写——persistPiInstall 缺 command 时
	// 会把缓存清成「未安装」，那等于用一次残缺的探测盖掉可用缓存。
	const command = probe.command || current?.command;
	if (!command) return null;
	if (current?.installed && current.version === probe.version && current.command === command) return null;
	// 探测成功即「已安装」且无错误：错误态与未安装态都不该被带进新状态
	return { installed: true, command, version: probe.version, searchedDirs: current?.searchedDirs ?? [] };
}
