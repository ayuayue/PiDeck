import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentBackend, AvailableModel, ModelListReport } from "../../../shared/types";
import { TOKENDANCE_PROVIDER, type TokendancePriceTagMap } from "../../../shared/tokendance";
import { applyTokenDancePriceTags, loadTokenDancePriceTags } from "./tokendancePriceTags";
import { isDshManuallyStoppedErrorMessage } from "../../../shared/dshManualStop";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

const EMPTY_MODELS: AvailableModel[] = [];
const EMPTY_PRICE_TAGS: TokendancePriceTagMap = {};

/** Accepted reports retain their source so a new scope cannot reuse their success flag. */
type CatalogResult = {
	backend?: AgentBackend;
	projectId?: string;
	/** 路由键：模型目录按会话取（远端会话由它自己那台远端 pi 回答），换了会话就不能复用。 */
	sessionId: string;
	report: ModelListReport;
};

/**
 * 后端模型目录数据源（C19）：统一「按 backend 加载模型列表」——
 * DSH 会话走 host 级 llm.models（listDshModels），pi 走 projects.listModelsReport
 *（诊断报告：优先 pi --list-models，失败回退本地 models.json，并附带失败原因分类）。
 * enabled=false 时不加载（选择器打开才拉取，避免常驻轮询）；
 * 内部带 sequence 防竞态（快速开关选择器时旧响应不覆盖新响应）。
 *
 * reload(force=true) = 手动刷新：绕过全局缓存重新 fork pi --list-models，
 * 「模型列表加载不出来」的用户可立即重试，不必重启应用。
 *
 * loading = 首次加载（非手动刷新）在途：选择器据此显示加载态，避免首屏空白。
 */
export function useBackendModelCatalog(options: { sessionId: string; backend?: AgentBackend; projectId?: string; enabled: boolean }): {
	models: AvailableModel[];
	/** 最近一次加载的报告（DSH 目录为构造的成功报告）；加载失败时含原因分类。 */
	report: ModelListReport | null;
	/** 首次加载在途（手动刷新走 refreshing，两者互斥展示） */
	loading: boolean;
	/** 手动刷新进行中（选择器刷新按钮转圈用） */
	refreshing: boolean;
	/** 重新加载；传 true 绕过缓存强制重新 fork（手动刷新） */
	reload: (force?: boolean) => void;
} {
	const [catalog, setCatalog] = useState<CatalogResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const sequenceRef = useRef(0);

	const load = useCallback(
		(force = false) => {
			if (!options.enabled) return;
			const sequence = ++sequenceRef.current;
			setRefreshing(force);
			setLoading(!force);
			// DSH 目录是 host 数据结构（无 CLI 失败概念），构造一个恒成功的报告即可。
			// pi 走会话级通道（sessions:list-models）：主进程按会话 location 分流，
			// 远端会话由它自己那台远端 pi 回答 get_available_models。
			// 不用 projects:list-models-report 的原因：那条永远回答本机目录，
			// 远端会话选中后 set_model 必 Model not found（旧行为）。
			const loader =
				options.backend === "dsh"
					? desktopApi.sessions.listDshModels().then(
							(list): ModelListReport => ({
								models: list,
								ok: true,
								reason: null,
								version: null,
								detail: "",
								source: "cli",
								at: Date.now(),
							}),
						)
					: desktopApi.sessions.listModels(options.sessionId, force, options.projectId);
			void loader
				.then((next) => {
					if (sequence !== sequenceRef.current) return;
					setCatalog({ backend: options.backend, projectId: options.projectId, sessionId: options.sessionId, report: next });
					setLoading(false);
					setRefreshing(false);
				})
				.catch((error) => {
					if (sequence !== sequenceRef.current) return;
					// IPC 异常兜底：列表置空 + 合成失败报告（选择器据此显示失败引导与重试按钮，
					// 而不是把 report 留成 null 导致面板空白），并 toast 提示错误。
					// 「DSH host 手动停止」是主进程内部 sentinel（契约见 shared/dshManualStop.ts），
					// 原样展示会把 "Error invoking remote method ..." 漏给用户：toast 映射成 i18n 文案，
					// report 用专用失败原因（选择器引导「启动 host」而非「检查 pi 健康」；detail 留空，
					// 引导块已按 reason 出文案，pre 里再放 sentinel 等于没修）。
					const rawDetail = error instanceof Error ? error.message : String(error);
					const dshStopped = options.backend === "dsh" && isDshManuallyStoppedErrorMessage(rawDetail);
					setCatalog({
						backend: options.backend,
						projectId: options.projectId,
						sessionId: options.sessionId,
						report: {
							models: [],
							ok: false,
							reason: dshStopped ? "dsh-host-stopped" : "cli-failed",
							version: null,
							detail: dshStopped ? "" : rawDetail,
							source: "none",
							at: Date.now(),
						},
					});
					setLoading(false);
					setRefreshing(false);
					showNotice(dshStopped ? t("app.modelListFailDshStopped") : rawDetail, 4000);
				});
		},
		[options.enabled, options.backend, options.projectId, options.sessionId],
	);

	useEffect(() => {
		if (options.enabled) load();
		else {
			setLoading(false);
			setRefreshing(false);
		}
		return () => {
			// Closing, switching source or unmounting must retire even a manual refresh.
			// The IPC may still finish, but its result and error notice no longer belong here.
			sequenceRef.current++;
		};
	}, [load, options.enabled]);

	// Filter during render, not in an effect: consumers use report.ok to invalidate
	// welcome preferences, so even the first render must reject another source's data.
	const report = catalog?.backend === options.backend && catalog?.projectId === options.projectId && catalog?.sessionId === options.sessionId ? (catalog?.report ?? null) : null;
	const catalogModels = report?.models ?? EMPTY_MODELS;
	// TokenDance 模型的价格徽章（折扣/免费）：目录里出现 tokendance 组才拉一次报价表，
	// 到货后补价格标记重新渲染；不阻塞首屏——徽章没到/拉取失败时列表照常可用。
	const hasTokenDanceModels = catalogModels.some((model) => model.provider === TOKENDANCE_PROVIDER);
	const [priceTags, setPriceTags] = useState<TokendancePriceTagMap>(EMPTY_PRICE_TAGS);
	useEffect(() => {
		if (!hasTokenDanceModels) return;
		let cancelled = false;
		void loadTokenDancePriceTags().then((tags) => {
			if (!cancelled) setPriceTags(tags);
		});
		return () => {
			cancelled = true;
		};
	}, [hasTokenDanceModels]);
	const models = useMemo(() => applyTokenDancePriceTags(catalogModels, priceTags), [catalogModels, priceTags]);
	return { models, report, loading: options.enabled && loading, refreshing: options.enabled && refreshing, reload: load };
}
