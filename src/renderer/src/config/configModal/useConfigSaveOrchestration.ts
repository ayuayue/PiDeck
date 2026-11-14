import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { dshUiVisibilityFor } from "../../../../shared/types/dshRuntime";
import type { SecuritySectionHandle } from "../../components/config/SecuritySection";
import type { ConfigTab } from "../configTypes";
import type { DshConfigTabHandle } from "../DshConfigTab";
import type { McpTabHandle } from "../McpTab";
import { t } from "../../i18n";
import { orderDirtyKeysForSave } from "../configDirtyMarks";
import { sectionTabValue, type ConfigSection } from "./configModalStorage";

type ConfigSaveOrchestrationDeps = {
	configTarget: PiConfigTarget;
	/** WSL 目标的编辑器选项：真值表示当前环境的 mcp/config 走 WSL 文本保存链路。 */
	configTargetOption: { target: PiConfigTarget } | undefined;
	/** DSH runtime 可视门控：runtime 不可用时整 Tab 是安装引导，没有可保存草稿。 */
	dshUi: ReturnType<typeof dshUiVisibilityFor>;
	saving: boolean;
	backendPane: "dsh" | "pi";
	section: ConfigSection;
	tab: ConfigTab;
	addingProvider: boolean;
	editingProvider: string | null;
	providerPageSaveRef: RefObject<(() => void) | undefined>;
	providerPageSavePendingRef: MutableRefObject<boolean>;
	dirtyTabs: Set<string>;
	dirtyTabsRef: MutableRefObject<Set<string>>;
	clearDirty: (tabKey: string) => void;
	markDirty: (tabKey: string) => void;
	onSaved: () => void;
	showToast: (message: string) => void;
	/** 各页自己的保存入口（页内动作留在各 Tab，这里只做分发）。 */
	handleSaveModels: () => Promise<boolean>;
	saveSettingsDraftOnly: () => Promise<boolean>;
	handleSaveAuth: () => Promise<boolean>;
	handleSaveSettings: () => Promise<boolean>;
	handleSaveTrust: () => Promise<boolean>;
	handleSaveWslMcp: () => Promise<boolean>;
	handleSaveRaw: () => Promise<boolean>;
	saveGlobalSkillEditor: () => Promise<boolean>;
	handleSaveEditPrompt: () => Promise<boolean>;
	securitySectionRef: RefObject<SecuritySectionHandle | null>;
	dshConfigRef: RefObject<DshConfigTabHandle | null>;
	mcpTabRef: RefObject<McpTabHandle | null>;
	resourceMcpTabRef: RefObject<McpTabHandle | null>;
	/** 远端 patch 不随本机保存落盘：关窗时要转成显式丢弃确认。 */
	remoteConfigDirty: boolean;
	setCloseConfirmOpen: Dispatch<SetStateAction<boolean>>;
	setRemoteDiscardConfirmOpen: Dispatch<SetStateAction<boolean>>;
	onClose: () => void;
};

/**
 * 保存与关闭编排：把「顶部统一保存 / 保存全部脏来源 / 关闭前确认」三个入口收敛到一套按 tab 编码的分发。
 * 独立弹窗与嵌入分区（ConfigPane）共用同一套 handler，避免两处按钮行为分叉。
 */
