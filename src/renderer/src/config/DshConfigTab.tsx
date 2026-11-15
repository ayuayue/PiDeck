import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { DSH_PERMISSION_PRESETS } from "../components/session/DshPermissionMenu";
import { Collapsible, CollapsibleContent } from "../components/ui-shadcn/collapsible";
import { useSaveRegistry } from "../hooks/useSaveRegistry";
import { DshSchemaForm, type DshNamespaceView } from "./DshSchemaForm";
import { dshRuntimeStatusAtom } from "../atoms/dsh-atoms";
import { isDshPluginNamespace, dshPluginNamespaceTitleKey, dshPluginNamespaceDescriptionKey } from "./dshPluginNamespaces";
import { DshPluginSection, PluginInventoryView } from "./DshPluginSection";
import { DshPluginMarketSection } from "./DshPluginMarketSection";
import { DeepseekRouteCard, PiAiProvidersCard } from "./DshProviderCards";
import { collectCredentialRefsWithValue, normalizeDshSchema, type DshSectionApi } from "./dshSchema";
import { credentialRefFor } from "./dshCredentialRef";
import { DshConfigEmpty } from "./dsh/DshConfigEmpty";
import { DshConfigOverview } from "./dsh/DshConfigOverview";
import { DshConfigPresetsTab } from "./dsh/DshConfigPresetsTab";
import { DshConfigRawTab } from "./dsh/DshConfigRawTab";
import { NAV_ITEMS, loadDshLastPluginPane, loadDshLastTab, rememberDshLastPluginPane, rememberDshLastTab } from "./dsh/dshConfigNav";
import type { CredentialState, DshStatus } from "./dsh/dshConfigTypes";
import { isDshManuallyStoppedErrorMessage } from "../../../shared/dshManualStop";

/**
 * DSH IPC 错误 → 展示文案：host 被手动停止时主进程以内部 sentinel reject，Electron
 * 包装后会把 "Error invoking remote method 'dsh:...': ..." 原样漏到 banner；命中 sentinel
 * 就映射成 i18n 引导文案（该状态不会自愈，报原始错误对用户没有诊断价值）。
 */
function dshConfigErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return isDshManuallyStoppedErrorMessage(raw) ? t("config.dsh.manuallyStoppedDesc") : raw;
}

/** 模型配置相关的 namespace：llm-deepseek（官方 DeepSeek 路由）+ llm-pi-ai（pi-ai providers dict）。 */
const MODEL_NS = new Set(["llm-deepseek", "llm-pi-ai"]);

/** 剥离 Electron IPC 包装前缀（"Error invoking remote method 'x': "），只保留主进程真实错误。
 *  与 GitPanel/useSessionActions 等处的清洗同一语义，这里收敛成本页局部 helper。 */
function stripIpcErrorPrefix(message: string): string {
	return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "");
}

/** DSH 配置页统一保存句柄（ConfigModal 顶部保存按钮经 ref 调用）。 */
export type DshConfigTabHandle = {
	/** 保存全部未保存修改；返回是否全部成功。 */
	save: () => Promise<boolean>;
	/** 重新拉取 DSH 配置（外部直写 settings 后刷新，如 TokenDance 一键安装）。 */
	reload: () => Promise<void>;
};

/**
 * DSH 配置管理页：左侧竖排导航 + 右侧内容区（与 Pi 管理同款操作逻辑）。
 * 概览 / 模型 / 预设 / 插件 / 安全 / 源文件；配置读写走 settings.describe（schema 表单）
 * 与 credentials.describe，模型 tab 以 provider 卡片 + 模型行管理 llm-pi-ai。
 *
 * 保存语义与 Pi 管理页一致：各分区不再自带保存按钮，草稿变化上报脏状态，
 * 统一由 ConfigModal 顶部保存按钮保存；关闭弹框时有未保存修改会弹确认。
 */
