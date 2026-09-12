import type { AppSettings } from "../../shared/types";
import { resolveEnabledSkillPaths } from "./skillWhitelistResolver";

/**
 * 为 PiProcess 构造技能白名单解析器。
 * 返回值可直接展开为 PiProcess 第 4 参 options 的 resolveEnabledSkillPaths。
 *
 * additionalAgentHomeDirs：WSL 场景传入 distro 家目录（UNC 路径），Linux 家目录的
 * 全局技能并入白名单（issue #203）；--skill 注入的 UNC 路径由 PiProcess 的 WSL
 * 参数转换还原为 distro 内 Linux 路径。
 *
 * 与 createPiProcessExtensionResolvers 同构：AgentManager（会话运行时 RPC）与
 * PiModelCapabilityCache（模型能力快照）必须走同一套「哪些技能加载」的判定。
 * 注意 PiModelCapabilityCache 固定 piRpcNoSkills: true（模型查询不需要技能），
 * PiProcess 侧 useSkillWhitelist 会因 piRpcNoSkills 关闭白名单，无需在此特判。
 */
export function createPiProcessSkillResolvers(
	cwd: string,
	settings: AppSettings,
	additionalAgentHomeDirs?: string[],
): {
	resolveEnabledSkillPaths: (
		processSettings?: Partial<AppSettings>,
		cwd?: string,
		includeProjectResources?: boolean,
	) => string[] | null;
} {
	return {
		resolveEnabledSkillPaths: (processSettings, _processCwd, includeProjectResources = true) =>
			resolveEnabledSkillPaths({
				cwd,
				includeProjectResources,
				additionalAgentHomeDirs,
				disabledNames:
					processSettings?.disabledSkills ?? settings.disabledSkills ?? [],
			}),
	};
}
