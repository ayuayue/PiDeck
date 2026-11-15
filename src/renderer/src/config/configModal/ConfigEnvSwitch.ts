import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { PiPromptTemplateSummary, PiSkillSummary } from "../../../../shared/types";
import { deepClone } from "../../utils/deepEqual";
import { orderDirtyKeysForSave } from "../configDirtyMarks";
import { resolveConfigTabForTarget, resourcePagesSupported, securityPageSupported } from "../configEnvironmentModel";
import type { AuthFile, ConfigTab, ModelsFile, SettingsFile } from "../configTypes";
import { samePiConfigTarget } from "../piConfigTargetModel";
/** 配置弹窗的分区（config 组子页按 tab 再分；其余是顶层分区）。 */
type ConfigSection = "config" | "security" | "skills" | "prompts" | "extensions" | "mcp";

/** 待切换环境的确认单：next 目标 + 会因此丢失的草稿 key。 */
export type PendingEnvSwitch = { next: PiConfigTarget; dirtyKeys: string[] };

type ConfigEnvSwitchDeps = {
	pendingEnvSwitch: PendingEnvSwitch | null;
	setPendingEnvSwitch: Dispatch<SetStateAction<PendingEnvSwitch | null>>;
	/** 远端面板已应用/未应用的 patch 是否存在（它不在本机保存链路里，切换只能丢弃）。 */
	remoteConfigDirty: boolean;
	remoteDirtyFiles: Set<string>;
	resetRemoteDirty: () => void;
	/** 当前目标（同目标直接忽略）。 */
	configTarget: PiConfigTarget;
	setConfigTarget: Dispatch<SetStateAction<PiConfigTarget>>;
	/** 当前脏集合的实时引用（保存前统一读它，避免闭包读到旧值）。 */
	dirtyTabsRef: RefObject<Set<string>>;
	clearDirty: (tabKey: string) => void;
	setTab: Dispatch<SetStateAction<ConfigTab>>;
	setSection: Dispatch<SetStateAction<ConfigSection>>;
	// 放弃草稿时把内存里的各份配置退回到基准快照
	baselineModelsRef: RefObject<ModelsFile>;
	baselineAuthRef: RefObject<AuthFile>;
	baselineSettingsRef: RefObject<SettingsFile>;
	baselineTrustRef: RefObject<Record<string, boolean>>;
	baselineRawRef: RefObject<{ fileName: string; content: string }>;
	baselineWslMcpRef: RefObject<string>;
	setModelsData: Dispatch<SetStateAction<ModelsFile>>;
	setAuthData: Dispatch<SetStateAction<AuthFile>>;
	setSettingsData: Dispatch<SetStateAction<SettingsFile>>;
	setTrustData: Dispatch<SetStateAction<Record<string, boolean>>>;
	setRawContent: Dispatch<SetStateAction<string>>;
	setRawFileName: Dispatch<SetStateAction<string>>;
	setWslMcpRaw: Dispatch<SetStateAction<string>>;
	setAddingProvider: Dispatch<SetStateAction<boolean>>;
	setEditingProvider: Dispatch<SetStateAction<string | null>>;
	setAddingAuth: Dispatch<SetStateAction<boolean>>;
	setEditingGlobalSkill: Dispatch<SetStateAction<PiSkillSummary | null>>;
	setEditGlobalContent: Dispatch<SetStateAction<string>>;
	setEditingPrompt: Dispatch<SetStateAction<PiPromptTemplateSummary | null>>;
	setEditPromptContent: Dispatch<SetStateAction<string>>;
	/** 记住选择的环境（宿主的 localStorage 辅助）。 */
	rememberTarget: (target: PiConfigTarget) => void;
	/** 顶部统一保存分发（环境切换前逐个落盘走同一条口径）。 */
	saveByKey: (tabKey: string) => Promise<boolean>;
};

/**
 * Pi 环境（本机 / SSH 主机 / WSL 发行版）切换动作（搬迁自 ConfigModal，行为不变）：
 * 落点校正、草稿丢失清单、以及「保存并切换 / 放弃并切换」两条确认路径。
 * 状态本身仍由宿主持有，这里只产出动作。
 */
