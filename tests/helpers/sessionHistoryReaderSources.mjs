import { readFileSync } from "node:fs";

/**
 * SessionHistoryReader 域的源码读取面：宿主 + `sessionReader/` 下的协作者。
 *
 * 为什么需要这份聚合：有测试按**源码文本**断言行为（合成分页边界、卡片投影、
 * 预览截断、日志文案…），而这些规则按域搬进了 `src/main/pi/sessionReader/`
 * 的协作者。断言该看的是「这一整片域是否还有这条规则」，而不是「规则还写在哪一个
 * 文件里」——拆文件不该被误读成行为消失。因此断言内容一个字都不改，只把读取面
 * 从单文件换成这份聚合。
 *
 * 需要「把模块编译起来执行」的测试（ts.transpileModule + 桩 require）不适用聚合：
 * 那种测试应直接读规则所在的那个文件（纯函数协作者），否则拼接多文件会导出冲突。
 */
export const SESSION_HISTORY_READER_SOURCE_FILES = ["src/main/pi/SessionHistoryReader.ts", "src/main/pi/sessionReader/sessionMessageProjection.ts", "src/main/pi/sessionReader/sessionEntryParsing.ts", "src/main/pi/sessionReader/sessionTurnWindow.ts"];

/** 整片域的源码文本（按固定顺序拼接；用于正则/包含判定）。 */
export function readSessionHistoryReaderSources() {
	return SESSION_HISTORY_READER_SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
}

/**
 * 按文件读源码，但 `src/main/pi/SessionHistoryReader.ts` 读成整片域的聚合。
 * 用于「按 filePath 归属符号/规则」的审计：归属表仍以宿主文件名为键，内容来自整片域。
 */
export function readSessionHistoryReaderSourceOrFile(filePath) {
	return filePath === "src/main/pi/SessionHistoryReader.ts" ? readSessionHistoryReaderSources() : readFileSync(filePath, "utf8");
}
