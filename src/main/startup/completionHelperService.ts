/**
 * 一次补全侧车（pi-enhance-host）实例的公共装配：提示词增强 / 智能体调用 / 输入预测 /
 * 记忆学习各自一个独立进程（EnhancePromptService 的单飞语义是「新 run 打断旧 run」，
 * 共用实例会互相打断）。resolveLaunch 现求值：用户改自定义 pi 路径后下次调用即生效，无需重启。
 *
 * 从 index.ts 外移：巨文件只留工厂调用；deps 用 getter 读取，避免装配时提前抓取值。
 */
import { app } from "electron";
import type { AppLogger } from "../logging/AppLogger";
import { resolvePiAuthHostLaunch } from "../pi/auth/piAuthHostLaunch";
import { EnhancePromptService, PI_ENHANCE_HOST_FILENAME } from "../pi/enhance/EnhancePromptService";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";

export type CompletionHelperNamespace = "enhance" | "agent-invoke" | "suggest" | "agent-memory";

export function createCompletionHelperServiceFactory(deps: { getAppLogger: () => AppLogger | undefined; getSettingsStore: () => SettingsStore; getPiLocator: () => PiLocator }): (namespace: CompletionHelperNamespace) => EnhancePromptService {
	return (namespace) => {
		const log = (level: "debug" | "info" | "warn" | "error", message: string) => void deps.getAppLogger()?.[level](namespace, message);
		return new EnhancePromptService({
			// 侧车是常驻单进程，env 在 spawn 时固定，所以代理只能在这里落地：
			// 把本次要用的模型交给启动参数解析，按与 pi 会话同一套名单语义决定要不要走代理；
			// 换模型或改代理设置后启动指纹变化，服务会重建进程而不是沿用旧出口。
			resolveLaunch: (run) => {
				const settings = deps.getSettingsStore().get();
				return resolvePiAuthHostLaunch({
					settings,
					proxyModel: run,
					locator: deps.getPiLocator(),
					userDataPath: app.getPath("userData"),
					appPath: app.getAppPath(),
					resourcesPath: process.resourcesPath,
					isPackaged: app.isPackaged,
					helperFilename: PI_ENHANCE_HOST_FILENAME,
				});
			},
			// 只有「输入框增强」消费用户自定义模板；其余命名空间自带主进程角色设定，
			// 由服务层的 systemPrompt 优先级保证不会被这里覆盖。
			...(namespace === "enhance" ? { resolveSystemPrompt: () => deps.getSettingsStore().get().enhanceSystemPrompt?.trim() || undefined } : {}),
			logger: {
				debug: (message) => log("debug", message),
				info: (message) => log("info", message),
				warn: (message) => log("warn", message),
				error: (message) => log("error", message),
			},
		});
	};
}