export const DshConfigTab = forwardRef<
	DshConfigTabHandle,
	{
		onDirtyChange: (dirty: boolean, keys?: string[]) => void;
		/** 有未保存更改的导航 id 集合（dsh:<nav>），用于左侧导航打黄点。 */
		dirtyNavIds?: Set<string>;
		/** 打开用量查询配置弹窗（与 Pi 模型页共用同一个 per-provider 弹窗）。 */
		onOpenUsageProbeDialog: (provider: string) => void;
		/** DSH 供应商卡片自定义顺序（AppSettings.dshProviderOrder）。 */
		providerOrder?: string[];
		/** 排序作用域：与「模型」「认证」两页共享的并集顺序（父级传入）。 */
		providerOrderScope?: string[];
		/** 卡片重排回调（ConfigModal 持有并持久化）。 */
		onReorderProviders?: (nextOrder: string[]) => void;
		/** 清空自定义顺序（列表上方的「恢复默认顺序」）。 */
		onResetProviders?: () => void;
	}
>(function DshConfigTab(props, ref) {
	const [status, setStatus] = useState<DshStatus | null>(null);
	const [namespaces, setNamespaces] = useState<DshNamespaceView[]>([]);
	const [writable, setWritable] = useState(false);
	const [hasDocument, setHasDocument] = useState(false);
	const [credentialRefs, setCredentialRefs] = useState<string[]>([]);
	const [credentials, setCredentials] = useState<Record<string, CredentialState>>({});
	/** 适配器内置模型目录（llm.models 按 provider 分组；行头模型数/继承模型用）。 */
	const [modelCatalog, setModelCatalog] = useState<Record<string, Array<{ id: string; name?: string }>>>({});
	/** 可配置提供方目录（llm.providers）：模型页「添加 provider」的内置候选。 */
	const [providerDirectory, setProviderDirectory] = useState<
		Array<{
			provider: string;
			displayName: string;
			active: boolean;
			declared?: boolean;
		}>
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	/** runtime 安装态（全局同步）：未安装时跳过配置加载，概览页由 DshRuntimeSection 承担安装引导。 */
	const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
	const runtimeInstalled = dshRuntimeStatus.state === "installed";
	const [activeTab, setActiveTab] = useState(loadDshLastTab);
	/** 插件 tab 内部子页（对齐 dsh-web：插件配置 / 插件列表）。 */
	const [pluginPane, setPluginPane] = useState<"config" | "list">(loadDshLastPluginPane);

	/** 切换导航子页并持久化：退出配置弹窗/重启应用后再进入，回到上次选定的界面。 */
	const selectTab = useCallback((id: string) => {
		setActiveTab(id);
		rememberDshLastTab(id);
	}, []);

	/** 切换插件子页并持久化（与 selectTab 同款记忆）。 */
	const selectPluginPane = useCallback((pane: "config" | "list") => {
		setPluginPane(pane);
		rememberDshLastPluginPane(pane);
	}, []);

	/** 子分区保存注册表（C22：公共 hook，instanceId → save；顶部保存按钮统一遍历调用）。
	 *  脏状态同步维护（isDirty 立即可读），state 仅驱动 UI。 */
	const { register: registryRegister, unregister: registryUnregister, markDirty: registryMarkDirty, isDirty: registryIsDirty, listDirtyKeys: registryListDirtyKeys, saveAll: registrySaveAll } = useSaveRegistry();

	const registerSave = useCallback(
		(instanceId: string, save: () => Promise<boolean>) => {
			registryRegister(instanceId, save);
		},
		[registryRegister],
	);

	const unregisterSave = useCallback(
		(instanceId: string) => {
			registryUnregister(instanceId);
		},
		[registryUnregister],
	);

	const onDirtyChange = useCallback(
		(instanceId: string, dirty: boolean) => {
			registryMarkDirty(instanceId, dirty);
			// 把子分区 instanceId（dsh:models:llm-pi-ai）归并成导航 id（dsh:models），侧栏才能打黄点。
			const navKeys = [
				...new Set(
					registryListDirtyKeys().map((key) => {
						if (!key.startsWith("dsh:")) return key;
						const nav = key.slice("dsh:".length).split(":")[0] ?? "";
						return nav ? `dsh:${nav}` : key;
					}),
				),
			];
			props.onDirtyChange(registryIsDirty(), navKeys);
		},
		[props.onDirtyChange, registryIsDirty, registryListDirtyKeys, registryMarkDirty],
	);

	const sectionApi: DshSectionApi = useMemo(
		() => ({
			onDirtyChange,
			registerSave,
			unregisterSave,
		}),
		[onDirtyChange, registerSave, unregisterSave],
	);

	/** 统一保存：遍历所有注册的子分区保存函数；全部成功返回 true。
	 *  成功后清除脏标记（含卸载/收起分区的残留）并上报上层。 */
	const saveAll = useCallback(async (): Promise<boolean> => {
		const ok = await registrySaveAll();
		if (ok) props.onDirtyChange(false);
		return ok;
	}, [props.onDirtyChange, registrySaveAll]);

	const load = useCallback(
		async (background = false) => {
			// 保存刷新不能卸载表单，否则冲突重试/校验失败会丢掉尚未提交的草稿。
			if (!background) setLoading(true);
			try {
				// runtime 未安装时 host 起不来，describe 必然失败：跳过配置加载，
				// 概览页由 DshRuntimeSection 展示安装引导；装好后 status-changed 触发重载。
				if (!runtimeInstalled) {
					setNamespaces([]);
					setWritable(false);
					setHasDocument(false);
					setModelCatalog({});
					setProviderDirectory([]);
					setError(null);
					return [];
				}
				const settingsResult = await desktopApi.sessions.describeDshSettings();
				setNamespaces(settingsResult.namespaces);
				setWritable(settingsResult.writable);
				setHasDocument(settingsResult.hasDocument);
				const refs = new Set<string>();
				for (const ns of settingsResult.namespaces) {
					const schema = normalizeDshSchema(ns.schema);
					// 同时收集 schema 静态 default 与 value 动态值（llm-pi-ai providers 的 env 名只存在 value 里）
					if (schema) collectCredentialRefsWithValue(schema, schema.refs[schema.uid], ns.value, refs);
					// 模型命名空间补派生 ref（对齐 dsh-web：未显式 apiKeyEnv 时按 <ROUTE>_API_KEY 派生），
					// 否则行头/认证页会漏掉只有派生名的 provider（如 llm-pi-ai 未写 apiKeyEnv 的配置）
					if (ns.ns === "llm-deepseek") {
						refs.add(credentialRefFor((ns.value ?? {}) as Record<string, unknown>, "deepseek"));
					} else if (ns.ns === "llm-pi-ai") {
						const providers = (ns.value as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
						for (const [key, provider] of Object.entries(providers)) {
							refs.add(credentialRefFor((provider ?? {}) as Record<string, unknown>, key));
						}
					}
				}
				setCredentialRefs([...refs]);
				// host 级模型目录：模型 tab 行头显示生效模型数、未自定义时展示内置目录（dsh-web 继承模型行）
				try {
					const models = await desktopApi.sessions.listDshModels();
					const byProvider: Record<string, Array<{ id: string; name?: string }>> = {};
					for (const model of models) {
						const group = (byProvider[model.provider] ??= []);
						group.push({ id: model.id, ...(typeof model.name === "string" && model.name ? { name: model.name } : {}) });
					}
					setModelCatalog(byProvider);
				} catch {
					setModelCatalog({});
				}
				// 可配置提供方目录：模型页「添加 provider」的内置候选（失败不阻塞页面）
				try {
					const directory = await desktopApi.sessions.listDshProviders();
					setProviderDirectory(directory);
				} catch {
					setProviderDirectory([]);
				}
				setError(null);
				// 返回本次拉到的 namespace 列表（saveNamespace 冲突重试要用最新 revision）
				return settingsResult.namespaces;
			} catch (err) {
				if (background) throw err;
				setError(dshConfigErrorMessage(err));
				// describe 失败说明 host boot 刚失败：同步刷新一次状态，让 bootError 详情
				// （getStatus().bootError）尽早到位，错误 banner 能展示真实原因而不是只有笼统 IPC 消息。
				void loadStatus();
				return undefined;
			} finally {
				if (!background) setLoading(false);
			}
		},
		[runtimeInstalled],
	);

	// 句柄依赖 load（声明在其后）：reload 供外部直写 settings 后刷新（如 TokenDance 一键安装）。
	useImperativeHandle(
		ref,
		() => ({
			save: saveAll,
			reload: async () => {
				await load();
			},
		}),
		[saveAll, load],
	);

	/** 状态（host 是否启动/目录）独立加载：不依赖 settings.describe，
	 * host boot 失败时概览页仍能显示当前目录与重启入口，而不是整页空白。 */
	const loadStatus = useCallback(async () => {
		try {
			const statusResult = await desktopApi.sessions.getDshStatus();
			setStatus(statusResult);
		} catch {
			// 状态查询失败不阻塞页面（无 host 时部分字段为空即可）
		}
	}, []);

	/**
	 * 错误 banner 的一键恢复：走与概览区「重启 host」相同的完整重启链路
	 * （主进程先停掉活跃 DSH 会话再重新 fork），成功后刷新配置与状态。
	 */
	const restartHostFromBanner = useCallback(async () => {
		try {
			const restarted = await desktopApi.sessions.restartDshHost();
			showNotice(restarted ? t("config.dsh.hostRestarted") : t("config.dsh.hostRestartFailed"), restarted ? 4000 : 6000);
		} catch (err) {
			showNotice(err instanceof Error ? err.message : String(err), 4000);
		} finally {
			void load();
			void loadStatus();
		}
	}, [load, loadStatus]);

	/** 写密钥（credentials.set）+ 刷新认证状态；供模型页/认证页共用。 */
	const setDshKey = useCallback(
		async (ref: string, value: string) => {
			await desktopApi.sessions.setDshCredential(ref, value);
			await load();
		},
		[load],
	);

	/** 删密钥（credentials.unset）+ 刷新认证状态。 */
	const unsetDshKey = useCallback(
		async (ref: string) => {
			await desktopApi.sessions.unsetDshCredential(ref);
			await load();
		},
		[load],
	);

	useEffect(() => {
		void load();
		void loadStatus();
	}, [load, loadStatus]);

	// runtime 未安装时配置分区（models/presets/plugins 等）没有内容，
	// 把导航钳制到概览页，保证用户一进来看到的就是安装引导。
	// describe 失败（host boot 失败）时同理：配置分区无数据可渲染，留在概览页看错误原因。
	useEffect(() => {
		if ((!runtimeInstalled || error) && activeTab !== "overview") selectTab("overview");
	}, [runtimeInstalled, error, activeTab, selectTab]);

	useEffect(() => {
		const onMigrated = () => {
			void load();
		};
		window.addEventListener("pideck:provider-migrated", onMigrated);
		return () => window.removeEventListener("pideck:provider-migrated", onMigrated);
	}, [load]);

	useEffect(() => {
		if (credentialRefs.length === 0) return;
		void desktopApi.sessions
			.describeDshCredentials(credentialRefs)
			.then(setCredentials)
			.catch(() => undefined);
	}, [credentialRefs]);

	const modelNamespaces = useMemo(() => namespaces.filter((ns) => MODEL_NS.has(ns.ns)), [namespaces]);
	// G13：插件分区动态化——DSH 的 settings namespace 即插件短名（dsh-settings 契约），
	// 除 PiDeck 独占管理的保留命名空间（模型/安全/预设）外，host 注册的命名空间全部按插件呈现。
	const pluginNamespaces = useMemo(() => namespaces.filter((ns) => isDshPluginNamespace(ns.ns)), [namespaces]);
	const permissionNamespace = useMemo(() => namespaces.find((ns) => ns.ns === "permission"), [namespaces]);

	const openFolder = (path: string) => {
		if (path) void desktopApi.files.showInFolder(path).catch(() => undefined);
	};

	const saveNamespace = useCallback(
		async (ns: string, patch: Record<string, unknown>) => {
			const view = namespaces.find((item) => item.ns === ns);
			try {
				await desktopApi.sessions.updateDshSettings(ns, patch, view?.revision);
			} catch (error) {
				// SETTINGS_CONFLICT：并发写入（host 预设/dsh-web/另一 tab）使本页 revision
				// 过期，host 拒绝本次写入。若沿用旧 revision 重试会被永久拒绝——刷新
				// namespace（拿最新 revision 与现值）后重试一次，patch 是部分合并仍安全。
				// 其它错误（schema 拒绝等）原样上抛，由子卡片展示错误并保留草稿。
				const isConflict = error instanceof Error && (error.message.includes("SETTINGS_CONFLICT") || error.message.includes("changed since it was read"));
				if (!isConflict) throw error;
				const fresh = await load(true);
				const freshView = fresh?.find((item) => item.ns === ns);
				await desktopApi.sessions.updateDshSettings(ns, patch, freshView?.revision);
			}
			// 保存后刷新（revision / 脱敏值更新），保持页内表单挂载。
			await load(true);
		},
		[namespaces, load],
	);

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			{/* 左侧竖排导航：常驻（loading/error 时不隐藏），与 Pi 管理 config-sidebar 同款密度 */}
			{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
			<nav className="flex min-h-0 w-40 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-border bg-transparent p-2.5" aria-label={t("config.dsh.title")}>
				<div className="grid gap-0.5">
					{NAV_ITEMS.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`config-nav-btn flex h-8 items-center justify-start gap-1.5 rounded-md px-2.5 text-control font-medium ${activeTab === item.id ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
							onClick={() => selectTab(item.id)}
						>
							<span className="config-nav-icon">{item.icon}</span>
							{t(item.labelKey)}
							{/* 未保存标记：与 Pi 管理侧栏黄点同款，提醒用户该分区有草稿 */}
							{props.dirtyNavIds?.has(`dsh:${item.id}`) ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" /> : null}
						</button>
					))}
				</div>
			</nav>

			{/* 右侧内容区：loading/error 只影响内容，导航与概览保持可用 */}
			{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
				{loading && (
					<div className="flex min-h-32 items-center justify-center gap-2 text-control text-muted-foreground">
						<LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" />
						{t("common.loading")}
					</div>
				)}
				{!loading && error && status?.manuallyStopped !== true && (
					<div className="m-4 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5">
						<p className="text-control font-medium text-danger">{t("config.dsh.bootFailedTitle")}</p>
						<p className="mt-1 text-caption leading-relaxed text-danger/90">{t("config.dsh.bootFailedHint")}</p>
						{/* 真实失败原因：优先 host boot 详情（getStatus().bootError），退回 IPC 错误原文；
						    失败是确定性的（runtime 损坏/依赖缺失等），重试前先让用户看到原因。 */}
						{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
						{(status?.bootError || error) && <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-sm border border-danger/20 bg-bg-panel/60 px-2.5 py-2 text-micro leading-relaxed text-danger/90">{status?.bootError || stripIpcErrorPrefix(error)}</pre>}
						<div className="mt-2.5 flex gap-2">
							<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => void load()}>
								{t("config.dsh.retry")}
							</Button>
							{/* 一键恢复入口：重启 host 常能解决瞬时失败；下方概览区也有同款按钮。 */}
							<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => void restartHostFromBanner()}>
								<RefreshCw className="size-3.5" aria-hidden="true" />
								{t("config.dsh.restartHost")}
							</Button>
						</div>
					</div>
				)}
				{/* 手动停止态：describe 失败是预期（host 已被用户停掉），不报错；
				    概览区的「已手动停止」徽标 + 「启动」按钮负责状态表达与恢复入口。 */}
				{!loading && error && status?.manuallyStopped === true && (
					<div className="m-4 rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-2.5">
						<p className="text-control text-muted-foreground">{t("config.dsh.manuallyStoppedDesc")}</p>
					</div>
				)}
				{!loading && (
					<>
						{/* tab 切换用 hidden 而非卸载：子分区草稿跨 tab 保留（统一保存语义） */}
						<div hidden={activeTab !== "overview"}>
							<DshConfigOverview
								status={status}
								hasDocument={hasDocument}
								onOpenFolder={openFolder}
								onOpenDocument={openDocument}
								onChanged={() => {
									void load();
									void loadStatus();
								}}
							/>
						</div>
						{/* 配置分区依赖 namespaces：describe 失败时无数据可渲染，留在概览页即可（错误 banner 已解释原因） */}
						{!error && (
							<>
								<div hidden={activeTab !== "models"}>
									<div className="p-4">
										<p className="mb-3 text-micro text-muted-foreground">{t("config.dsh.modelsHint")}</p>
										{modelNamespaces.length === 0 ? (
											<DshConfigEmpty text={t("config.dsh.namespacesEmpty")} />
										) : (
											<div className="grid gap-4">
												{modelNamespaces.map((ns) => (
													<section key={ns.ns} className="rounded-md border border-border-subtle bg-bg-panel">
														{ns.ns === "llm-pi-ai" ? (
															<PiAiProvidersCard
																namespace={ns}
																writable={writable}
																ops={{ credentials, setKey: setDshKey, unsetKey: unsetDshKey }}
																catalog={modelCatalog}
																directory={providerDirectory}
																onSave={(patch) => saveNamespace(ns.ns, patch)}
																sectionApi={sectionApi}
																onMigrated={() => {
																	void load();
																}}
																instanceKey={`dsh:models:${ns.ns}`}
																onOpenUsageProbeDialog={props.onOpenUsageProbeDialog}
																providerOrder={props.providerOrder}
																providerOrderScope={props.providerOrderScope}
																onReorderProviders={props.onReorderProviders}
																onResetProviders={props.onResetProviders}
															/>
														) : (
															<DeepseekRouteCard
																namespace={ns}
																writable={writable}
																ops={{ credentials, setKey: setDshKey, unsetKey: unsetDshKey }}
																catalog={modelCatalog["deepseek-official"]}
																onSave={(patch) => saveNamespace(ns.ns, patch)}
																onRefresh={load}
																sectionApi={sectionApi}
																instanceKey={`dsh:models:${ns.ns}`}
																onMigrated={() => {
																	void load();
																}}
																onOpenUsageProbeDialog={props.onOpenUsageProbeDialog}
															/>
														)}
													</section>
												))}
											</div>
										)}
									</div>
								</div>
								<div hidden={activeTab !== "presets"}>
									<div className="p-4">
										<DshConfigPresetsTab
											writable={writable}
											namespace={namespaces.find((ns) => ns.ns === "agent-preset-registry")}
											onSave={async (id) => {
												const view = namespaces.find((ns) => ns.ns === "agent-preset-registry");
												await desktopApi.sessions.updateDshSettings("agent-preset-registry", { selectedDefault: id }, view?.revision);
												await load();
											}}
											sectionApi={sectionApi}
											instanceKey="dsh:presets"
										/>
									</div>
								</div>
								<div hidden={activeTab !== "plugins"}>
									<div className="grid gap-4 p-4">
										{/* 子 tab 栏（对齐 dsh-web 插件页）：插件配置 / 插件列表 */}
										<div className="flex items-center gap-4 border-b border-border/60 px-1">
											{(
												[
													{ id: "config", labelKey: "config.dsh.tab.pluginConfig" },
													{ id: "list", labelKey: "config.dsh.tab.pluginList" },
												] as const
											).map((pane) => (
												<button key={pane.id} type="button" className={`-mb-px border-b-2 pb-2 pt-1 text-caption font-medium transition-colors ${pluginPane === pane.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => selectPluginPane(pane.id)}>
													{t(pane.labelKey)}
												</button>
											))}
										</div>
										<div hidden={pluginPane !== "config"}>
											<div className="grid gap-2">
												<p className="text-micro text-muted-foreground">{t("config.dsh.pluginsHint")}</p>
												{pluginNamespaces.length === 0 ? (
													<DshConfigEmpty text={t("config.dsh.namespacesEmpty")} />
												) : (
													<div className="grid gap-2">
														{pluginNamespaces.map((ns) => (
															<PluginCard key={ns.ns} ns={ns} writable={writable} onSave={(patch) => saveNamespace(ns.ns, patch)} sectionApi={sectionApi} instanceKey={`dsh:plugins:${ns.ns}`} />
														))}
													</div>
												)}
											</div>
											{/* G13 深化：动态 Cordis 插件管理（define/run/stop/undefine），PiDeck 独有能力保留在配置页。
									    与上方静态插件配置卡片分区：横线 + 间距隔开，避免两区视觉粘连。 */}
											<div className="mt-6 border-t border-border/60 pt-4">
												<DshPluginSection />
											</div>
											{/* 插件市场（搜索/安装/已安装列表）：与上方插件管理分区，同用横线隔开。 */}
											<div className="mt-6 border-t border-border/60 pt-4">
												<DshPluginMarketSection />
											</div>
										</div>
										<div hidden={pluginPane !== "list"}>
											<PluginInventoryView />
										</div>
									</div>
								</div>
								<div hidden={activeTab !== "security"}>
									<div className="p-4">
										<SecurityTab namespace={permissionNamespace} writable={writable} onSave={(patch) => saveNamespace("permission", patch)} onChanged={() => void load()} sectionApi={sectionApi} instanceKey="dsh:security" />
									</div>
								</div>
								<div hidden={activeTab !== "raw"} className="flex min-h-0 flex-1 flex-col">
									<div className="flex min-h-0 flex-1 flex-col p-4">
										<DshConfigRawTab homeDir={status?.homeDir ?? ""} sectionApi={sectionApi} instanceKey="dsh:raw" />
									</div>
								</div>
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
});

