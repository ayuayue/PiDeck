/**
 * 外部 Agent 配置发现：只读扫描本机已安装 agent 的配置文件，解析出「供应商 + baseUrl + apiKey」候选，
 * 供模型配置页「从其他 Agent 导入」。
 *
 * 边界（参考 magpie 的账号发现，但定位不同——我们只做一次性导入，不做网关）：
 * - 只读，绝不写其他 agent 的配置文件；
 * - API Key 不整串回传渲染层：列表响应只带掩码 + 来源描述；导入确认后由
 *   渲染层凭 sourceId 再次请求，主进程在响应里一次性给出真实 key（与 TokenDance
 *   auth exchange 的「key 只在本次响应出现」同一约定）。
 * - 各 agent 的解析逻辑按域拆在 src/main/config/externalAgents/ 下；本文件只做编排与来源状态汇总。
 */
import { homedir, platform } from "node:os";
import { getAppLogger } from "../logging/sharedLogger";
import type { ExternalAgentDiscoveryResult, ExternalAgentKind, ExternalAgentProviderFound } from "../../shared/types/externalAgentDiscovery";
import { createNameUniquer, maskKey, safeProviderName } from "./externalAgents/shared";
import { discoverClaudeCode, resolveClaudeKey } from "./externalAgents/claudeCode";
import { discoverCodex, resolveCodexKey } from "./externalAgents/codex";
import { discoverOpenCode, resolveOpenCodeKey } from "./externalAgents/opencode";
import { discoverGeminiCli, resolveGeminiKey } from "./externalAgents/geminiCli";
import { discoverQwenCode, resolveQwenKey } from "./externalAgents/qwenCode";
import { discoverCrush, resolveCrushKey } from "./externalAgents/crush";
import { discoverGoose, resolveGooseKey } from "./externalAgents/goose";
import { discoverKimiCode, resolveKimiKey } from "./externalAgents/kimiCode";
import { discoverKiloCode, resolveKiloKey } from "./externalAgents/kiloCode";
import { discoverMinimaxCode, resolveMinimaxKey } from "./externalAgents/minimaxCode";
import { discoverZcode, resolveZcodeKey } from "./externalAgents/zcode";
import { discoverQoderCn, resolveQoderCnKey } from "./externalAgents/qoderCn";
import { discoverOpenClaw, resolveOpenClawKey } from "./externalAgents/openclaw";

export type { ExternalAgentDiscoveryResult, ExternalAgentKind, ExternalAgentProviderFound };
export { maskKey, safeProviderName };
export { parseClaudeSettings, parseClaudeOAuthAccount } from "./externalAgents/claudeCode";
export { parseCodexConfig, parseCodexAuth } from "./externalAgents/codex";
export { parseOpenCodeConfig, parseOpenCodeAuth } from "./externalAgents/opencode";
export { parseGeminiSettings } from "./externalAgents/geminiCli";
export { parseQwenSettings } from "./externalAgents/qwenCode";
export { discoverGoose, resolveGooseKey } from "./externalAgents/goose";
export { parseCrushConfig } from "./externalAgents/crush";
export { gooseConfigDir, parseGooseCustomProvider, parseFlatYaml } from "./externalAgents/goose";
export { parseKimiConfig } from "./externalAgents/kimiCode";
export { parseKiloSecrets } from "./externalAgents/kiloCode";
export { parseMinimaxConfig } from "./externalAgents/minimaxCode";
export { parseZcodeConfig } from "./externalAgents/zcode";
export { parseQoderCnSettings } from "./externalAgents/qoderCn";
export { parseOpenClawConfig } from "./externalAgents/openclaw";

type DiscoverFn = (home: string, uniqueName: (raw: string, fallback: string) => string) => Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }>;

