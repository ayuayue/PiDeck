import { memo, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { DEFAULT_PET_SCALE, type AppSettings, type PetManifest } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { openInSystemBrowser } from "../../../utils/openExternal";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../../pet/PetSpriteSheet";

type PetTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	/** 字段级脏检查（与其它 tab 同一 isDirty 回调），驱动标题旁黄点。 */
	isDirty?: (field: keyof AppSettings) => boolean;
	/** 壳层「取消」递增；本 tab 借此重置预览模式等局部状态 */
	resetKey: number;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「桌面宠物」tab：开关/巡逻/缩放 + 宠物选择与动画预览。
 * 独立组件 + memo：宠物列表与预览模式等局部状态自持，只有进入本 tab 才加载。
 */
export const PetTab = memo(function PetTab(props: PetTabProps) {
	const { draft, updateDraft } = props;
	const isDirty = props.isDirty ?? (() => false);
	// 宠物包列表（进入本 tab 才拉取）
	const [petOptions, setPetOptions] = useState<SelectOption[]>([]);
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => {
				setPetList(pets);
				setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName })));
			})
			.catch(() => undefined);
	}, []);
	// 预览模式：只属于本 tab 生命周期；卸载时必须让真实 Agent 状态重新接管宠物。
	const [petPreviewMode, setPetPreviewMode] = useState("__auto");
	useEffect(
		() => () => {
			void window.piDesktop.pet.setPreviewMode("");
		},
		[],
	);
	// 壳层「取消」：预览模式回退，让真实状态重新接管
	useEffect(() => {
		setPetPreviewMode("__auto");
		void window.piDesktop.pet.setPreviewMode("");
	}, [props.resetKey]);

	const previewModeOptions: SelectOption[] = [
		{ value: "__auto", label: t("settings.pet.previewAuto") },
		{ value: "idle", label: "idle (row 0)" },
		{ value: "running", label: "running (row 7)" },
		{ value: "failed", label: "failed (row 5)" },
		{ value: "waiting", label: "waiting (row 6)" },
		{ value: "waving", label: "waving (row 3)" },
		{ value: "running-right", label: "running-right (row 1)" },
		{ value: "running-left", label: "running-left (row 2)" },
		{ value: "jumping", label: "jumping (row 4)" },
		{ value: "review", label: "review (row 8)" },
	];

	return (
		<>
			<SettingsSection title={t("settings.pet.title")} description={t("settings.pet.sectionDesc")}>
				<SettingSwitchRow title={t("settings.pet.enable")} description={t("settings.pet.enableDesc")} checked={draft.petEnabled} dirty={isDirty("petEnabled")} onChange={(value) => updateDraft({ petEnabled: value })} />
				<SettingSwitchRow title={t("settings.pet.alwaysOnTop")} description={t("settings.pet.alwaysOnTopDesc")} checked={draft.petAlwaysOnTop} dirty={isDirty("petAlwaysOnTop")} onChange={(value) => updateDraft({ petAlwaysOnTop: value })} />
				<SettingSwitchRow title={t("settings.pet.patrol")} description={t("settings.pet.patrolDesc")} checked={draft.petPatrolEnabled ?? true} dirty={isDirty("petPatrolEnabled")} onChange={(value) => updateDraft({ petPatrolEnabled: value })} />
				<SettingRow
					title={
						<span className="inline-flex items-center gap-1.5">
							<DirtyMarker dirty={isDirty("petPatrolPauseMin")} label={t("settings.pet.patrolPause")} />
							{t("settings.pet.patrolPause")}
						</span>
					}
					description={t("settings.pet.patrolPauseDesc")}
				>
					<div className="flex w-full items-center gap-3">
						<input type="range" min="1" max="30" step="1" value={draft.petPatrolPauseMin ?? 5} onChange={(event) => updateDraft({ petPatrolPauseMin: parseInt(event.target.value) })} className="min-w-0 flex-1 accent-[var(--color-accent)]" aria-label={t("settings.pet.patrolPause")} />
						<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">{draft.petPatrolPauseMin ?? 5} min</span>
					</div>
				</SettingRow>
				<SettingRow
					title={
						<span className="inline-flex items-center gap-1.5">
							<DirtyMarker dirty={isDirty("petScale")} label={t("settings.pet.scale")} />
							{t("settings.pet.scale")}
						</span>
					}
					description={t("settings.pet.scaleDesc")}
				>
					<div className="flex w-full items-center gap-3">
						<input type="range" min="0.3" max="2.0" step="0.05" value={draft.petScale ?? DEFAULT_PET_SCALE} onChange={(event) => updateDraft({ petScale: parseFloat(event.target.value) })} className="min-w-0 flex-1 accent-[var(--color-accent)]" aria-label={t("settings.pet.scale")} />
						<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">{((draft.petScale ?? DEFAULT_PET_SCALE) * 100).toFixed(0)}%</span>
					</div>
				</SettingRow>
			</SettingsSection>
			{/* 选择宠物（单行分区：行标题即一级标题，内容行入淡色框） */}
			<SettingBox>
				<SettingRow
					level={1}
					title={
						<span className="inline-flex items-center gap-1.5">
							<DirtyMarker dirty={isDirty("petId")} label={t("settings.pet.choose")} />
							{t("settings.pet.choose")}
						</span>
					}
					alignEnd={false}
				>
					<Select
						value={draft.petId}
						onValueChange={(value) => {
							setPetPreviewMode("__auto");
							void window.piDesktop.pet.setPreviewMode("");
							updateDraft({ petId: value });
						}}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{petOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<small className="setting-status">{t("settings.pet.petdexHint")}</small>
				<a
					href="https://petdex.dev/"
					className="config-link-like inline-flex items-center gap-1"
					onClick={(event) => {
						event.preventDefault();
						openInSystemBrowser("https://petdex.dev/");
					}}
				>
					<ExternalLink size={12} aria-hidden="true" />
					{t("settings.pet.petdexSite")}
				</a>
				{(() => {
					const selected = petList.find((pet) => pet.id === draft.petId);
					return (
						<>
							{selected && (
								<div className="pet-chooser-preview-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: 8 }}>
									<PetChooserPreview pet={selected} mode={petPreviewMode} />
									<div style={{ minWidth: 0, flex: 1 }}>
										<strong style={{ display: "block", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }}>{selected.displayName}</strong>
										{selected.description && (
											<small className="setting-status" style={{ display: "block", marginTop: 2 }}>
												{selected.description}
											</small>
										)}
									</div>
								</div>
							)}
						</>
					);
				})()}
			</SettingBox>
			<SettingsSection id="settings-section-pet-preview" title={t("settings.pet.preview")} description={t("settings.pet.previewDesc")}>
				<SettingRow title={<span>{t("settings.pet.previewMode")}</span>} alignEnd={false}>
					<Select
						value={petPreviewMode}
						onValueChange={(value) => {
							setPetPreviewMode(value);
							void window.piDesktop.pet.setPreviewMode(value === "__auto" ? "" : value);
						}}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{previewModeOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<div className="flex justify-end gap-2 px-0.5 py-1.5">
					<Button size="sm" variant="destructive" onClick={() => void window.piDesktop.pet.testNotify("error")}>
						{t("settings.pet.testError")}
					</Button>
					<Button variant="secondary" size="sm" onClick={() => void window.piDesktop.pet.testNotify("done")}>
						{t("settings.pet.testDone")}
					</Button>
				</div>
			</SettingsSection>
		</>
	);
});

