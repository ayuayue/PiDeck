import type { SessionCommandErrorCode } from "../../../shared/types";

/**
 * 会话命令的结构化错误（稳定码 + 原文 + 展示参数）。
 *
 * 为什么单独成叶子模块：抛它的地方遍布整片会话运行时域（目标命令、catalog 文件变更、远端写面），
 * 而 `commandFailure` 要靠 `instanceof` 分类。把它留在任一协作者里，另一个协作者就得在**运行时**
 * 反过来 import 宿主或兄弟协作者，形成环；错误类型是本域唯一被所有方向共用的值，放这里两边都只指向它。
 */
export class SessionRuntimeCommandError extends Error {
	constructor(
		readonly code: SessionCommandErrorCode,
		message: string,
		/** 展示参数（目前只有远端写面的体积上界）：与 `SessionFileEditorError.details` 同形状，只为文案服务。 */
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SessionRuntimeCommandError";
	}
}
