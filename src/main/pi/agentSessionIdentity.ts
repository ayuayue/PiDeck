import type { CreateAgentInput, SessionEnvironment } from "../../shared/types";
import { buildSessionOriginKey, toAbsoluteSessionPath } from "../../shared/sessionIdentity";

// pi 的 sessionFile 可能是相对 cwd 的路径（如 sessionDir 配置为 ".pi/sessions"）；
// AgentManager 在 get_state 等入口统一归一化为绝对路径，保证 catalog 去重与文件操作安全。
export { toAbsoluteSessionPath };

export type AgentSessionIdentityDefaults = {
	environment: SessionEnvironment;
	wslDistro?: string;
	wslUser?: string;
};

export function buildAgentSessionKey(input: CreateAgentInput, defaults: AgentSessionIdentityDefaults): string | undefined {
	if (!input.sessionPath) return undefined;
	const environment = input.environment ?? defaults.environment;
	return buildSessionOriginKey({
		source: input.source ?? "pi",
		environment,
		filePath: input.sessionPath,
		wslDistro: input.wslDistro ?? (environment === "wsl" ? defaults.wslDistro : undefined),
		wslUser: input.wslUser ?? (environment === "wsl" ? defaults.wslUser : undefined),
		importedSourceId: input.importedSourceId,
	});
}
