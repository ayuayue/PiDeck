/**
 * Chromium `disable-features` 的唯一拼装点。
 *
 * 背景：Electron 的 `app.commandLine.appendSwitch` 对同名 switch 是「后值覆盖前值」
 * 而不是追加——任何地方再 `appendSwitch("disable-features", ...)` 都会静默吞掉
 * 先前拼好的条目。因此所有要关闭的 Chromium feature 必须收敛到这里合并成单次
 * 调用；新增条目改下面的列表，禁止在别处另起 `appendSwitch("disable-features")`。
 */

/**
 * 默认关闭的 Chromium feature 清单（全平台、E2E 与日常运行共用）。
 *
 * - `AudioServiceOutOfProcess`（内存优化 2026-12）：独立 Audio Service utility
 *   进程常驻 53-85MB；PiDeck 的音频面全部在渲染层（语音转写的 getUserMedia/PCM
 *   采集、提示音的 HTMLAudioElement 播放），主进程只推 IPC。该 flag 只改进程
 *   布局（音频服务跑进主进程），不禁用音频，净省一个常驻进程。
 */
export const DISABLED_CHROMIUM_FEATURES = ["AudioServiceOutOfProcess"] as const;

/** 只依赖 appendSwitch：单元测试可用普通对象替身。 */
export type CommandLineAppendable = {
	appendSwitch: (switchName: string, value?: string) => void;
};

/**
 * 把默认 feature 清单与调用方追加项（如 E2E 的渲染保活条目）合并成单次
 * `disable-features` 写入。必须在 app ready 前调用。
 */
export function applyChromiumFeatureFlags(commandLine: CommandLineAppendable, extraDisabled: readonly string[] = []): void {
	const merged = [...DISABLED_CHROMIUM_FEATURES, ...extraDisabled];
	if (merged.length === 0) return;
	commandLine.appendSwitch("disable-features", merged.join(","));
}
