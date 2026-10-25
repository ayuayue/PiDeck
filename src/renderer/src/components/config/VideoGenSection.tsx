/**
 * 设置 → 生视频。
 * 独立供应商，不属于 pi/dsh 任一后端，不读写 pi models.json。视频是「提交-轮询-下载」
 * 异步协议且各家字段不一致，因此供应商必须显式选协议族（protocol），提交体/查询体/
 * 产物解析全部按它分发；模型 id 只能手填（视频网关普遍没有 /models 列表接口）。
 * 保存走设置弹窗统一按钮（ref.save + onDirtyChange，与生图同一套脏标记流程）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { videoGenConfigAtom } from "../../atoms";
import { Loader2, ChevronDown, Plus, Trash2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { EMPTY_VIDEO_GEN_CONFIG, VIDEO_GEN_PROTOCOLS, VIDEO_GEN_PROTOCOL_LABELS, VIDEO_GEN_DURATION_PRESETS, VIDEO_GEN_RESOLUTION_PRESETS, VIDEO_GEN_RATIO_PRESETS, sanitizeVideoGenConfig, type VideoGenConfigFile, type VideoGenProtocolFamily, type VideoGenProviderConfig } from "../../../../shared/videoGenConfig";
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

export type VideoGenSectionHandle = {
	save: () => Promise<boolean>;
};

type VideoGenSectionProps = {
	onDirtyChange?: (dirty: boolean) => void;
};

function newProviderId(): string {
	return `vg-${crypto.randomUUID().slice(0, 8)}`;
}

function createProvider(): VideoGenProviderConfig {
	return {
		id: newProviderId(),
		name: "",
		baseUrl: "",
		apiKey: "",
		// 默认 minimax-v2：唯一实测过的协议族，回落行为最可预期（与 sanitize 同口径）
		protocol: "minimax-v2",
		models: [],
	};
}

/** 参数预设下拉的选项来源：按协议族取分辨率/画幅，时长各家通用。 */
function presetOptions(protocol: VideoGenProtocolFamily, kind: "resolution" | "ratio"): string[] {
	return kind === "resolution" ? VIDEO_GEN_RESOLUTION_PRESETS[protocol] : VIDEO_GEN_RATIO_PRESETS[protocol];
}

