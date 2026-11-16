import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import { t } from "../../i18n";
import { AuthTab } from "../AuthTab";
import type { AuthFile, ConfigTab } from "../configTypes";
import { RemoteAuthPanel } from "../RemoteAuthPanel";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";

/** 删除确认弹窗的请求体（auth 页只产出 auth / batch 两种，类型与父级 state 同一形状）。 */
export type ConfigDeleteConfirmRequest = {
	type: "provider" | "model" | "auth" | "batch";
	title: string;
	message: string;
	onConfirm: () => void;
};

type ConfigAuthEditingDeps = {
	api: PiDesktopApi;
	configTargetOption: { target: PiConfigTarget } | undefined;
	authData: AuthFile;
	setAuthData: Dispatch<SetStateAction<AuthFile>>;
	newAuthName: string;
	setNewAuthName: Dispatch<SetStateAction<string>>;
	expandedAuth: string | null;
	setExpandedAuth: Dispatch<SetStateAction<string | null>>;
	setAddingAuth: Dispatch<SetStateAction<boolean>>;
	markDirty: (tabKey: string) => void;
	setDeleteConfirm: Dispatch<SetStateAction<ConfigDeleteConfirmRequest | null>>;
	/** 统一保存流程（写盘 → 校验 → toast → 清脏）。 */
	saveAndReload: (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string) => Promise<boolean>;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
};

/**
 * 认证页的增删改动作：只搬数据与 IPC 动作，不渲染（与 useConfigModelsProviderEditing 同形）。
 * auth.json 是内存草稿，落盘统一走 saveAndReload 后整页 force 重读。
 */
export function useConfigAuthEditing(deps: ConfigAuthEditingDeps) {
	const { api, configTargetOption, authData, setAuthData, newAuthName, setNewAuthName, expandedAuth, setExpandedAuth, setAddingAuth, markDirty, setDeleteConfirm, saveAndReload, reloadConfig } = deps;

	const handleUpdateAuth = (provider: string, field: string, value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
		markDirty("config:auth");
	};

	/**
	 * 添加认证条目。
	 * name 和 key 从 AuthTab 供应商选择弹窗直接传入，
	 * 避免 React 闭包中状态尚未刷新的问题，且支持弹窗内直接填写 API Key。
	 */
	const handleAddAuth = (name?: string, key?: string) => {
		const finalName = name ?? newAuthName.trim();
		if (!finalName) return;
		setAuthData({
			...authData,
			[finalName]: { type: "api_key", key: key ?? "" },
		});
		markDirty("config:auth");
		setExpandedAuth(finalName);
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		setDeleteConfirm({
			type: "auth",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: provider }),
			onConfirm: () => {
				const updated = { ...authData };
				delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (expandedAuth === provider) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateAuth = (provider: string) => {
		const sourceAuth = authData[provider];
		if (!sourceAuth) return;
		const duplicatedAuth = structuredClone(sourceAuth);
		let newName = `${provider} copy`;
		let counter = 2;
		while (authData[newName]) {
			newName = `${provider} copy ${counter}`;
			counter++;
		}
		setAuthData({
			...authData,
			[newName]: duplicatedAuth,
		});
		markDirty("config:auth");
		setExpandedAuth(newName);
	};

	const handleDeleteAuths = (providers: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: providers.length }),
			onConfirm: () => {
				const updated = { ...authData };
				for (const provider of providers) delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (providers.includes(expandedAuth ?? "")) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveAuth = async (): Promise<boolean> => {
		const save = () => (configTargetOption ? api.config.saveRaw("auth.json", JSON.stringify(authData, null, 2), configTargetOption) : api.config.saveAuth(authData));
		const ok = await saveAndReload(save, undefined, "config:auth");
		await reloadConfig("auth", { force: true });
		return ok;
	};

	return { handleUpdateAuth, handleAddAuth, handleDeleteAuth, handleDuplicateAuth, handleDeleteAuths, handleSaveAuth };
}

export type ConfigAuthTabProps = {
	/** WSL 目标的来源提示（本机/ssh 为 undefined）。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	/** ssh 目标的主机 id：非空时整页换成只读远端面板。 */
	remoteTargetHostId: string | null;
	remoteHostLabel: string | undefined;
	/** 页顶部共用的加载/错误提示与诊断卡（父级同一份 element 多处复渲染）。 */
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
} & ComponentProps<typeof AuthTab>;

/** 认证页内容（`config:auth` TabsContent 整块）。 */
export function ConfigAuthTab({ wslTargetHost, remoteTargetHostId, remoteHostLabel, statusBlock, configDiagnosticBlock, loading, ...authTabProps }: ConfigAuthTabProps) {
	return (
		<div className="config-content">
			{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="auth" /> : null}
			{/* ssh：凭据永不跨机回传，这一页只有派生视图（provider / 类型 / 是否已配置），没有可编辑表单。 */}
			{remoteTargetHostId ? (
				<RemoteAuthPanel key={"remote-auth-" + remoteTargetHostId} hostId={remoteTargetHostId} hostLabel={remoteHostLabel} />
			) : (
				<>
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && <AuthTab {...authTabProps} />}
				</>
			)}
		</div>
	);
}
