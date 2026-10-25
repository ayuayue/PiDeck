// 数据环境业务层：决策查询与切换（保持 IPC 薄，handler 只做输入校验与适配）。
// 纯函数 + io 注入，tests/dataEnvIpc.test.mjs 直接单测（R4：桩形状 = io 参数）。
import type { UpdateChannel } from "../../shared/types/app";
import type { DataEnvChoiceFailure, DataEnvChoiceResult, DataEnvInfo, DataEnvMode } from "../../shared/types/dataEnv";
import { readDataEnvDecision, writeDataEnvDecision } from "./dataEnvMarker";

// 类型定稿于 shared/types/dataEnv.ts（R5：preload 禁止 import main，这里仅再导出）。
export type { DataEnvChoiceFailure, DataEnvChoiceResult } from "../../shared/types/dataEnv";

export interface DataEnvInfoInput {
	channel: UpdateChannel;
	/** 决策指针所在目录；stable 通道为空串（R6 空串守卫直接按未决策返回）。 */
	decisionDir: string;
	/** 当前生效数据目录类型（启动序列按 resolveAppUserDataDir 的分流结果传入）。 */
	activeDirectory: "shared" | "channel-dev";
}

/** 查询数据环境状态：决策指针是否存在 + 当前生效目录（dev 首启弹窗判定）。 */
export function getDataEnvInfo(input: DataEnvInfoInput): DataEnvInfo {
	// 空决策目录守卫（R6）：path.join("", "pideck-env.json") 会得到相对 cwd 的路径，
	// stable 包可能误读运行目录下的同名文件——空串一律按「未决策」返回，不碰文件系统。
	if (!input.decisionDir) {
		return { channel: input.channel, decided: false, dataMode: null, activeDirectory: input.activeDirectory };
	}
	const decision = readDataEnvDecision(input.decisionDir);
	return { channel: input.channel, decided: decision !== null, dataMode: decision?.dataMode ?? null, activeDirectory: input.activeDirectory };
}

export interface DataEnvChoiceInput {
	mode: DataEnvMode;
	/** 决策指针所在目录（dev 独立数据目录）；空串 = stable 通道无决策目录。 */
	decisionDir: string;
	appVersion: string;
}

/**
 * 写入数据模式决策：只写决策指针，不切换当前进程的数据目录
 * （setPath 分流发生在下次启动的 ready 前，因此 channel-dev 需要 restartRequired）。
 * 重复选择整体覆盖决策指针，以最后一次为准。
 */
export function applyDataEnvChoice(input: DataEnvChoiceInput, io = { read: readDataEnvDecision, write: writeDataEnvDecision }): DataEnvChoiceResult | DataEnvChoiceFailure {
	// 模式与目录双重守卫：非法模式与空决策目录（stable 通道）都返回 invalid-mode，不落任何文件。
	if ((input.mode !== "shared" && input.mode !== "channel-dev") || !input.decisionDir) {
		return { ok: false, error: "invalid-mode" };
	}
	// 决策指针固定在 dev 独立数据目录（规格 §6 持久化位置说明）；
	// shared 模式下该目录仅含此一个文件，共用目录的 pideck-env.json 不写 dev 专属字段。
	io.write(input.decisionDir, input.mode, input.appVersion);
	if (input.mode === "channel-dev") return { restartRequired: true, importAvailable: true };
	return { restartRequired: false, importAvailable: false };
}
