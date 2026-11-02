// 模型配置导入整页面板：双源入口（粘贴/选文件 · 本机工具扫描）→ 供应商勾选 → 同名冲突逐项处理 → 应用到未保存草稿。
// 外壳只管 source 选项卡与 step 机；两个入口组件在入口步常驻挂载（hidden 切换）以保留粘贴文本与扫描结果（ADR 0024）。
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { t } from "../i18n";
import type { ProviderConfig, ModelsFile } from "./configTypes";
import { applyTransferToDraft, maskSecret, planProviderMerge, type ProviderTransferDecision, type SideChoice } from "./modelsTransfer";
import { ModelsImportPasteStep } from "./ModelsImportPasteStep";
import { ModelsImportDiscoverStep } from "./ModelsImportDiscoverStep";

interface ModelsImportPanelProps {
	data: ModelsFile;
	onApply: (next: ModelsFile) => void;
	onBack: () => void;
}

type ImportStep = "entry" | "select" | "conflicts" | "done";
type ImportSource = "paste" | "discover";

function displayValue(field: string, value: unknown): string {
	if (value === undefined) return "—";
	if (field === "apiKey") return maskSecret(value) || "—";
	try {
		return JSON.stringify(value) ?? "—";
	} catch {
		return String(value);
	}
}

