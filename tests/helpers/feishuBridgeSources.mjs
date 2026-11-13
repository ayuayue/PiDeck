import { readFileSync } from "node:fs";

/**
 * FeishuBridge 拆分后的源码文件清单（显式列出，不扫目录）。
 *
 * 源码断言测试（正则/文本包含）读聚合文本即可：宿主与 bridge/ 协作者是同一份实现，
 * 断言不该因为某段逻辑挪了文件而失效。
 *
 * 顺序有意义：断言里有 `[\s\S]*?` 跨行区间（例如 stop() 的断开清理块、runAgent 的
 * finally），跨文件匹配只在相邻文本顺序与拆分前一致时才是同一段逻辑。
 */
export const feishuBridgeSourceFiles = [
	"src/main/feishu/FeishuBridge.ts",
	"src/main/feishu/bridge/bridgeLog.ts",
	"src/main/feishu/bridge/media.ts",
	"src/main/feishu/bridge/askCenter.ts",
	"src/main/feishu/bridge/commands.ts",
	"src/main/feishu/bridge/outbound.ts",
	"src/main/feishu/bridge/bindings.ts",
	"src/main/feishu/bridge/sessionMirror.ts",
	"src/main/feishu/bridge/runCards.ts",
	"src/main/feishu/bridge/sessionSync.ts",
	"src/main/feishu/bridge/actions.ts",
	"src/main/feishu/bridge/runtimeAuth.ts",
];

/** 聚合后的 FeishuBridge 实现源码（宿主 + 协作者，按清单顺序拼接）。 */
export function readFeishuBridgeSources() {
	return feishuBridgeSourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
}

/** 拆分出来的协作者模块文件（不含宿主），供需要真实加载它们的测试使用。 */
export const feishuBridgeCollaboratorFiles = feishuBridgeSourceFiles.filter((file) => file !== "src/main/feishu/FeishuBridge.ts");
