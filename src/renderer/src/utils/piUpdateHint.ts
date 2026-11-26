/**
 * pi 更新完成后的提示语选择。
 *
 * 为什么单独抽出来：更新只替换磁盘上的可执行文件，**已经 spawn 的 pi 进程仍跑旧版本**，
 * 用户必须重启会话才会用上新版本。这条提示是更新流程唯一的行为输出，抽成纯函数才能
 * 用运行时断言覆盖（而不是断言「源码里写了哪行」）。
 *
 * 不做「有几个会话要重启」的计数：预热池、其他窗口的会话都会让数字偏差，一句话说清
 * 事实更可靠，也免得为一个可能错的数字再加一条 IPC 契约。
 */
export type PiUpdateHintInput = { updated: boolean };

export type PiUpdateHintKey = "settings.piUpdateRestartAgents" | "settings.piUpdateChecked";

/** 真的更新了 → 提示重启会话；只是检查过/已是最新 → 沿用原文案。 */
export function piUpdateToastKey(result: PiUpdateHintInput): PiUpdateHintKey {
	return result.updated ? "settings.piUpdateRestartAgents" : "settings.piUpdateChecked";
}