/** 各来源的发现入口（顺序即 UI 里的展示顺序）。Goose 需要 platform，单独包装。 */
const DISCOVERERS: Array<{ agent: ExternalAgentKind; run: DiscoverFn }> = [
	{ agent: "claude-code", run: (home, uniqueName) => discoverClaudeCode(home, uniqueName) },
	{ agent: "codex", run: (home, uniqueName) => discoverCodex(home, uniqueName) },
	{ agent: "opencode", run: (home, uniqueName) => discoverOpenCode(home, uniqueName) },
	{ agent: "gemini-cli", run: (home, uniqueName) => discoverGeminiCli(home, uniqueName) },
	{ agent: "qwen-code", run: (home, uniqueName) => discoverQwenCode(home, uniqueName) },
	{ agent: "crush", run: (home, uniqueName) => discoverCrush(home, uniqueName) },
	{ agent: "goose", run: (home, uniqueName) => discoverGoose(home, platform(), uniqueName) },
	{ agent: "kimi-code", run: (home, uniqueName) => discoverKimiCode(home, uniqueName) },
	{ agent: "kilo-code", run: (home, uniqueName) => discoverKiloCode(home, uniqueName) },
	{ agent: "minimax-code", run: (home, uniqueName) => discoverMinimaxCode(home, uniqueName) },
	{ agent: "zcode", run: (home, uniqueName) => discoverZcode(home, uniqueName) },
	{ agent: "qoder-cn", run: (home, uniqueName) => discoverQoderCn(home, uniqueName) },
	{ agent: "openclaw", run: (home, uniqueName) => discoverOpenClaw(home, uniqueName) },
];

/**
 * 扫描本机外部 agent 配置。任何来源失败只影响该来源（记录 error），不阻断其余。
 * 读取 home 目录由参数注入（可测试；生产传 () => homedir()）。
 */
export async function discoverExternalAgentProviders(getHomeDir: () => string = homedir): Promise<ExternalAgentDiscoveryResult> {
	const home = getHomeDir();
	const uniqueName = createNameUniquer();
	const sources: ExternalAgentDiscoveryResult["sources"] = [];
	const providers: ExternalAgentProviderFound[] = [];
	for (const source of DISCOVERERS) {
		let found = false;
		let error: string | undefined;
		try {
			const result = await source.run(home, uniqueName);
			found = result.found;
			providers.push(...result.providers);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		sources.push({ agent: source.agent, found, error });
	}
	void getAppLogger()?.info("config", "External agent discovery finished", { sources: sources.length, providers: providers.length });
	return { sources, providers };
}

/**
 * 按 sourceId 取真实 API key（导入确认后渲染层凭掩码结果里的 id 请求）。
 * 返回的 key 只出现在本次 IPC 响应里，由渲染层立即写进草稿；不落任何日志。
 */
export async function resolveExternalAgentKey(sourceId: string, getHomeDir: () => string = homedir): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const home = getHomeDir();
	const [agent, ...rest] = sourceId.split(":");
	const detail = rest.join(":");
	try {
		switch (agent) {
			case "claude-code":
				return await resolveClaudeKey(home, detail);
			case "codex":
				return await resolveCodexKey(home);
			case "opencode":
				return await resolveOpenCodeKey(home, detail);
			case "gemini-cli":
				return await resolveGeminiKey(home);
			case "qwen-code":
				return await resolveQwenKey(home, detail);
			case "crush":
				return await resolveCrushKey(home, detail);
			case "goose":
				return await resolveGooseKey(home, platform(), detail);
			case "kimi-code":
			case "kimi":
				return await resolveKimiKey(home, sourceId);
			case "kilo-code":
				return await resolveKiloKey(home, detail);
			case "minimax-code":
				return await resolveMinimaxKey(home, detail);
			case "zcode":
				return await resolveZcodeKey(home, detail);
			case "qoder-cn":
				return await resolveQoderCnKey(home, detail);
			case "openclaw":
				return await resolveOpenClawKey(home, detail);
			default:
				return { ok: false, error: "unknown source" };
		}
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