export function useConfigEnvSwitch(deps: ConfigEnvSwitchDeps) {
	const {
		pendingEnvSwitch,
		setPendingEnvSwitch,
		remoteConfigDirty,
		remoteDirtyFiles,
		resetRemoteDirty,
		configTarget,
		setConfigTarget,
		dirtyTabsRef,
		clearDirty,
		setTab,
		setSection,
		baselineModelsRef,
		baselineAuthRef,
		baselineSettingsRef,
		baselineTrustRef,
		baselineRawRef,
		baselineWslMcpRef,
		setModelsData,
		setAuthData,
		setSettingsData,
		setTrustData,
		setRawContent,
		setRawFileName,
		setWslMcpRaw,
		setAddingProvider,
		setEditingProvider,
		setAddingAuth,
		setEditingGlobalSkill,
		setEditGlobalContent,
		setEditingPrompt,
		setEditPromptContent,
		rememberTarget,
		saveByKey,
	} = deps;

	/** 环境切换的落点：当前配置页在新环境里不存在时落到该环境第一页；资源/安全页在 ssh 下消失时回到配置组。 */
	const settleForTarget = useCallback((next: PiConfigTarget) => {
		setTab((current) => resolveConfigTabForTarget(next, current));
		setSection((current) => {
			if ((current === "skills" || current === "prompts" || current === "extensions" || current === "mcp") && !resourcePagesSupported(next)) return "config";
			if (current === "security" && !securityPageSupported(next)) return "config";
			return current;
		});
	}, []);

	/** 环境切换的唯一落点：写 state + 记住选择 + 清远端 patch + 校正当前页。 */
	const commitTargetSwitch = useCallback(
		(next: PiConfigTarget) => {
			setConfigTarget(next);
			rememberTarget(next);
			resetRemoteDirty();
			settleForTarget(next);
		},
		[resetRemoteDirty, settleForTarget, rememberTarget],
	);

	/**
	 * 切到 next 环境后会「从此消失」的草稿来源：
	 * - 所有配置文件草稿（config:* / config:mcp）永远算——它们属于当前环境，不能带到新环境；
	 * - 资源/安全页草稿只在新环境不再提供那些页时才算（ssh 没有资源页与安全策略页）。
	 * DSH 的草稿不受环境切换影响，不计入。
	 */
	const draftsLostBySwitch = useCallback((next: PiConfigTarget): string[] => {
		const lost: string[] = [];
		for (const key of dirtyTabsRef.current) {
			if (key.startsWith("dsh")) continue;
			if (key.startsWith("config:") || key === "mcp") {
				lost.push(key);
				continue;
			}
			if ((key === "skills" || key === "prompts" || key === "extensions") && !resourcePagesSupported(next)) lost.push(key);
			if (key === "security" && !securityPageSupported(next)) lost.push(key);
		}
		return lost;
	}, []);

	/**
	 * 切换 Pi 环境。草稿不能静默丢：先弹确认（保存并切换 / 放弃并切换 / 取消）。
	 * 远端未应用的 patch 同样算草稿——它不在本机保存链路里，切换只能丢弃。
	 */
	const handleConfigTargetChange = (next: PiConfigTarget) => {
		if (samePiConfigTarget(next, configTarget)) return;
		const dirtyKeys = draftsLostBySwitch(next);
		if (dirtyKeys.length > 0) {
			setPendingEnvSwitch({ next, dirtyKeys });
			return;
		}
		if (remoteConfigDirty) {
			setPendingEnvSwitch({ next, dirtyKeys: [...remoteDirtyFiles].map((file) => "remote:" + file) });
			return;
		}
		commitTargetSwitch(next);
	};

	/**
	 * 确认「放弃草稿并切换」：把内存里的配置数据退回各自基准（否则脏检测会立刻把黄点标回来）、
	 * 关掉正在编辑的技能/提示词/供应商表单，然后切换。
	 */
	const discardDraftsAndSwitch = () => {
		if (!pendingEnvSwitch) return;
		for (const key of dirtyTabsRef.current) {
			if (key.startsWith("dsh")) continue;
			clearDirty(key);
		}
		setModelsData(deepClone(baselineModelsRef.current));
		setAuthData(deepClone(baselineAuthRef.current));
		setSettingsData(deepClone(baselineSettingsRef.current));
		setTrustData(deepClone(baselineTrustRef.current));
		setRawContent(baselineRawRef.current.content);
		setRawFileName(baselineRawRef.current.fileName);
		setWslMcpRaw(baselineWslMcpRef.current);
		setAddingProvider(false);
		setEditingProvider(null);
		setAddingAuth(false);
		setEditingGlobalSkill(null);
		setEditGlobalContent("");
		setEditingPrompt(null);
		setEditPromptContent("");
		commitTargetSwitch(pendingEnvSwitch.next);
		setPendingEnvSwitch(null);
	};

	/** 确认「保存并切换」：把本环境会丢的草稿逐个落盘，全部成功后才切换（失败留在原地修）。 */
	const saveDraftsAndSwitch = async () => {
		if (!pendingEnvSwitch) return;
		const next = pendingEnvSwitch.next;
		const roots = new Set<string>();
		for (const key of draftsLostBySwitch(next)) {
			// 「扩展」页没有保存语义（开关即时生效），跳过；其余按 saveByKey 的分发口径归并。
			if (key === "extensions") continue;
			roots.add(key === "mcp" ? "config:mcp" : key);
		}
		for (const key of orderDirtyKeysForSave(roots)) {
			const ok = await saveByKey(key);
			if (!ok) return;
		}
		commitTargetSwitch(next);
		setPendingEnvSwitch(null);
	};

	return { commitTargetSwitch, handleConfigTargetChange, discardDraftsAndSwitch, saveDraftsAndSwitch };
}
