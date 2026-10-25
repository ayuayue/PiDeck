import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { shouldShowUpdateDotHint } from "../../utils/updateDotHint";
import { Button } from "../ui-shadcn/button";

/** 气泡自动消失时长（ms）：非模态提示，不能让用户被迫处理。 */
const HINT_AUTO_DISMISS_MS = 10_000;

type UpdateDotHintProps = {
	/** 当前是否有任一可提示更新（圆点亮）。 */
	hasPendingUpdate: boolean;
	/** 打开设置页（气泡「查看更新」动作）。 */
	onOpenSettings: () => void;
};

/**
 * 更新圆点首次解释气泡（Material feature discovery 模式）：
 * 圆点第一次出现时在旁边弹一次「这是更新提醒」的说明，用户看过/点过/超时后
 * 永久标记已解释（updateDotHintSeen），不再打扰；进过设置页也会被标记（见
 * SettingsFeatureRoot）。与 toast 通知互补：toast 说「有更新」，气泡解释「这个点是什么」。
 *
 * 锚定契约（回归曾现 bug）：气泡必须左缘锚定并铺满 dock 行（left-0 right-0），
 * 箭头指向最左侧的设置按钮。此前右对齐（right-0）到 32px 的按钮 + 固定 w-56，
 * 224px 宽在 208px 侧栏下左溢约 175px，被 aside 的 overflow-hidden 裁剪成
 * 窗口左缘一条竖条——表现为「更新提示挤在左侧、一半在屏外」。
 */
export function UpdateDotHint(props: UpdateDotHintProps) {
	const { hasPendingUpdate, onOpenSettings } = props;
	const [visible, setVisible] = useState(false);
	// 上一帧的 pending 状态（上升沿判定用）。挂载后始终同步 hasPendingUpdate，
	// 因此 seen 拉取完成时读它 = 读「当前是否有更新」。
	const prevPendingRef = useRef(false);
	// null = 尚未从设置拉取「已看过」标记；拉取完成前不显示，避免老用户闪气泡。
	const seenRef = useRef<boolean | null>(null);
	// 本会话是否已显示过一次（seen 拉取完成后统一判定，避免与上升沿路径重复触发）。
	const shownOnceRef = useRef(false);
	const timerRef = useRef<number | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const close = useCallback(() => {
		clearTimer();
		setVisible(false);
		// 任意关闭路径（点按钮/点外部/超时）都视为「已看过」：持久化标记避免下次再弹。
		if (seenRef.current === true) return;
		seenRef.current = true;
		void desktopApi.settings.update({ updateDotHintSeen: true }).catch(() => undefined);
	}, [clearTimer]);

	const showWithTimer = useCallback(() => {
		clearTimer();
		setVisible(true);
		timerRef.current = window.setTimeout(close, HINT_AUTO_DISMISS_MS);
	}, [clearTimer, close]);

	// 上升沿 + 未看过 → 显示（seen 尚未拉取完成时先跳过，由 seen effect 统一补判）。
	useEffect(() => {
		const prev = prevPendingRef.current;
		prevPendingRef.current = hasPendingUpdate;
		if (seenRef.current === null || shownOnceRef.current) return;
		if (shouldShowUpdateDotHint({ hasPendingUpdate, prevHasPendingUpdate: prev, hintSeen: seenRef.current })) {
			shownOnceRef.current = true;
			showWithTimer();
		}
	}, [hasPendingUpdate, showWithTimer]);

	// 挂载时拉取「已看过」标记：拉取完成后若圆点已亮（含启动即有更新）且未显示过 → 补显。
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				seenRef.current = Boolean(settings.updateDotHintSeen);
				if (seenRef.current || shownOnceRef.current || !prevPendingRef.current) return;
				shownOnceRef.current = true;
				showWithTimer();
			})
			.catch(() => {
				// 设置读取失败：按未看过处理，不阻塞提示；仅此会话内生效。
				if (!cancelled) seenRef.current = false;
			});
		return () => {
			cancelled = true;
			clearTimer();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [clearTimer, showWithTimer]);

	if (!visible) return null;

	return (
		<div className="absolute bottom-full left-0 right-0 z-(--z-popover) mb-2 rounded-lg border bg-popover p-3 shadow-md" role="note" aria-label={t("update.dotHintTitle")} onClick={close}>
			{/* 指向设置按钮的小箭头：设置按钮是 dock 最左一项（相对行左缘约 24px） */}
			<span className="absolute -bottom-1 left-6 size-2 rotate-45 border-b border-r bg-popover" aria-hidden="true" />
			<p className="text-sm font-medium text-foreground">{t("update.dotHintTitle")}</p>
			<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("update.dotHintBody")}</p>
			<div className="mt-2 flex items-center justify-end gap-1.5">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={(event) => {
						event.stopPropagation();
						close();
					}}
				>
					{t("update.dotHintDismiss")}
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={(event) => {
						event.stopPropagation();
						close();
						onOpenSettings();
					}}
				>
					{t("update.dotHintAction")}
				</Button>
			</div>
		</div>
	);
}
