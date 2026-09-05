import type { ThinkingLevelMap } from "./modelSpecs";

/**
 * `/models` 拉取结果（Pi 配置页与 DSH 自定义模型共用）。
 *
 * 容量字段只在 listing 或 pi-ai 内置目录给出时出现；未命中则省略，
 * 由用户手填，不再写入 128k/8k 这类猜的默认值。
 * reasoning / input / thinkingLevelMap 可由端点 /models 实报，
 * 也可由 pi-ai 目录补全；两者都缺时由渲染层自适应模板兜底开放思考档位。
 */
export type FetchedModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** 端点 /models 或 pi-ai 目录实报时出现；listing 通常不下发 */
	reasoning?: boolean;
	/** 端点 /models 或 catalog/capability 解析出现，Pi 的规范档位 → provider wire 值映射。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 端点 /models 或 pi-ai 目录补全时出现，如 ["text","image"] */
	input?: string[];
};

/**
 * 真实 pi 探测 provider/model 的结果（用 pi --mode json --print 做一次最小调用）。
 * 字段与旧 net.fetch 测试结果对齐，渲染层测试结果卡片可直接复用。
 */
export type PiModelProbeResult = {
	success: boolean;
	model?: string;
	snippet?: string;
	tokens?: { input?: number; output?: number };
	latencyMs?: number;
	error?: string;
};

/**
 * 配置页「拉取模型列表 / 测试连接」的代理选择（配置检测与真实会话共享同一套代理语义）：
 * - follow：跟随全局（拉取列表走桌面代理全局开关；测试走 pi 代理全局开关，即现状行为）；
 * - pi：强制走 PI 代理（复用设置里 piProxyUrl，即使全局开关关闭）；
 * - desktop：强制走桌面代理（复用 desktopProxyUrl，主进程请求与 pi 子进程均注入）；
 * - off：强制直连（绕过任何代理，含用户系统环境变量）。
 */
export type ConfigProxyMode = "follow" | "pi" | "desktop" | "off";