/** 宠物雪碧图动画预览：canvas 按帧绘制，仅在本 tab 挂载期间运行。 */
function PetChooserPreview(props: { pet?: PetManifest; mode?: string }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const pet = props.pet;
		if (!pet || !pet.spritesheetUrl || !canvas) {
			const ctx = canvas?.getContext("2d");
			if (canvas) ctx?.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}

		const mode = props.mode && props.mode !== "__auto" ? props.mode : "idle";
		const row = MODE_ROW[mode] ?? 0;
		const frameCount = MODE_FRAMES[mode] ?? 6;
		const img = new Image();
		img.src = pet.spritesheetUrl;
		let disposed = false;

		const start = () => {
			if (disposed) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const dpr = window.devicePixelRatio || 1;
			const cssW = canvas.clientWidth || 120;
			const cssH = canvas.clientHeight || 130;
			canvas.width = Math.round(cssW * dpr);
			canvas.height = Math.round(cssH * dpr);
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";
			/* 与 PetOverlay 同一产品决策：prefers-reduced-motion 不完全冻结，降到 1/4 帧率近定格；
			 预览的功能就是评估桌宠形态，静态帧会失真，但4倍拉长帧间隔仍尊重系统偏好。 */
			const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			const frameMs = reducedMotion ? 140 * 4 : 140;
			const startedAt = performance.now();
			const draw = (now: number) => {
				if (disposed) return;
				const frame = Math.floor((now - startedAt) / frameMs) % frameCount;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(img, (frame % GRID_COLS) * CELL_W, row * CELL_H, CELL_W, CELL_H, 0, 0, canvas.width, canvas.height);
				rafRef.current = requestAnimationFrame(draw);
			};
			rafRef.current = requestAnimationFrame(draw);
		};

		img.onload = start;
		imgRef.current = img;
		return () => {
			disposed = true;
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			imgRef.current = null;
		};
	}, [props.pet, props.mode]);

	return (
		<div className="pet-chooser-preview">
			<canvas ref={canvasRef} width={CELL_W} height={CELL_H} aria-hidden="true" />
		</div>
	);
}