/** 导入面板外壳：入口双选项卡 + 共享的勾选/冲突/应用流程；返回箭头按步退回（select→入口，conflicts→select）。 */
export function ModelsImportPanel(props: ModelsImportPanelProps) {
	const [step, setStep] = useState<ImportStep>("entry");
	const [source, setSource] = useState<ImportSource>("paste");
	const [error, setError] = useState<string | null>(null);
	const [imported, setImported] = useState<Record<string, ProviderConfig> | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [modes, setModes] = useState<Record<string, "overwrite" | "merge">>({});
	const [fieldChoices, setFieldChoices] = useState<Record<string, Record<string, SideChoice>>>({});
	const [modelChoices, setModelChoices] = useState<Record<string, Record<string, SideChoice>>>({});

	// 勾选中且与本地同名的供应商 → 冲突处理视图
	const conflictIds = useMemo(() => {
		if (!imported) return [];
		return [...selected].filter((id) => Boolean(props.data.providers[id]));
	}, [imported, selected, props.data.providers]);
	const plans = useMemo(() => {
		const out: Record<string, ReturnType<typeof planProviderMerge>> = {};
		for (const id of conflictIds) {
			const local = props.data.providers[id];
			const incoming = imported?.[id];
			if (local && incoming) out[id] = planProviderMerge(local, incoming);
		}
		return out;
	}, [conflictIds, imported, props.data.providers]);

	/** 两个入口共用：拿到供应商草稿即进入勾选步（入口各自完成解析/拉 key）。 */
	const handleImported = (providers: Record<string, ProviderConfig>) => {
		setImported(providers);
		setSelected(new Set(Object.keys(providers)));
		setError(null);
		setStep("select");
	};

	// 返回箭头按步退回：入口/完成 → 退出面板；勾选 → 回入口（选项卡重现）；冲突 → 回勾选。
	const handleBack = () => {
		if (step === "conflicts") {
			setStep("select");
			return;
		}
		if (step === "select") {
			setError(null);
			setStep("entry");
			return;
		}
		props.onBack();
	};

	const goConflicts = () => {
		if (selected.size === 0) {
			setError(t("config.models.transfer.noProvidersSelected"));
			return;
		}
		const nextModes: Record<string, "overwrite" | "merge"> = {};
		for (const id of selected) if (props.data.providers[id]) nextModes[id] = "merge"; // 默认合并（设计决策 #4）
		setModes(nextModes);
		setStep("conflicts");
	};

	const setAllChoices = (choice: SideChoice) => {
		const nextField: Record<string, Record<string, SideChoice>> = {};
		const nextModel: Record<string, Record<string, SideChoice>> = {};
		for (const id of conflictIds) {
			if (modes[id] !== "merge") continue;
			const plan = plans[id];
			nextField[id] = {};
			for (const d of plan.providerFields) nextField[id][d.field] = choice;
			nextModel[id] = {};
			for (const d of plan.modelFieldDiffs) nextModel[id][`${d.modelId}::${d.field}`] = choice;
		}
		setFieldChoices(nextField);
		setModelChoices(nextModel);
	};

	const toggleChoice = (store: Record<string, Record<string, SideChoice>>, id: string, key: string): Record<string, Record<string, SideChoice>> => {
		const current = { ...(store[id] ?? {}) };
		current[key] = current[key] === "imported" ? "local" : "imported";
		return { ...store, [id]: current };
	};

	const handleApply = () => {
		if (!imported) return;
		const decisions: Record<string, ProviderTransferDecision> = {};
		for (const id of selected) {
			if (!props.data.providers[id]) {
				decisions[id] = "overwrite"; // 本地不存在 → decision 即整份新增
				continue;
			}
			if (modes[id] === "overwrite") decisions[id] = "overwrite";
			else decisions[id] = { merge: { providerFieldChoices: fieldChoices[id] ?? {}, modelChoices: modelChoices[id] ?? {} } };
		}
		props.onApply(applyTransferToDraft(props.data, imported, decisions));
		setStep("done");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button variant="ghost" size="icon-sm" onClick={handleBack}>
					<ArrowLeft size={16} />
				</Button>
				<span>{t("config.models.transfer.importTitle")}</span>
			</div>
			{/* 选项卡只在入口步可见：进入勾选/冲突流程后隐藏，防中途换源静默丢勾选（Q5） */}
			{step === "entry" && (
				<div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-4 py-2">
					<Button variant={source === "paste" ? "default" : "ghost"} size="sm" onClick={() => setSource("paste")}>
						{t("config.models.transfer.tabPaste")}
					</Button>
					<Button variant={source === "discover" ? "default" : "ghost"} size="sm" onClick={() => setSource("discover")}>
						{t("config.models.transfer.tabDiscover")}
					</Button>
				</div>
			)}
			{/* 入口步两个入口常驻挂载、hidden 切换：粘贴文本与扫描结果在选项卡/流程往返间保留（Q3） */}
			<div className={step === "entry" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
				<div className={source === "paste" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
					<ModelsImportPasteStep onImported={handleImported} />
				</div>
				<div className={source === "discover" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
					<ModelsImportDiscoverStep active={step === "entry" && source === "discover"} data={props.data} onImported={handleImported} />
				</div>
			</div>
			{step !== "entry" && (
				<>
					{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
						{step === "select" && imported && (
							<div className="space-y-2">
								<p className="text-sm text-text-tertiary">{t("config.models.transfer.selectProviders")}</p>
								{Object.entries(imported).map(([id, provider]) => (
									<label key={id} className="flex items-center gap-2 py-1">
										<Checkbox
											checked={selected.has(id)}
											onCheckedChange={() => {
												const next = new Set(selected);
												if (next.has(id)) next.delete(id);
												else next.add(id);
												setSelected(next);
											}}
										/>
										<span>{id}</span>
										<span className="text-xs text-text-tertiary">{provider.baseUrl ?? provider.api ?? ""}</span>
										{props.data.providers[id] ? <span className="text-xs text-warning">{t("config.models.transfer.conflictWithLocal")}</span> : <span className="text-xs text-info">{t("config.models.transfer.newProvider")}</span>}
									</label>
								))}
								{error && <p className="text-sm text-danger">{error}</p>}
							</div>
						)}
						{step === "conflicts" && (
							<div className="space-y-4">
								<div className="flex flex-wrap gap-2">
									<Button variant="outline" size="sm" onClick={() => setModes(Object.fromEntries(conflictIds.map((id) => [id, "overwrite"])))}>
										{t("config.models.transfer.overwriteAll")}
									</Button>
									<Button variant="outline" size="sm" onClick={() => setModes(Object.fromEntries(conflictIds.map((id) => [id, "merge"])))}>
										{t("config.models.transfer.mergeAll")}
									</Button>
									<Button variant="outline" size="sm" onClick={() => setAllChoices("local")}>
										{t("config.models.transfer.keepAllLocal")}
									</Button>
									<Button variant="outline" size="sm" onClick={() => setAllChoices("imported")}>
										{t("config.models.transfer.adoptAllImported")}
									</Button>
								</div>
								{conflictIds.map((id) => {
									const plan = plans[id];
									const mode = modes[id] ?? "merge";
									return (
										<div key={id} className="rounded-lg border border-border-subtle">
											<div className="flex items-center justify-between px-3 py-2">
												<span className="font-medium">{id}</span>
												<div className="flex gap-2">
													<Button variant={mode === "overwrite" ? "default" : "outline"} size="sm" onClick={() => setModes({ ...modes, [id]: "overwrite" })}>
														{t("config.models.transfer.overwrite")}
													</Button>
													<Button variant={mode === "merge" ? "default" : "outline"} size="sm" onClick={() => setModes({ ...modes, [id]: "merge" })}>
														{t("config.models.transfer.merge")}
													</Button>
												</div>
											</div>
											{mode === "merge" && (
												<div className="space-y-3 border-t border-border-subtle px-3 py-2 text-sm">
													{plan.providerFields.length > 0 && (
														<div>
															<p className="mb-1 text-xs text-text-tertiary">{t("config.models.transfer.providerFields")}</p>
															{plan.providerFields.map((d) => (
																<div key={d.field} className="flex items-center justify-between gap-2 py-1">
																	<span className="w-32 shrink-0">{d.field}</span>
																	<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.local)}</span>
																	<Button variant="outline" size="sm" onClick={() => setFieldChoices(toggleChoice(fieldChoices, id, d.field))}>
																		{(fieldChoices[id]?.[d.field] ?? "local") === "local" ? t("config.models.transfer.local") : t("config.models.transfer.imported")}
																	</Button>
																	<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.imported)}</span>
																</div>
															))}
														</div>
													)}
													{plan.modelFieldDiffs.length > 0 && (
														<div>
															<p className="mb-1 text-xs text-text-tertiary">{t("config.models.transfer.modelFields")}</p>
															{plan.modelFieldDiffs.map((d) => {
																const key = `${d.modelId}::${d.field}`;
																return (
																	<div key={key} className="flex items-center justify-between gap-2 py-1">
																		<span className="w-44 shrink-0 truncate">
																			{d.modelId} · {d.field}
																		</span>
																		<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.local)}</span>
																		<Button variant="outline" size="sm" onClick={() => setModelChoices(toggleChoice(modelChoices, id, key))}>
																			{(modelChoices[id]?.[key] ?? "local") === "local" ? t("config.models.transfer.local") : t("config.models.transfer.imported")}
																		</Button>
																		<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.imported)}</span>
																	</div>
																);
															})}
														</div>
													)}
													{plan.newModels.length > 0 && <p className="text-xs text-text-tertiary">{t("config.models.transfer.newModels", { ids: plan.newModels.map((n) => n.modelId).join(", ") })}</p>}
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}
						{step === "done" && <p className="text-sm">{t("config.models.transfer.applied")}</p>}
					</div>
					<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
						{step === "select" && (
							<Button size="sm" onClick={goConflicts}>
								{t("config.models.transfer.next")}
							</Button>
						)}
						{step === "conflicts" && (
							<Button size="sm" onClick={handleApply}>
								{t("config.models.transfer.apply")}
							</Button>
						)}
						{step === "done" && (
							<Button size="sm" onClick={props.onBack}>
								{t("config.models.transfer.done")}
							</Button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