export const VideoGenSection = forwardRef<VideoGenSectionHandle, VideoGenSectionProps>(function VideoGenSection({ onDirtyChange }, ref) {
	const setVideoGenConfig = useSetAtom(videoGenConfigAtom);
	const [draft, setDraft] = useState<VideoGenConfigFile>(EMPTY_VIDEO_GEN_CONFIG);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 供应商折叠态（仅 UI 状态，不进配置文件）：默认只展开第一个，其余收起，避免多供应商平铺撑爆页面
	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
	/**
	 * 磁盘上真正存着的密钥（providerId → apiKey），用来区分摘要里的「已保存」与「当前」。
	 * 只在载入与保存成功两处更新，不参与渲染态推导，故用 ref。
	 */
	const savedKeysRef = useRef<Record<string, string>>({});

	const rememberSavedKeys = useCallback((config: VideoGenConfigFile) => {
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

	const expandAll = useCallback(() => {
		setCollapsedIds(new Set());
	}, []);

	const collapseAll = useCallback(() => {
		setCollapsedIds(new Set(draft.providers.map((provider) => provider.id)));
	}, [draft.providers]);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.videogen
			.getConfig()
			.then((loaded) => {
				if (cancelled) return;
				setDraft(loaded);
				rememberSavedKeys(loaded);
				// 按"列表"形态初始化：仅保留第一个展开，其余先收起
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

	const patchDraft = useCallback((updater: (current: VideoGenConfigFile) => VideoGenConfigFile) => {
		setDraft(updater);
		setDirty(true);
	}, []);

	const updateProvider = useCallback(
		(id: string, patch: Partial<VideoGenProviderConfig>) => {
			patchDraft((current) => ({
				...current,
				providers: current.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)),
			}));
		},
		[patchDraft],
	);

	/** 更新某供应商 defaults 参数；undefined 表示清空（用上游默认值）。 */
	const updateDefault = useCallback(
		(id: string, key: "resolution" | "duration" | "ratio", value: string | undefined) => {
			patchDraft((current) => ({
				...current,
				providers: current.providers.map((provider) => {
					if (provider.id !== id) return provider;
					const defaults = { ...(provider.defaults ?? {}) };
					if (value === undefined || value === "") {
						delete defaults[key];
					} else {
						defaults[key] = value;
					}
					return { ...provider, defaults };
				}),
			}));
		},
		[patchDraft],
	);

	const handleSave = useCallback(async (): Promise<boolean> => {
		if (saving) return false;
		setSaving(true);
		setError(null);
		try {
			// 保存前过一遍白名单清洗：渲染层草稿可能含超长/非法枚举值，落盘前统一收紧
			const result = await desktopApi.videogen.saveConfig(sanitizeVideoGenConfig(draft));
			if (!result.ok) {
				setError(result.error ?? t("config.videogen.saveFailed"));
				return false;
			}
			setDraft(result.config);
			rememberSavedKeys(result.config);
			setDirty(false);
			setVideoGenConfig(result.config);
			showNotice(t("config.videogen.saved"), 2500);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, saving, setVideoGenConfig, rememberSavedKeys]);

	useImperativeHandle(ref, () => ({ save: () => handleSave() }), [handleSave]);

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
				title={t("config.videogen.section")}
				description={t("config.videogen.sectionDesc")}
				/* 全部展开/收起：多供应商时快速切换列表形态 */
				action={
					draft.providers.length > 0 ? (
						<Button type="button" variant="ghost" size="sm" className="h-7" onClick={allCollapsed ? expandAll : collapseAll}>
							{allCollapsed ? t("config.videogen.expandAll") : t("config.videogen.collapseAll")}
						</Button>
					) : undefined
				}
			>
				{error ? (
					<div className="px-1 pt-2">
						<small className="text-caption leading-relaxed text-danger">{error}</small>
					</div>
				) : null}
				{draft.providers.length === 0 ? <div className="px-1 py-2 text-control text-muted-foreground">{t("config.videogen.empty")}</div> : null}
				{draft.providers.map((provider) => {
					const collapsed = collapsedIds.has(provider.id);
					const modelCount = provider.models.filter(Boolean).length;
					// 密钥摘要：掩码态也要能核对「存的是哪一格、有没有被截断/多个空格」，措辞区分磁盘上的「已保存」与草稿里的「当前」
					const apiKeyHint = secretHint(provider.apiKey);
					const apiKeyHintText = apiKeyHint ? t(provider.apiKey === (savedKeysRef.current[provider.id] ?? "") ? "config.videogen.apiKeySavedSummary" : "config.videogen.apiKeyCurrentSummary", apiKeyHint) : null;
					return (
						<Collapsible key={provider.id} open={!collapsed} onOpenChange={() => toggleCollapsed(provider.id)} className="border-t border-border-subtle/60 first:border-t-0">
							{/* 供应商标题行：折叠时名称后附「接口地址 · 模型数」摘要，收起后仍可一眼辨认。
							    删除按钮与 trigger 平级（button 嵌套 button 非法）。 */}
							<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1">
								<CollapsibleTrigger asChild>
									<button type="button" className="flex min-w-0 items-center gap-2 py-2 text-left" title={collapsed ? t("common.expand") : t("common.collapse")}>
										<ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`} />
										<span className="shrink-0 truncate text-control font-medium text-foreground">{provider.name.trim() || t("config.videogen.unnamedProvider")}</span>
										{collapsed ? (
											<small className="min-w-0 truncate text-caption text-muted-foreground">
												{provider.baseUrl.trim() ? `${provider.baseUrl.trim()} · ` : ""}
												{t("config.videogen.modelsCount", { count: modelCount })}
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
										title={t("config.videogen.removeProvider")}
										aria-label={t("config.videogen.removeProvider")}
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
									<SettingRow title={<span>{t("config.videogen.providerName")}</span>} stacked>
										<Input aria-label={t("config.videogen.providerName")} value={provider.name} placeholder={t("config.videogen.providerNamePlaceholder")} onChange={(event) => updateProvider(provider.id, { name: event.target.value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.videogen.baseUrl")}</span>} stacked>
										<Input aria-label={t("config.videogen.baseUrl")} value={provider.baseUrl} placeholder="https://tokendance.space" onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.videogen.apiKey")}</span>} stacked>
										<SecretValueInput label={t("config.videogen.apiKey")} value={provider.apiKey} hintText={apiKeyHintText} onChange={(value) => updateProvider(provider.id, { apiKey: value })} />
									</SettingRow>
									{/* 协议族：提交/查询/下载的请求形态由它分发，不按 URL 猜测（各家网关路径无规律）。 */}
									<SettingRow title={<span>{t("config.videogen.protocol")}</span>} description={t("config.videogen.protocolHint")} alignEnd={false}>
										<Select
											value={provider.protocol}
											onValueChange={(value) => {
												// 枚举收窄：未知值回退默认协议，避免脏配置进存储
												const next = (VIDEO_GEN_PROTOCOLS as readonly string[]).includes(value) ? (value as VideoGenProtocolFamily) : "minimax-v2";
												updateProvider(provider.id, { protocol: next });
											}}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{VIDEO_GEN_PROTOCOLS.map((protocol) => (
													<SelectItem key={protocol} value={protocol}>
														{VIDEO_GEN_PROTOCOL_LABELS[protocol]}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SettingRow>
									{/* 默认参数：composer 切到该供应商时预填；预设按协议族给，也允许手填自定义值 */}
									<SettingRow title={<span>{t("config.videogen.defaultsResolution")}</span>} stacked>
										<div className="flex flex-wrap gap-1.5">
											{presetOptions(provider.protocol, "resolution").map((preset) => (
												<Button key={preset} type="button" variant={provider.defaults?.resolution === preset ? "default" : "outline"} size="sm" className="h-7" onClick={() => updateDefault(provider.id, "resolution", provider.defaults?.resolution === preset ? undefined : preset)}>
													{preset}
												</Button>
											))}
										</div>
									</SettingRow>
									<SettingRow title={<span>{t("config.videogen.defaultsDuration")}</span>} stacked>
										<div className="flex flex-wrap gap-1.5">
											{VIDEO_GEN_DURATION_PRESETS.map((preset) => (
												<Button key={preset} type="button" variant={provider.defaults?.duration === preset ? "default" : "outline"} size="sm" className="h-7" onClick={() => updateDefault(provider.id, "duration", provider.defaults?.duration === preset ? undefined : preset)}>
													{preset}s
												</Button>
											))}
										</div>
									</SettingRow>
									<SettingRow title={<span>{t("config.videogen.defaultsRatio")}</span>} stacked>
										<div className="flex flex-wrap gap-1.5">
											{presetOptions(provider.protocol, "ratio").map((preset) => (
												<Button key={preset} type="button" variant={provider.defaults?.ratio === preset ? "default" : "outline"} size="sm" className="h-7" onClick={() => updateDefault(provider.id, "ratio", provider.defaults?.ratio === preset ? undefined : preset)}>
													{preset}
												</Button>
											))}
										</div>
									</SettingRow>
									{/* 单价备注：自由文本，只在提交确认框展示；各家计费口径不一，PiDeck 不做真实核算 */}
									<SettingRow title={<span>{t("config.videogen.priceNote")}</span>} description={t("config.videogen.priceNoteHint")} stacked>
										<Input aria-label={t("config.videogen.priceNote")} value={provider.priceNote ?? ""} placeholder={t("config.videogen.priceNotePlaceholder")} onChange={(event) => updateProvider(provider.id, { priceNote: event.target.value })} />
									</SettingRow>
									<SettingRow title={<span>{t("config.videogen.models")}</span>}>
										<div className="flex flex-wrap items-center justify-end gap-1.5">
											{/* 视频网关普遍没有 /models 列表接口，只提供手填（与生图差异点） */}
											<Button type="button" variant="outline" size="sm" onClick={() => updateProvider(provider.id, { models: [...provider.models, ""] })}>
												{t("config.videogen.addModel")}
											</Button>
										</div>
									</SettingRow>
									{/* 模型清单本身占满整行（输入框要够宽才能看清 id），因此不套 SettingRow 的 260px 控件列 */}
									<div className="grid gap-1.5 px-1 pb-2">
										{provider.models.map((modelId, index) => (
											<div key={`${provider.id}-model-${index}`} className="flex items-center gap-1.5">
												<Input
													aria-label={t("config.videogen.modelId")}
													value={modelId}
													placeholder={t("config.videogen.modelId")}
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
													aria-label={t("config.videogen.removeModel")}
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
						{t("config.videogen.addProvider")}
					</Button>
				</div>
				{/* 提交确认开关：视频按秒计费且单价远高于生图，默认强制确认；关掉后点发送直接提交 */}
				<div className="border-t border-border-subtle/60 pt-1">
					<SettingSwitchRow title={t("config.videogen.costConfirm")} description={t("config.videogen.costConfirmHint")} checked={draft.costConfirm} onChange={(checked) => patchDraft((current) => ({ ...current, costConfirm: checked }))} />
				</div>
			</SettingsSection>
		</div>
	);
});
