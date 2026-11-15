import { readFileSync } from "node:fs";

/**
 * SessionRuntimeCoordinator 域的源码读取面：宿主 + `runtime/` 下的协作者。
 *
 * 为什么需要这份聚合：有测试按**源码文本**断言行为（命令失败分类、偏好降级文案、
 * 性能埋点阶段名、网关契约能力面…），而这些规则按域搬进了
 * `src/main/sessions/runtime/` 的协作者。断言该看的是「这一整片域是否还有这条规则」，
 * 而不是「规则还写在哪一个文件里」——拆文件不该被误读成行为消失。
 * 因此断言内容一个字都不改，只把读取面从单文件换成这份聚合。
 */
export const SESSION_RUNTIME_COORDINATOR_SOURCE_FILES = [
	"src/main/sessions/SessionRuntimeCoordinator.ts",
	"src/main/sessions/runtime/sessionRuntimeGateways.ts",
	"src/main/sessions/runtime/sessionRuntimePreferences.ts",
	"src/main/sessions/runtime/sessionRuntimeCommandError.ts",
	"src/main/sessions/runtime/remoteMessageMutation.ts",
	"src/main/sessions/runtime/runtimeBinding.ts",
];

/** 整片域的源码文本（按固定顺序拼接；用于正则/包含判定）。 */
export function readSessionRuntimeCoordinatorSources() {
	return SESSION_RUNTIME_COORDINATOR_SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
}

/**
 * 按文件读源码，但 `src/main/sessions/SessionRuntimeCoordinator.ts` 读成整片域的聚合。
 * 用于「按 filePath 归属符号/字段」的审计：归属表仍以宿主文件名为键，内容来自整片域。
 */
export function readSessionRuntimeCoordinatorSourceOrFile(filePath) {
	return filePath === "src/main/sessions/SessionRuntimeCoordinator.ts" ? readSessionRuntimeCoordinatorSources() : readFileSync(filePath, "utf8");
}
