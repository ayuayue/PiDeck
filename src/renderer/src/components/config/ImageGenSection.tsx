/**
 * 设置 → 生图。
 * 独立供应商，不属于 pi/dsh 任一后端，不读写 pi models.json。接口一律 OpenAI 兼容；
 * 用户勾选该供应商支持的官方字段（size / output_format / watermark），
 * composer 才展示对应控件。保存走 ConfigModal 顶部统一按钮。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { imageGenConfigAtom } from "../../atoms";
import { Loader2, ChevronDown, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { DEFAULT_IMAGE_GEN_EXTRA_PARAMS, EMPTY_IMAGE_GEN_CONFIG, type ImageGenConfigFile, type ImageGenExtraParam, type ImageGenProviderConfig } from "../../../../shared/imageGenConfig";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
// 复用设置页共享分区/行原语，保证与其余设置 tab 同一套排版
import { SettingsSection } from "../app/settings/SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "../app/settings/SettingRows";
import { SecretValueInput, secretHint } from "../app/settings/SecretValueInput";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { FetchedModelCombobox } from "../../config/FetchedModelCombobox";
import type { FetchedModel } from "../../../../shared/types/fetchedModel";

export type ImageGenSectionHandle = {
	save: () => Promise<boolean>;
};

type ImageGenSectionProps = {
	onDirtyChange?: (dirty: boolean) => void;
};

const EXTRA_PARAM_KEYS: Array<{ key: ImageGenExtraParam; labelKey: "config.imagegen.paramSize" | "config.imagegen.paramOutputFormat" | "config.imagegen.paramWatermark"; hintKey: "config.imagegen.paramSizeHint" | "config.imagegen.paramOutputFormatHint" | "config.imagegen.paramWatermarkHint" }> = [
	{ key: "size", labelKey: "config.imagegen.paramSize", hintKey: "config.imagegen.paramSizeHint" },
	{ key: "output_format", labelKey: "config.imagegen.paramOutputFormat", hintKey: "config.imagegen.paramOutputFormatHint" },
	{ key: "watermark", labelKey: "config.imagegen.paramWatermark", hintKey: "config.imagegen.paramWatermarkHint" },
];

function newProviderId(): string {
	return `ig-${crypto.randomUUID().slice(0, 8)}`;
}

function createProvider(): ImageGenProviderConfig {
	return {
		id: newProviderId(),
		name: "",
		baseUrl: "",
		apiKey: "",
		models: [],
		extraParams: { ...DEFAULT_IMAGE_GEN_EXTRA_PARAMS },
	};
}

export const ImageGenSection = forwardRef<ImageGenSectionHandle, ImageGenSectionProps>(function ImageGenSection({ onDirtyChange }, ref) {
	const setImageGenConfig = useSetAtom(imageGenConfigAtom);
	const [draft, setDraft] = useState<ImageGenConfigFile>(EMPTY_IMAGE_GEN_CONFIG);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fetchingId, setFetchingId] = useState<string | null>(null);
	const [fetchedByProvider, setFetchedByProvider] = useState<Record<string, FetchedModel[]>>({});
	const [selectedIdsByProvider, setSelectedIdsByProvider] = useState<Record<string, string[]>>({});
	const [fetchErrorByProvider, setFetchErrorByProvider] = useState<Record<string, string | undefined>>({});
	// 供应商折叠态（仅 UI 状态，不进配置文件）：默认只展开第一个，其余收起，避免多供应商平铺撑爆页面
	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
	/**
	 * 磁盘上真正存着的密钥（providerId → apiKey），用来区分摘要里的「已保存」与「当前」。
	 * 只在载入与保存成功两处更新，不参与渲染态推导，故用 ref。
	 */
	const savedKeysRef = useRef<Record<string, string>>({});

	const rememberSavedKeys = useCallback((config: ImageGenConfigFile) => {
		savedKeysRef.current = Object.fromEntries(config.providers.map((provider) => [provider.id, provider.apiKey]));
	}, []);

	const toggleCollapsed = useCallback((id: string) => {
		setCollapsedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	// 全部展开：清空折叠集合（新供应商默认展开，无需补登记）
	const expandAll = useCallback(() => {
		setCollapsedIds(new Set());
	}, []);

	// 全部收起：将当前所有供应商登记为折叠
	const collapseAll = useCallback(() => {
		setCollapsedIds(new Set(draft.providers.map((provider) => provider.id)));
	}, [draft.providers]);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.imagegen
			.getConfig()
			.then((loaded) => {
				if (cancelled) return;
				setDraft(loaded);
				rememberSavedKeys(loaded);
				// 按“列表”形态初始化：仅保留第一个展开，其余先收起
				setCollapsedIds(new Set(loaded.providers.slice(1).map((provider) => provider.id)));
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [rememberSavedKeys]);

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);

	useEffect(() => {
		return () => onDirtyChange?.(false);
	}, [onDirtyChange]);

	const patchDraft = useCallback((updater: (current: ImageGenConfigFile) => ImageGenConfigFile) => {
		setDraft(updater);
		setDirty(true);
	}, []);

	const updateProvider = useCallback(
		(id: string, patch: Partial<ImageGenProviderConfig>) => {
			patchDraft((current) => ({
				...current,
				providers: current.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)),
			}));
		},
		[patchDraft],
	);

	const handleSave = useCallback(async (): Promise<boolean> => {
		if (saving) return false;
		setSaving(true);
		setError(null);
		try {
			const result = await desktopApi.imagegen.saveConfig(draft);
			if (!result.ok) {
				setError(result.error ?? t("config.imagegen.saveFailed"));
				return false;
			}
			setDraft(result.config);
			rememberSavedKeys(result.config);
			setDirty(false);
			setImageGenConfig(result.config);
			showNotice(t("config.imagegen.saved"), 2500);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, saving, setImageGenConfig, rememberSavedKeys]);

	useImperativeHandle(ref, () => ({ save: () => handleSave() }), [handleSave]);

	const fetchModels = async (provider: ImageGenProviderConfig) => {
		if (!provider.baseUrl.trim() || !provider.apiKey.trim()) {
			setFetchErrorByProvider((current) => ({
				...current,
				[provider.id]: t("config.imagegen.fetchNeedKey"),
			}));
			return;
		}
		setFetchingId(provider.id);
		setFetchErrorByProvider((current) => ({ ...current, [provider.id]: undefined }));
		try {
			const result = await desktopApi.config.fetchModels(provider.baseUrl, provider.apiKey, "openai-completions");
			if (result.success && result.models) {
				setFetchedByProvider((current) => ({ ...current, [provider.id]: result.models ?? [] }));
				setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: [] }));
				showNotice(t("config.fetchedModels", { count: result.models.length }), 3000);
			} else {
				setFetchErrorByProvider((current) => ({
					...current,
					[provider.id]: result.error ?? t("config.fetchModelsFailed"),
				}));
			}
		} catch (e) {
			setFetchErrorByProvider((current) => ({
				...current,
				[provider.id]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingId(null);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}

	const allCollapsed = draft.providers.length > 0 && draft.providers.every((provider) => collapsedIds.has(provider.id));

	return (
		<div className="min-w-0">
			<SettingsSection
				title={t("config.imagegen.section")}
				description={t("config.imagegen.sectionDesc")}
				/* 全部展开/收起：多供应商时快速切换列表形态 */
				action={
					draft.providers.length > 0 ? (
						<Button type="button" variant="ghost" size="sm" className="h-7" onClick={allCollapsed ? expandAll : collapseAll}>
							{allCollapsed ? t("config.imagegen.expandAll") : t("config.imagegen.collapseAll")}
						</Button>
					) : undefined
				}
			>
				{error ? (
					<div className="px-1 pt-2">
						<small className="text-caption leading-relaxed text-danger">{error}</small>
					</div>
				) : null}
				{draft.providers.length === 0 ? <div className="px-1 py-2 text-control text-muted-foreground">{t("config.imagegen.empty")}</div> : null}
				{draft.providers.map((provider) => {
					const fetched = fetchedByProvider[provider.id] ?? [];
					const collapsed = collapsedIds.has(provider.id);
					const modelCount = provider.models.filter(Boolean).length;
					// 密钥摘要：掩码态也要能核对「存的是哪一格、有没有被截断/多个空格」，措辞区分磁盘上的「已保存」与草稿里的「当前」
					const apiKeyHint = secretHint(provider.apiKey);
					const apiKeyHintText = apiKeyHint ? t(provider.apiKey === (savedKeysRef.current[provider.id] ?? "") ? "config.imagegen.apiKeySavedSummary" : "config.imagegen.apiKeyCurrentSummary", apiKeyHint) : null;
					return (
						<Collapsible key={provider.id} open={!collapsed} onOpenChange={() => toggleCollapsed(provider.id)} className="border-t border-border-subtle/60 first:border-t-0">
							{/* 供应商标题行：折叠时名称后附「接口地址 · 模型数」摘要，收起后仍可一眼辨认。
							    删除按钮与 trigger 平级（button 嵌套 button 非法）。 */}
							<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1">
								<CollapsibleTrigger asChild>
									<button type="button" className="flex min-w-0 items-center gap-2 py-2 text-left" title={collapsed ? t("common.expand") : t("common.collapse")}>
										<ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
										<span className="shrink-0 truncate text-control font-medium text-foreground">{provider.name.trim() || t("config.imagegen.unnamedProvider")}</span>
										{collapsed ? (
											<small className="min-w-0 truncate text-caption text-muted-foreground">
												{provider.baseUrl.trim() ? `${provider.baseUrl.trim()} · ` : ""}
												{t("config.imagegen.modelsCount", { count: modelCount })}
											</small>
										) : null}
									</button>
								</CollapsibleTrigger>
								<div className="flex items-center justify-end gap-2">
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="shrink-0"
										title={t("config.imagegen.removeProvider")}
										aria-label={t("config.imagegen.removeProvider")}
										onClick={() =>
											patchDraft((current) => ({
												...current,
												providers: current.providers.filter((item) => item.id !== provider.id),
											}))
										}
									>
										<Trash2 size={14} aria-hidden="true" />
									</Button>
								</div>
							</div>
							<CollapsibleContent>
								{/* 展开体与标题行之间补一条分隔线：SettingRow 的 first:border-t-0 会吃掉首行自身边线 */}
								<div className="border-t border-border-subtle/60 pb-1">
									<SettingRow title={<span>{t("config.imagegen.providerName")}</span>} stacked>
										<Input aria-label={t("config.imagegen.providerName")} value={provider.name} placeholder={t("config.imagegen.providerNamePlaceholder")} onChange={(event) => updateProvider(provider.id, { name: event.target.value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.imagegen.baseUrl")}</span>} stacked>
										<Input aria-label={t("config.imagegen.baseUrl")} value={provider.baseUrl} placeholder="https://api.openai.com/v1" onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.imagegen.apiKey")}</span>} stacked>
										<SecretValueInput label={t("config.imagegen.apiKey")} value={provider.apiKey} hintText={apiKeyHintText} onChange={(value) => updateProvider(provider.id, { apiKey: value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.imagegen.extraParams")}</span>} description={t("config.imagegen.extraParamsHint")} stacked>
										<div className="grid">
											{EXTRA_PARAM_KEYS.map((item) => (
												<SettingSwitchRow
													key={item.key}
													title={t(item.labelKey)}
													description={t(item.hintKey)}
													checked={provider.extraParams[item.key] === true}
													onChange={(checked) =>
														updateProvider(provider.id, {
															extraParams: { ...provider.extraParams, [item.key]: checked },
														})
													}
												/>
											))}
										</div>
									</SettingRow>
									{/* 参考图模式：声明供应商是否接受图片输入；composer 据此放行/拦截附件 */}
									<SettingRow title={<span>{t("config.imagegen.referenceMode")}</span>} description={t("config.imagegen.referenceModeHint")} alignEnd={false}>
										<Select
											value={provider.referenceMode ?? "none"}
											onValueChange={(value) =>
												updateProvider(provider.id, {
													// 枚举收窄：未知值回退为不支持，避免脏配置进存储
													referenceMode: value === "edits" || value === "image-field" ? value : undefined,
												})
											}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="none">{t("config.imagegen.referenceNone")}</SelectItem>
												<SelectItem value="edits">{t("config.imagegen.referenceEdits")}</SelectItem>
												<SelectItem value="image-field">{t("config.imagegen.referenceImageField")}</SelectItem>
											</SelectContent>
										</Select>
									</SettingRow>
									{/* 接口方言：字段名/响应结构与 OpenAI 兼容不一致的供应商（如 SiliconFlow）在此声明；
									       由配置驱动，不按 URL 猜测。 */}
									<SettingRow title={<span>{t("config.imagegen.apiStyle")}</span>} description={t("config.imagegen.apiStyleHint")} alignEnd={false}>
										<Select
											value={provider.apiStyle ?? "openai"}
											onValueChange={(value) =>
												updateProvider(provider.id, {
													// 枚举收窄：未知值回退 openai（旧配置无字段同理）
													apiStyle: value === "openai" || value === "siliconflow" ? value : undefined,
												})
											}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="openai">{t("config.imagegen.apiStyleOpenai")}</SelectItem>
												<SelectItem value="siliconflow">{t("config.imagegen.apiStyleSiliconflow")}</SelectItem>
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow title={<span>{t("config.imagegen.models")}</span>}>
										<div className="flex flex-wrap items-center justify-end gap-1.5">
											<Button type="button" variant="outline" size="sm" disabled={fetchingId === provider.id} onClick={() => void fetchModels(provider)}>
												{fetchingId === provider.id ? t("config.fetchingModels") : t("config.fetchModels")}
											</Button>
											<Button type="button" variant="outline" size="sm" onClick={() => updateProvider(provider.id, { models: [...provider.models, ""] })}>
												{t("config.imagegen.addModel")}
											</Button>
										</div>
									</SettingRow>
									{/* 模型清单本身占满整行（输入框要够宽才能看清 id），因此不套 SettingRow 的 260px 控件列 */}
									<div className="grid gap-1.5 px-1 pb-2">
										{fetchErrorByProvider[provider.id] ? <small className="text-caption leading-relaxed whitespace-pre-line text-danger">{fetchErrorByProvider[provider.id]}</small> : null}
										{fetched.length > 0 ? (
											<div className="mb-1 flex flex-col gap-2 rounded-md border border-border-subtle bg-background p-2.5">
												<FetchedModelCombobox models={fetched} value={selectedIdsByProvider[provider.id] ?? []} existingModelIds={provider.models.filter(Boolean)} onChange={(ids) => setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: ids }))} />
												<div className="flex justify-end border-t border-border-subtle pt-2">
													<Button
														type="button"
														variant="default"
														size="sm"
														disabled={(selectedIdsByProvider[provider.id] ?? []).length === 0}
														onClick={() => {
															const selected = selectedIdsByProvider[provider.id] ?? [];
															updateProvider(provider.id, {
																models: [...provider.models.filter(Boolean), ...selected.filter((id) => !provider.models.includes(id))],
															});
															setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: [] }));
														}}
													>
														{t("config.saveSelectedModels")}
													</Button>
												</div>
											</div>
										) : null}
										{provider.models.map((modelId, index) => (
											<div key={`${provider.id}-model-${index}`} className="flex items-center gap-1.5">
												<Input
													aria-label={t("config.imagegen.modelId")}
													value={modelId}
													placeholder={t("config.imagegen.modelId")}
													onChange={(event) => {
														const models = [...provider.models];
														models[index] = event.target.value;
														updateProvider(provider.id, { models });
													}}
												/>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={t("config.imagegen.removeModel")}
													onClick={() =>
														updateProvider(provider.id, {
															models: provider.models.filter((_, itemIndex) => itemIndex !== index),
														})
													}
												>
													<Trash2 size={14} aria-hidden="true" />
												</Button>
											</div>
										))}
									</div>
								</div>
							</CollapsibleContent>
						</Collapsible>
					);
				})}
				<div className="px-1 py-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							// 新增供应商默认展开，便于立即填写配置；折叠态仅存于本地 UI state，不落盘
							const provider = createProvider();
							patchDraft((current) => ({ ...current, providers: [...current.providers, provider] }));
							setCollapsedIds((current) => {
								const next = new Set(current);
								next.delete(provider.id);
								return next;
							});
						}}
					>
						<Plus size={14} aria-hidden="true" />
						{t("config.imagegen.addProvider")}
					</Button>
				</div>
			</SettingsSection>
		</div>
	);
});
