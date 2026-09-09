import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AgentBackend,
	AvailableModel,
	ModelListReport,
} from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";

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
export function useBackendModelCatalog(options: {
  sessionId: string;
  backend?: AgentBackend;
  projectId?: string;
  enabled: boolean;
}): {
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
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [report, setReport] = useState<ModelListReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sequenceRef = useRef(0);

  const load = useCallback(
    (force = false) => {
      if (!options.enabled) return;
      const sequence = ++sequenceRef.current;
      if (force) setRefreshing(true);
      else setLoading(true);
      // DSH 目录是 host 数据结构（无 CLI 失败概念），构造一个恒成功的报告即可。
      const loader = options.backend === "dsh"
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
        : desktopApi.projects.listModelsReport(options.projectId, force);
      void loader
        .then((next) => {
          if (sequence !== sequenceRef.current) return;
          setModels(next.models);
          setReport(next);
          setLoading(false);
          setRefreshing(false);
        })
        .catch((error) => {
          if (sequence !== sequenceRef.current) return;
          // IPC 异常兜底：列表置空 + 合成失败报告（选择器据此显示失败引导与重试按钮，
          // 而不是把 report 留成 null 导致面板空白），并 toast 提示原始错误。
          const detail = error instanceof Error ? error.message : String(error);
          setModels([]);
          setReport({
            models: [],
            ok: false,
            reason: "cli-failed",
            version: null,
            detail,
            source: "none",
            at: Date.now(),
          });
          setLoading(false);
          setRefreshing(false);
          showNotice(detail, 4000);
        });
    },
    [options.enabled, options.backend, options.projectId],
  );

  useEffect(() => {
    load();
  }, [load]);

  return { models, report, loading, refreshing, reload: load };
}