/** settings.openDocument：让 host 把配置文档交给平台打开。 */
function openDocument() {
	void desktopApi.sessions.openDshDocument?.().catch(() => undefined);
}

/**
 * 插件配置卡片（对齐 dsh-web 的插件设置分区）：收起时一行展示插件名称、描述与
 * 生效方式，点击展开后才渲染该插件命名空间的配置表单；避免一进来就是
 * 一堆输入框。卡片持有自己的展开状态与表单草稿（收起再展开不丢草稿）。
 */
function PluginCard(props: {
	ns: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:plugins:<ns>），透传给 DshSchemaForm。 */
	instanceKey?: string;
}) {
	const [open, setOpen] = useState(false);
	// G13：已知插件走 i18n 标题；host 新注册的插件命名空间回退显示 ns 原名
	const titleKey = dshPluginNamespaceTitleKey(props.ns.ns);
	const descriptionKey = dshPluginNamespaceDescriptionKey(props.ns.ns);
	return (
		<div className="rounded-xl border border-border-subtle bg-bg-panel transition-colors hover:border-border">
			<button type="button" className="flex w-full items-center gap-3 px-4 py-3.5 text-left" onClick={() => setOpen((prev) => !prev)}>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-semibold text-foreground">{titleKey ? t(titleKey) : props.ns.ns}</span>
					{descriptionKey && <span className="mt-0.5 block truncate text-caption text-muted-foreground">{t(descriptionKey)}</span>}
				</span>
				<span className="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">{props.ns.applies === "live" ? t("config.dsh.appliesLive") : t("config.dsh.appliesRestart")}</span>
				<ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast ${open ? "rotate-180" : ""}`} aria-hidden="true" />
			</button>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 让根不生成盒子，折叠态零空档。 */}
			<Collapsible open={open} className="contents">
				<CollapsibleContent className="border-t border-border/40">
					<DshSchemaForm namespace={props.ns} writable={props.writable} onSave={props.onSave} sectionApi={props.sectionApi} instanceKey={props.instanceKey} />
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

/**
 * 安全 tab（对齐 dsh-web 的 permission 预设）：新会话默认权限预设
 * （read-only / workspace-write / danger-full-access，sandbox + approval 捆绑）
 * + PiDeck 侧的审批自动放行开关（仅影响本应用内的 DSH 会话）。
 * 默认预设保存与 Pi 管理页一致：草稿暂存，顶部统一保存提交；
 * autoAllow 是 PiDeck 运行时开关，即时生效不入统一保存。
 */
function SecurityTab(props: { namespace?: DshNamespaceView; writable: boolean; onSave: (patch: Record<string, unknown>) => Promise<void>; onChanged: () => void; sectionApi?: DshSectionApi; instanceKey?: string }) {
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [autoAllow, setAutoAllow] = useState(false);
	const [autoAllowLoaded, setAutoAllowLoaded] = useState(false);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setAutoAllow(settings.dshApprovalAutoAllow === true);
				setAutoAllowLoaded(true);
			})
			.catch(() => setAutoAllowLoaded(true));
	}, []);

	/** 切换审批自动放行：乐观更新 UI，写设置失败回滚。运行时读取、无需重启 host。 */
	const toggleAutoAllow = async (checked: boolean) => {
		const prev = autoAllow;
		setAutoAllow(checked);
		try {
			await desktopApi.settings.update({ dshApprovalAutoAllow: checked });
			showNotice(t(checked ? "config.dsh.autoAllowOn" : "config.dsh.autoAllowOff"), 3000);
		} catch (saveError) {
			setAutoAllow(prev);
			showNotice(saveError instanceof Error ? saveError.message : String(saveError), 4000);
		}
	};

	const value = props.namespace?.value as { defaultPreset?: unknown } | undefined;
	const currentDefault = typeof value?.defaultPreset === "string" ? value.defaultPreset : undefined;
	const selected = draft ?? currentDefault;

	const dirty = draft !== null;
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：提交新会话默认权限预设。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!draft) return true;
		setSaving(true);
		setError(null);
		try {
			await props.onSave({ defaultPreset: draft });
			setDraft(null);
			props.onChanged();
			return true;
		} catch (saveError) {
			setError(dshConfigErrorMessage(saveError));
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, props]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	return (
		<div className="grid gap-4">
			<p className="text-micro text-muted-foreground">{t("config.dsh.securityHint")}</p>
			<section className="rounded-md border border-border-subtle bg-bg-panel">
				<div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
					<span className="text-caption font-semibold text-foreground">{t("config.dsh.securityDefaultPreset")}</span>
					{error && (
						<span className="max-w-64 truncate text-micro text-danger" title={error}>
							{error}
						</span>
					)}
					{dirty && (
						<span className="ml-auto text-micro text-warning" title={t("config.dirtyTooltip")}>
							●
						</span>
					)}
					{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
				</div>
				<div className="grid gap-3 p-4">
					<Select value={selected ?? ""} disabled={!props.writable} onValueChange={(next) => setDraft(next === currentDefault ? null : next)}>
						<SelectTrigger size="sm" className="w-72">
							<SelectValue placeholder={t("config.dsh.selectPlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							{DSH_PERMISSION_PRESETS.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									<span className="font-medium">{t(preset.labelKey)}</span>
									<span className="ml-2 text-micro text-muted-foreground">{t(preset.descriptionKey)}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="grid gap-1.5">
						{DSH_PERMISSION_PRESETS.map((preset) => (
							<div key={preset.id} className="flex items-baseline gap-2 text-micro text-muted-foreground">
								<span className="w-28 shrink-0 font-mono text-caption text-foreground/80">{t(preset.labelKey)}</span>
								<span>{t(preset.descriptionKey)}</span>
							</div>
						))}
					</div>
				</div>
			</section>
			<section className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
				<div className="flex items-center justify-between gap-4">
					<div className="grid gap-0.5">
						<span className="text-caption font-semibold text-foreground">{t("config.dsh.approvals")}</span>
						<p className="text-micro text-muted-foreground">{t("config.dsh.autoAllowApprovalHint")}</p>
					</div>
					<Switch checked={autoAllow} disabled={!autoAllowLoaded} onCheckedChange={(checked) => void toggleAutoAllow(checked)} />
				</div>
			</section>
		</div>
	);
}
