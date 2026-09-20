// 模型配置导入整页面板：粘贴/选文件 → 解析（加密则输密码）→ 供应商勾选 → 同名冲突逐项处理 → 应用到未保存草稿。
import { useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import type { ProviderConfig, ModelsFile } from "./configTypes";
import {
	applyTransferToDraft,
	decodeModelsTransfer,
	maskSecret,
	planProviderMerge,
	type DecodeModelsTransferResult,
	type ProviderTransferDecision,
	type SideChoice,
} from "./modelsTransfer";

interface ModelsImportPanelProps {
	data: ModelsFile;
	onApply: (next: ModelsFile) => void;
	onBack: () => void;
}

type ImportStep = "input" | "select" | "conflicts" | "done";

const errorText = (error: Extract<DecodeModelsTransferResult, { ok: false }>["error"]): string => {
	if (error === "encrypted-no-password") return t("config.models.transfer.needPassword");
	if (error === "wrong-password") return t("config.models.transfer.wrongPassword");
	if (error === "unsupported-version") return t("config.models.transfer.unsupportedVersion");
	if (error === "wrong-kind") return t("config.models.transfer.wrongKind");
	return t("config.models.transfer.invalid");
};

function displayValue(field: string, value: unknown): string {
	if (value === undefined) return "—";
	if (field === "apiKey") return maskSecret(value) || "—";
	try {
		return JSON.stringify(value) ?? "—";
	} catch {
		return String(value);
	}
}

export function ModelsImportPanel(props: ModelsImportPanelProps) {
	const [step, setStep] = useState<ImportStep>("input");
	const [text, setText] = useState("");
	const [password, setPassword] = useState("");
	const [needsPassword, setNeedsPassword] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [imported, setImported] = useState<Record<string, ProviderConfig> | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [modes, setModes] = useState<Record<string, "overwrite" | "merge">>({});
	const [fieldChoices, setFieldChoices] = useState<Record<string, Record<string, SideChoice>>>({});
	const [modelChoices, setModelChoices] = useState<Record<string, Record<string, SideChoice>>>({});
	const fileInputRef = useRef<HTMLInputElement | null>(null);

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

	const handleParse = async () => {
		const result = await decodeModelsTransfer(text, password.trim() || undefined);
		if (!result.ok) {
			if (result.error === "encrypted-no-password") setNeedsPassword(true);
			setError(errorText(result.error));
			return;
		}
		setImported(result.providers);
		setSelected(new Set(Object.keys(result.providers)));
		setError(null);
		setStep("select");
	};

	const handleFile = async (file: File) => {
		setText(await file.text());
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
				<Button variant="ghost" size="icon-sm" onClick={props.onBack}>
					<ArrowLeft size={16} />
				</Button>
				<span>{t("config.models.transfer.importTitle")}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{step === "input" && (
					<div className="space-y-3">
						<Label htmlFor="models-import-text">{t("config.models.transfer.pasteLabel")}</Label>
						<Input id="models-import-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("config.models.transfer.pastePlaceholder")} />
						<Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
							{t("config.models.transfer.pickFile")}
						</Button>
						<input
							ref={fileInputRef}
							type="file"
							accept=".txt"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) void handleFile(file);
							}}
						/>
						{needsPassword && (
							<div className="space-y-1">
								<Label htmlFor="models-import-password">{t("config.models.transfer.password")}</Label>
								<Input id="models-import-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
							</div>
						)}
						{error && <p className="text-sm text-danger">{error}</p>}
					</div>
				)}
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
								{props.data.providers[id] ? (
									<span className="text-xs text-warning">{t("config.models.transfer.conflictWithLocal")}</span>
								) : (
									<span className="text-xs text-info">{t("config.models.transfer.newProvider")}</span>
								)}
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
															<Button
																variant="outline"
																size="sm"
																onClick={() => setFieldChoices(toggleChoice(fieldChoices, id, d.field))}
															>
																{(fieldChoices[id]?.[d.field] ?? "local") === "local"
																	? t("config.models.transfer.local")
																	: t("config.models.transfer.imported")}
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
																<span className="w-44 shrink-0 truncate">{d.modelId} · {d.field}</span>
																<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.local)}</span>
																<Button variant="outline" size="sm" onClick={() => setModelChoices(toggleChoice(modelChoices, id, key))}>
																	{(modelChoices[id]?.[key] ?? "local") === "local"
																		? t("config.models.transfer.local")
																		: t("config.models.transfer.imported")}
																</Button>
																<span className="min-w-0 flex-1 truncate">{displayValue(d.field, d.imported)}</span>
															</div>
														);
													})}
												</div>
											)}
											{plan.newModels.length > 0 && (
												<p className="text-xs text-text-tertiary">
													{t("config.models.transfer.newModels", { ids: plan.newModels.map((n) => n.modelId).join(", ") })}
												</p>
											)}
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
				{step === "input" && (
					<Button size="sm" onClick={handleParse} disabled={!text.trim()}>
						{t("config.models.transfer.parse")}
					</Button>
				)}
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
		</div>
	);
}