export function useConfigSaveOrchestration(deps: ConfigSaveOrchestrationDeps) {
	const {
		configTarget,
		configTargetOption,
		dshUi,
		saving,
		backendPane,
		section,
		tab,
		addingProvider,
		editingProvider,
		providerPageSaveRef,
		providerPageSavePendingRef,
		dirtyTabs,
		dirtyTabsRef,
		clearDirty,
		markDirty,
		onSaved,
		showToast,
		handleSaveModels,
		saveSettingsDraftOnly,
		handleSaveAuth,
		handleSaveSettings,
		handleSaveTrust,
		handleSaveWslMcp,
		handleSaveRaw,
		saveGlobalSkillEditor,
		handleSaveEditPrompt,
		securitySectionRef,
		dshConfigRef,
		mcpTabRef,
		resourceMcpTabRef,
		remoteConfigDirty,
		setCloseConfirmOpen,
		setRemoteDiscardConfirmOpen,
		onClose,
	} = deps;

	/** 安全管理草稿脏状态上报：有修改 markDirty("security")，保存成功/卸载清标记。 */
	const handleSecurityDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("security");
			else clearDirty("security");
		},
		[markDirty, clearDirty],
	);

	const handleMcpDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("config:mcp");
			else clearDirty("config:mcp");
		},
		[markDirty, clearDirty],
	);

	/** 资源管理器（项目作用域）MCP 页脏状态。必须 memo：McpTab 的 load 依赖这个回调，
	 *  传内联箭头会让每次父组件渲染都重跑 load，用磁盘内容冲掉正在输入的表单（见 McpTab 的 ref 兼底）。 */
	const handleResourceMcpDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("mcp");
			else clearDirty("mcp");
		},
		[markDirty, clearDirty],
	);

	/** 按 tab 编码分发到对应保存 handler；返回是否保存成功（false = 保存失败，由错误提示区展示原因）。 */
	const saveByKey = async (tabKey: string): Promise<boolean> => {
		switch (tabKey) {
			case "dsh": {
				// runtime 不可用时整页是安装引导，没有任何可保存草稿：直接视为保存通过，
				// 否则统一保存按钮会因为拿不到 DshConfigTab 句柄而一直报「保存失败」。
				if (!dshUi.showDshConfigForms) return true;
				// DSH 页保存成功后显式清未保存标记：子分区草稿已清空并上报 false，
				// 但卸载/收起的分区可能残留脏来源，这里兜底保证黄点消失。
				const ok = (await dshConfigRef.current?.save()) ?? false;
				if (ok) clearDirty("dsh");
				return ok;
			}
			case "config:models":
				// 新增/编辑页把字段保存在页内 state，先提交完整草稿；
				// 提交回调会回写 modelsData 并回到列表，不能在同一次调用里读取尚未刷新的父级 state。
				if (addingProvider || editingProvider) {
					providerPageSavePendingRef.current = true;
					providerPageSaveRef.current?.();
					return true;
				}
				{
					const ok = await handleSaveModels();
					// 模型页的「每模型默认思考档位」写的是 settings.json：同一次保存顺带落盘该草稿，
					// 否则用户在本页点保存后 settings 黄点仍在、也不知道还要去设置页再存一次。
					// 只走「只写不重载」路径，避免冲掉 auth/raw 等其它页的未保存草稿。
					if (ok && dirtyTabsRef.current.has("config:settings")) return saveSettingsDraftOnly();
					return ok;
				}
			case "config:auth":
				return handleSaveAuth();
			case "config:settings":
				return handleSaveSettings();
			case "config:trust":
				return handleSaveTrust();
			case "config:mcp": {
				if (configTargetOption) return handleSaveWslMcp();
				const ok = (await mcpTabRef.current?.save()) ?? false;
				if (ok) {
					clearDirty("config:mcp");
					onSaved();
					showToast(t("config.saved"));
				}
				return ok;
			}
			case "mcp": {
				const ok = (await resourceMcpTabRef.current?.save()) ?? false;
				if (ok) {
					clearDirty("mcp");
					onSaved();
					showToast(t("config.saved"));
				}
				return ok;
			}
			case "config:raw":
				return handleSaveRaw();
			case "skills":
				return saveGlobalSkillEditor();
			case "prompts":
				return handleSaveEditPrompt();
			case "security":
				return securitySectionRef.current?.save() ?? false;
			default:
				// extensions 即时生效页无保存语义，无 dirty 时按钮不可点
				return false;
		}
	};

	/** 当前后端分页下的 tab 编码（DSH 页固定 "dsh"，Pi 页按 section:tab）。 */
	const currentTabKey = backendPane === "dsh" ? "dsh" : sectionTabValue(section, tab);

	/**
	 * 顶部统一保存按钮：模型页的新增/编辑供应商是一个页内子页面，
	 * 但它仍然属于 models 草稿；当前 tab 保持 models 时始终保存整个 models 草稿。
	 * 这样用户在供应商表单页点击窗口顶部保存时，不会因为子页面没有独立 tab 而漏掉变更。
	 */
	const handleSaveCurrent = async () => {
		if (saving) return;
		// 远端目标下统一保存按钮被禁用（远端面板自带「应用 patch」按钮），这里再兜底一次，
		// 保证任何键盘/外壳触发都不会把本机 models/settings 写入磁盘。
		if (configTarget.kind === "ssh") return;
		// 新增/编辑页的第一次点击只把页内草稿提交到 modelsData；
		// React state 更新后下一轮 effect 会自动继续落盘，用户无需再点一次保存。
		if (backendPane === "pi" && section === "config" && tab === "models" && (addingProvider || editingProvider)) {
			providerPageSavePendingRef.current = true;
			providerPageSaveRef.current?.();
			return;
		}
		// 无修改也放开再次保存；skills/prompts/extensions 等无保存语义的页
		// 由各自 save 方法（如 saveGlobalSkillEditor 的 !editingGlobalSkill 守卫）返回 false，不产生副作用。
		await saveByKey(currentTabKey);
	};

	/** 关闭弹框：有未保存修改时先弹保存确认（借鉴设置页），无修改直接关闭。 */
	const handleClose = () => {
		if (dirtyTabs.size > 0) {
			setCloseConfirmOpen(true);
		} else if (remoteConfigDirty) {
			// 远端 patch 不会随本机保存动作落盘；必须显式确认丢弃后才能关闭。
			setRemoteDiscardConfirmOpen(true);
		} else {
			onClose();
		}
	};

	/**
	 * 关闭确认框选择保存并关闭：汇总**全部**脏来源逐个保存（不是只存当前 tab），
	 * dsh:<nav> 归并到 dsh 一个保存入口；任一保存失败则留下重试（错误已展示在内容区）。
	 * 顺序由 orderDirtyKeysForSave 保证 settings 最后（它的重载会连带刷新 models/auth/raw）。
	 */
	const handleSaveAndClose = async () => {
		const roots = new Set<string>();
		for (const key of dirtyTabs) {
			roots.add(key.startsWith("dsh:") ? "dsh" : key);
		}
		for (const key of orderDirtyKeysForSave(roots)) {
			const ok = await saveByKey(key);
			if (!ok) return;
		}
		setCloseConfirmOpen(false);
		if (remoteConfigDirty) {
			// 本机脏项已逐个保存，但远端 patch 不在本机保存链路内：转成显式丢弃确认。
			setRemoteDiscardConfirmOpen(true);
			return;
		}
		onClose();
	};

	/** 关闭确认框选择放弃更改：丢弃所有未保存修改直接关闭。 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		onClose();
	};

	return { handleSecurityDirtyChange, handleMcpDirtyChange, handleResourceMcpDirtyChange, saveByKey, currentTabKey, handleSaveCurrent, handleClose, handleSaveAndClose, handleDiscardAndClose };
}
