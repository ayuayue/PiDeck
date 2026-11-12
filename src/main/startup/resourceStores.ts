import { join } from "node:path";
import { app } from "electron";
import type { AppSettings } from "../../shared/types/settings";
import { PROMPTS_STORE_CHANNELS, SKILLS_STORE_CHANNELS, registerContentStoreIpc } from "../ipc/contentStoreIpc";
import { PromptStoreUpdater } from "../prompts/promptStoreUpdater";
import { SkillStoreUpdater } from "../skills/skillStoreUpdater";

/** 本块真正用到的装配输入（settings 现求值，与原装配点同一读盘时序）。 */
export interface StartupContext {
	readonly getSettings: () => Pick<AppSettings, "updateSource">;
}

/**
 * 提示词商店官方模板 / 内置技能热更新：与内置扩展同一套「resources 只读 → userData 覆盖层」机制。
 * 覆盖层供查询侧（XuePromptManager / SkillManager）叠加解析：远端新增/修改的模板与技能免发版生效。
 * 两个 updater 交给调用方（查询侧与 IPC 复用同一实例），注册顺序与搬迁前一致。
 */
export function startResourceStores(ctx: StartupContext): {
	promptStoreUpdater: PromptStoreUpdater;
	skillStoreUpdater: SkillStoreUpdater;
} {
	const promptStoreUpdater = new PromptStoreUpdater({
		userDataDir: app.getPath("userData"),
		// 随包根与 skills/xueprompts.db 同一约定：dev 读 app.getAppPath()/resources，
		// 打包读 process.resourcesPath —— extraResources 的 `to` 已经把目录铺到
		// <app>/resources/<to>，这里再拼一层 "resources" 会指向不存在的路径。
		builtinPromptsDir: app.isPackaged ? join(process.resourcesPath, "prompts") : join(app.getAppPath(), "resources", "prompts"),
		// 与内置扩展/模型目录共用 settings.updateSource：默认 AtomGit，切 GitHub 后 raw 直连优先。
		source: () => ctx.getSettings().updateSource,
	});
	const skillStoreUpdater = new SkillStoreUpdater({
		userDataDir: app.getPath("userData"),
		// 与 SkillManager.installTemplate 的 root 解析严格对齐：打包态 process.resourcesPath
		// 已是 <app>/resources，再拼一层会变成 <app>/resources/resources/skills。
		builtinSkillsDir: app.isPackaged ? join(process.resourcesPath, "skills") : join(app.getAppPath(), "resources", "skills"),
		source: () => ctx.getSettings().updateSource,
	});
	registerContentStoreIpc(promptStoreUpdater, PROMPTS_STORE_CHANNELS);
	registerContentStoreIpc(skillStoreUpdater, SKILLS_STORE_CHANNELS);
	return { promptStoreUpdater, skillStoreUpdater };
}
