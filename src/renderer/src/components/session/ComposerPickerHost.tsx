import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../../shared/types";
import {
  beginPiRuntimeThinkingLevelsAtom,
  clearPiRuntimeThinkingLevelsAtom,
  matchesPiRuntimeThinkingLevelsTarget,
  modelPendingByIdAtom,
  piRuntimeThinkingLevelsBySessionIdAtomFamily,
  resolvePiRuntimeThinkingLevelsAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeByIdAtom,
  sessionRuntimeBySessionIdAtomFamily,
  upsertSessionAtom,
} from "../../atoms";
import type { PromptTemplateInfo } from "../../composerBehavior";
import {
  ModelPicker,
  PromptTemplatePicker,
  ThinkingPicker,
} from "./ComposerParts";
import { ComposerSkillPicker } from "./ComposerSkillPicker";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { t } from "../../i18n";
import {
  SessionCommandFailure,
  isLiveRuntimeStatus,
  requireSessionCommand,
  sessionCommandFailureToast,
  toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { resolveComposerLiveModel, resolveGuideDisplayModel } from "../../utils/modelPendingDisplay";
import { resolveComposerThinkingLevel } from "../../utils/thinkingDisplay";
import { ConfirmDialog } from "../app/AppParts";
import { useSessionPaneServices } from "./SessionPaneServices";
import { usePendingModelApply } from "../../hooks/usePendingModelApply";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import {
  WELCOME_MODEL_KEY,
  WELCOME_THINKING_KEY,
  isWelcomeModelLost,
  readWelcomeModelPreference,
  readWelcomeThinkingPreference,
  shouldClearWelcomePreference,
} from "../../utils/chatSessionBootstrap";
import { resolveThinkingPickerLevels } from "./sessionPickerOptions";

export type ComposerPickerHostProps = {
  sessionId: string;
  picker: ComposerPickerKind | null;
  templates: PromptTemplateInfo[];
  onClose: () => void;
  onInsertTemplate: (template: PromptTemplateInfo) => void;
  /** 一键插入模板全文（controller insertTemplateContent）：直接塞正文，不走斜线命令。 */
  onInsertTemplateContent: (template: PromptTemplateInfo) => void;
  /** 技能选择：把技能调用命令插入输入框（由 controller 的 insertSkillInvocation 提供）。
   *  插入的斜杠形态由后端决定：pi 用 /skill:名称，DSH 用 /名称——保证与各自的
   *  技能命令解析一致，避免「从列表选了却调不动」（bare 斜杠在 pi 会被过滤）。 */
  onInsertSkill: (name: string) => void;
  /** 一键插入技能全文（controller insertSkillContent）：正文由选择器先读 SKILL.md。 */
  onInsertSkillContent: (content: string) => void;
  /** DSH 部署默认模型/思考档位（settings.yaml agent-default-model）：草稿期高亮与过滤用。 */
  defaultModel?: { provider?: string; modelId?: string; modelName?: string };
  defaultThinkingLevel?: string;
};

export function ComposerPickerHost(props: ComposerPickerHostProps) {
  const { sessionId } = props;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const upsertSession = useSetAtom(upsertSessionAtom);
  const modelPending = useAtomValue(modelPendingByIdAtom)[sessionId];
  const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
  const piRuntimeThinkingEntry = useAtomValue(
    piRuntimeThinkingLevelsBySessionIdAtomFamily(sessionId),
  );
  const beginPiRuntimeThinkingLevels = useSetAtom(beginPiRuntimeThinkingLevelsAtom);
  const clearPiRuntimeThinkingLevels = useSetAtom(clearPiRuntimeThinkingLevelsAtom);
  const resolvePiRuntimeThinkingLevels = useSetAtom(resolvePiRuntimeThinkingLevelsAtom);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  /** 最近使用的供应商（最新在前）：模型选择器按此优先排列供应商分组。 */
  const [recentProviders, setRecentProviders] = useState<string[]>([]);
  /** 用户隐藏的供应商（Pi 模型页眼睛开关）：Pi 后端模型选择器按 provider 过滤。 */
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
  /** 模型在本地 models.json 存在但运行中 Agent 未加载：待确认重启的目标。 */
  const [restartTarget, setRestartTarget] = useState<{
    handle: SessionRuntimeTarget;
    model: string;
  } | null>(null);
  const [restarting, setRestarting] = useState(false);
  // 与 Tab 栏「重启」共用 App.restartActiveAgent：置 restartingAgentId，
  // SessionView overlay（loader + 文案）才会亮。选择器自己调 restartRuntime
  // 能换进程，但不会驱动那套 UI 状态。
  const { restartActiveAgent } = useSessionPaneServices();
  // 不跟 restartTarget state 同步：ConfirmDialog 点确定会先 onOpenChange(false)
  // 走 onCancel 清掉 state；确认意图放 ref，避免当成取消后丢数据。
  const restartIntentRef = useRef<{
    agentId: string;
    provider: string;
    modelId: string;
  } | null>(null);
  const confirmingRestartRef = useRef(false);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setFavoriteModels(settings.favoriteModels ?? []);
      setRecentProviders(settings.recentProviders ?? []);
      setHiddenProviders(settings.hiddenProviders ?? []);
    }).catch(() => undefined);
  }, []);

  // C19：模型目录数据源统一 hook——打开模型/思考选择器即加载（不依赖 record：欢迎页/
  // 未启动 Agent 时 record 为 undefined，但模型列表是全量的）。Pi 欢迎页也要加载，才能
  // 使用启动 capability snapshot 的精确 thinkingLevels；DSH 的 catalog 提供默认档位与
  // 当前模型信息（思考档位按当前模型 reasoningEfforts 裁剪，模型未知/未声明时回退全量，
  // host 负责最终能力校验）。
  const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
  const pickerNeedsModels = props.picker === "model" || props.picker === "thinking";
  // 模型目录数据源统一走 capability cache。思考选择器同样加载它，运行中也能直接
  // 复用已水合的模型档位，不必等待 Agent RPC。
  const { models, report, loading: catalogLoading, refreshing, reload } = useBackendModelCatalog({
    sessionId,
    backend: isDshSession ? "dsh" : "pi",
    projectId: record?.projectId,
    enabled: pickerNeedsModels,
  });
  const welcomeModel = isDshSession ? undefined : readWelcomeModelPreference()?.model;
  // welcome 偏好可能指向已删除的供应商/模型（models.json 已更新而 localStorage 残留）：
  // 目录加载后校验存在性，失效则忽略该偏好，避免选择器/默认高亮落在幽灵模型上。
  // 与 ComposerBottomBar 共用 isWelcomeModelLost 判定；目录未加载（models 为空）时不判定，
  // 避免误清用户仍有效的偏好。
  const welcomeModelLost = isWelcomeModelLost(welcomeModel, models);
  // 展示可以宽容忽略，但删除不可逆：本组件在有 record 时按 record.projectId 加载
  // 「项目范围」目录，而偏好是全局 localStorage——项目列表合法地不含该模型时不能
  // 拿它判死全局偏好，否则会把用户在别的项目里仍然有效的点选静默销毁。
  const clearWelcomePreference = shouldClearWelcomePreference({
    welcomeModel,
    models,
    catalogLoaded: report?.ok === true,
    catalogIsGlobal: !record?.projectId,
  });
  useEffect(() => {
    // 失效偏好只清一次：下次引导页不再默认已删除的模型（创建时主进程也会兜底丢弃）。
    if (clearWelcomePreference) {
      try {
        localStorage.removeItem(WELCOME_MODEL_KEY);
      } catch {
        // localStorage 不可用时静默；展示层已忽略该偏好。
      }
    }
  }, [clearWelcomePreference]);
  const effectiveWelcomeModel = welcomeModelLost ? undefined : welcomeModel;
  // 引导页（无 record）模型高亮：与主进程创建解析同序（点选 > 显式默认 > 切换列表 > 上次使用）。
  // 规则收拢到 resolveGuideDisplayModel，不再在本组件与 ComposerComponents 各写一份。
  const guideDefaultModel = resolveGuideDisplayModel({
    isDsh: isDshSession,
    welcomeModel: effectiveWelcomeModel,
    defaultModel: props.defaultModel,
  });
  // 非 live 残留 state 不能盖住 catalog：Agent 未启动时改模型，选择器高亮必须跟记录走。
  const runtimeLive = isLiveRuntimeStatus(runtime?.status);
  const resolvedLiveModel = resolveComposerLiveModel({
    state: runtime?.state,
    record: record?.model,
    fallback: {
      // 无 record（引导页）：高亮取 guideDefaultModel（已按「点选 > 显式默认 > 切换列表 > 上次使用」
      // 折叠）；modelName 必须同源取 guideDefaultModel，否则点选生效时会拿默认模型的展示名配点选的 id。
      provider: guideDefaultModel?.provider,
      modelId: guideDefaultModel?.modelId,
      modelName: guideDefaultModel?.modelName,
    },
    isLive: runtimeLive,
  });

  const runtimeThinkingEntryRef = useRef(piRuntimeThinkingEntry);
  runtimeThinkingEntryRef.current = piRuntimeThinkingEntry;

  useEffect(() => {
    return () => {
      // The host is scoped to one mounted session pane; releasing here keeps the
      // per-session atom map bounded without coupling global session atoms to it.
      clearPiRuntimeThinkingLevels(sessionId);
    };
  }, [sessionId, clearPiRuntimeThinkingLevels]);

  /**
   * Pi 运行态的 RPC 仅在用户打开思考档位、capability cache 已尝试加载但没有结果、
   * 且 Agent 空闲时做后台校验。生成中的 Agent 可能延后处理请求；选择器始终优先
   * 使用 cache / 静态兼容档位，不能被这条非关键校验卡成 loading。
   */
  useEffect(() => {
    const agentId = runtime?.agentId;
    const runtimeGeneration = runtime?.runtimeGeneration;
    // 只向空闲、且 capability cache 已加载却没有该模型精确档位的 Agent 查
    // thinkingLevelMap。生成中的 Agent 与未打开的菜单都不能触发这条非关键 RPC。
    const provider = resolvedLiveModel.provider;
    const modelId = resolvedLiveModel.modelId;
    const cachedModel = models.find(
      (model) => model.provider === provider && model.id === modelId,
    );
    if (
      props.picker !== "thinking" ||
      isDshSession ||
      runtime?.status !== "idle" ||
      report === null ||
      cachedModel?.thinkingLevels !== undefined ||
      !agentId ||
      typeof runtimeGeneration !== "number" ||
      !provider ||
      !modelId
    ) {
      return;
    }
    const target = { agentId, runtimeGeneration, provider, modelId };
    if (matchesPiRuntimeThinkingLevelsTarget(runtimeThinkingEntryRef.current, target)) return;

    beginPiRuntimeThinkingLevels({ sessionId, target });
    void desktopApi.sessions.listRuntimeThinkingLevels({
      sessionId,
      agentId,
      runtimeGeneration,
    }).then((result) => {
      // The atom accepts the result only while this exact runtime/model still owns the slot.
      resolvePiRuntimeThinkingLevels({
        sessionId,
        target,
        levels: result.ok ? result.value.value : undefined,
      });
    }).catch(() => {
      resolvePiRuntimeThinkingLevels({ sessionId, target });
    });
  }, [
    sessionId,
    props.picker,
    isDshSession,
    runtime?.agentId,
    runtime?.runtimeGeneration,
    runtime?.status,
    resolvedLiveModel.provider,
    resolvedLiveModel.modelId,
    models,
    report,
    beginPiRuntimeThinkingLevels,
    resolvePiRuntimeThinkingLevels,
  ]);

  function currentHandle() {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    return toSessionRuntimeTarget(sessionId, current);
  }

  /**
   * 运行时代理命令失败时，若错误是「运行时不可用/绑定已变化」（例如 Agent 已被关闭、
   * 或历史会话尚未启动 Agent），降级为只更新会话记录。Agent 下次启动时
   * SessionRuntimeCoordinator.applyPreferences 会把记录里的模型应用到新进程。
   */
  function isStaleRuntimeFailure(error: unknown): boolean {
    return error instanceof SessionCommandFailure &&
      (error.code === "SESSION_RUNTIME_UNAVAILABLE" ||
        error.code === "SESSION_RUNTIME_CHANGED");
  }

  async function applyModelToRecord(model: AvailableModel) {
    const updated = await desktopApi.sessions.updateRecord(sessionId, {
      model: { provider: model.provider, modelId: model.id },
    });
    upsertSession(updated);
  }

  function currentLiveModel() {
    // pending「from」只取 live state / catalog，不掺欢迎页兜底，避免把草稿偏好当成已生效模型。
    return resolveComposerLiveModel({
      state: runtime?.state,
      record: record?.model,
      isLive: runtimeLive,
    });
  }

  function markModelPending(model: AvailableModel) {
    const live = currentLiveModel();
    const from = modelPending?.from ?? {
      provider: live.provider,
      modelId: live.modelId,
      modelName: live.modelName,
    };
    if (from.provider === model.provider && from.modelId === model.id) {
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      return;
    }
    setModelPendingMap((prev) => ({
      ...prev,
      [sessionId]: {
        from,
        to: {
          provider: model.provider,
          modelId: model.id,
          modelName: model.name ?? model.id,
        },
      },
    }));
  }

  function offerModelRestart(handle: SessionRuntimeTarget, model: AvailableModel) {
    props.onClose();
    restartIntentRef.current = {
      agentId: handle.agentId,
      provider: model.provider,
      modelId: model.id,
    };
    setRestartTarget({
      handle,
      model: `${model.provider}/${model.id}`,
    });
  }

  function applyRuntimeModelState(agentState: { provider?: string; modelId?: string; modelName?: string }) {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    if (!current) return;
    store.set(sessionRuntimeByIdAtom, {
      ...store.get(sessionRuntimeByIdAtom),
      [sessionId]: {
        ...current,
        state: current.state ? { ...current.state, ...agentState } : agentState,
      },
    });
  }

  usePendingModelApply({
    sessionId,
    runtime,
    modelPending,
    applyRuntimeModelState,
    clearPending: () => setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined })),
    offerRestart: offerModelRestart,
  });

  /**
   * 后端明确返回 busy 时才排队模型切换；支持运行中选择的 Pi/DSH 会直接在当前 runtime
   * 入口应用，已发出的请求继续使用原配置，后续 step 使用新配置。
   */
  async function pickModelWhileBusy(handle: SessionRuntimeTarget, model: AvailableModel) {
    try {
      const listed = requireSessionCommand(await desktopApi.sessions.listRuntimeModels(handle));
      const snapshotHasModel = listed.value.some(
        (item) => item.provider === model.provider && item.id === model.id,
      );
      if (!snapshotHasModel) {
        offerModelRestart(handle, model);
        return;
      }
    } catch {
      // 查快照失败（含生成中 busy）不挡选择：先记下，本轮结束后 setRuntimeModel 再判断要不要重启。
    }
    await applyModelToRecord(model);
    markModelPending(model);
    props.onClose();
  }

  async function pickModel(model: AvailableModel) {
    // 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_MODEL_KEY, JSON.stringify({
          provider: model.provider,
          modelId: model.id,
        }));
      } catch {
        // localStorage 不可用时静默；创建会话回退到 pi 默认模型
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    try {
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(
            handle,
            model.provider,
            model.id,
          ));
          const appliedModel = result.value.provider && result.value.modelId
            ? { provider: result.value.provider, modelId: result.value.modelId }
            : { provider: model.provider, modelId: model.id };
          upsertSession({
            ...record,
            model: appliedModel,
            updatedAt: Date.now(),
          });
          setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的模型名称、provider 即刻刷新，无需等待 emitState 事件
          applyRuntimeModelState(result.value);
        } catch (error) {
          if (error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_BUSY") {
            await pickModelWhileBusy(handle, model);
            return;
          }
          // 运行时代理不可用（Agent 已关/绑定已换）时降级写记录，
          // 保证「先选模型、后启动 Agent」的流程始终可用。
          if (!isStaleRuntimeFailure(error)) throw error;
          await applyModelToRecord(model);
        }
      } else {
        await applyModelToRecord(model);
      }
      props.onClose();
    } catch (error) {
      // 模型在本地 models.json 存在但运行中 Agent 快照未加载（pi set_model 校验失败）：
      // 关闭选择器并提示用户重启 Agent 使新模型生效，而非直接报错。
      if (error instanceof SessionCommandFailure && error.needsRestart && handle) {
        offerModelRestart(handle, model);
        return;
      }
      // 附带 debugDetails：DSH selectModel 拒绝（如 reasoningEffort 不被模型支持）时
      // 把真实原因展示给用户，而不是只看到泛化的「会话操作失败，请重试。」
      showNotice(sessionCommandFailureToast(error), 4000);
    }
  }

  /**
   * 确认后先把新模型写入会话记录，再走统一重启入口。
   * setRuntimeModel 失败时不写 catalog（避免取消后误套新模型）；
   * 重启后 applyPreferences 读 catalog 才能套上用户刚确认的模型。
   * 必须走 restartActiveAgent，才能点亮 SessionView 的重启动画。
   */
  async function confirmRestart() {
    const intent = restartIntentRef.current;
    if (!intent || restarting) return;
    confirmingRestartRef.current = true;
    setRestarting(true);
    // 先关确认框，避免 AlertDialog 关闭动画盖住 overlay。
    setRestartTarget(null);
    try {
      const updated = await desktopApi.sessions.updateRecord(sessionId, {
        model: { provider: intent.provider, modelId: intent.modelId },
      });
      upsertSession(updated);
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      await restartActiveAgent(intent.agentId);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    } finally {
      confirmingRestartRef.current = false;
      restartIntentRef.current = null;
      setRestarting(false);
    }
  }

  async function pickThinking(level: string) {
    // 引导页只有 renderer-only 虚拟会话，尚无 catalog record 可更新。先保存本次
    // 显式选择，底栏关闭选择器后立即从同一偏好重绘；首次发送创建真实会话时再带入。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_THINKING_KEY, level);
      } catch {
        // localStorage 不可用时静默；首次创建会话会回退到配置默认档位。
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    try {
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeThinking(handle, level));
          const agentState = result.value;
          // runtime state carries the host-confirmed effort (DSH may normalize it);
          // fall back to the requested value only for runtimes without a selected model.
          const appliedThinkingLevel = agentState.thinkingLevel ?? level;
          upsertSession({ ...record, thinkingLevel: appliedThinkingLevel, updatedAt: Date.now() });
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的思考强度即刻刷新
          const current = store.get(sessionRuntimeByIdAtom)[sessionId];
          if (current) {
            store.set(sessionRuntimeByIdAtom, {
              ...store.get(sessionRuntimeByIdAtom),
              [sessionId]: {
                ...current,
                state: current.state
                  ? { ...current.state, ...agentState }
                  : agentState,
              },
            });
          }
        } catch (error) {
          // 与模型选择同一策略：运行时不可用时降级为写记录，启动时生效
          if (!isStaleRuntimeFailure(error)) throw error;
          const updated = await desktopApi.sessions.updateRecord(sessionId, {
            thinkingLevel: level,
          });
          upsertSession(updated);
        }
      } else {
        const updated = await desktopApi.sessions.updateRecord(sessionId, {
          thinkingLevel: level,
        });
        upsertSession(updated);
      }
      props.onClose();
    } catch (error) {
      // 附带 debugDetails：DSH setThinking 的 selectModel 被 host 拒绝（如当前模型
      // 不支持该档位）时，把真实原因展示给用户，而不是只看到「会话操作失败，请重试。」
      showNotice(sessionCommandFailureToast(error), 4000);
    }
  }

  async function toggleFavorite(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    const next = favoriteModels.includes(key)
      ? favoriteModels.filter((item) => item !== key)
      : [...favoriteModels, key];
    setFavoriteModels(next);
    try {
      await desktopApi.settings.update({ favoriteModels: next });
    } catch (error) {
      setFavoriteModels(favoriteModels);
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  if (props.picker === "template") {
    return (
      <PromptTemplatePicker
        templates={props.templates}
        onClose={props.onClose}
        onPick={props.onInsertTemplate}
        onInsertContent={props.onInsertTemplateContent}
      />
    );
  }
  if (props.picker === "skill") {
    return (
      <ComposerSkillPicker
        backend={isDshSession ? "dsh" : "pi"}
        projectId={record?.projectId}
        agentId={runtime?.agentId}
        onClose={props.onClose}
        onPick={props.onInsertSkill}
        onInsertContent={props.onInsertSkillContent}
      />
    );
  }
  if (props.picker === "model") {
    // DSH 会话的模型归属 host（agent-default-model），不读 pi 的欢迎页偏好：
    // 否则 localStorage 里的 pi 模型会被当成「当前模型」高亮，误导用户以为已选中。
    // 草稿期用部署默认模型（settings.yaml agent-default-model）作当前值。
    return (
      <ModelPicker
        models={models}
        report={report}
        loading={catalogLoading}
        refreshing={refreshing}
        onRefresh={() => reload(true)}
        current={resolvedLiveModel}
        onClose={props.onClose}
        onPick={(model) => void pickModel(model)}
        favoriteModels={favoriteModels}
        onToggleFavorite={(provider, modelId) => void toggleFavorite(provider, modelId)}
        recentProviders={recentProviders}
        hiddenProviders={hiddenProviders}
        // 用量查询链路随会话后端：DSH 目录的 provider 是 route 名，配置/凭据走 dsh 链路
        backend={isDshSession ? "dsh" : "pi"}
      />
    );
  }
  if (props.picker === "thinking") {
    // DSH：只有当前模型明确声明可用 reasoningEfforts 时才按声明裁剪；目录暂未加载、
    // 未识别当前模型、或没有声明档位时必须回退全量档位。能力判断由 DSH / pi-ai 后端
    // 最终处理，前端不能因为本地元数据缺失而剥夺用户的切换入口。
    // 草稿期当前模型 = 部署默认模型（settings.yaml agent-default-model）。
    const currentProvider = resolvedLiveModel.provider;
    const currentModelId = resolvedLiveModel.modelId;
    const currentModel = models.find(
      (model) => model.provider === currentProvider && model.id === currentModelId,
    );
    const runtimeThinkingTarget = !isDshSession && runtimeLive && runtime?.agentId &&
      typeof runtime.runtimeGeneration === "number" && currentProvider && currentModelId
      ? {
          agentId: runtime.agentId,
          runtimeGeneration: runtime.runtimeGeneration,
          provider: currentProvider,
          modelId: currentModelId,
        }
      : undefined;
    const runtimeLevels = runtimeThinkingTarget &&
      matchesPiRuntimeThinkingLevelsTarget(piRuntimeThinkingEntry, runtimeThinkingTarget) &&
      piRuntimeThinkingEntry?.status === "resolved"
      ? piRuntimeThinkingEntry.levels
      : undefined;
    // 正在运行的 Agent 不能把后台 RPC 当成弹窗的前置条件：统一以 capability cache
    // 为唯一展示源，runtime RPC 仅在 cache 未覆盖该模型时兑底。缓存/元数据尚不可用
    // 时保留全量兼容档位；后端才是最终能力裁决者。
    const pickerLevels = resolveThinkingPickerLevels({
      backend: isDshSession ? "dsh" : "pi",
      runtimePiLevels: runtimeLevels,
      cachedPiLevels: currentModel?.thinkingLevels,
      dshReasoningEfforts: currentModel?.reasoningEfforts,
    });
    // 无 record 的引导页以用户刚点选的档位为最高优先级；只有尚未点选时，
    // 才依次回退 settings.defaultThinkingLevel 与模型自身 defaultEffort。
    const welcomeThinking = !record
      ? readWelcomeThinkingPreference()?.thinkingLevel
      : undefined;
    const current = welcomeThinking ?? props.defaultThinkingLevel ?? currentModel?.defaultEffort;
    return (
      <ThinkingPicker
        current={resolveComposerThinkingLevel({
          state: runtime?.state?.thinkingLevel,
          record: record?.thinkingLevel,
          // 无 record（引导页）：显式点选 > 配置默认 > 模型默认（与底栏同规则）。
          fallback: current,
          isLive: runtimeLive,
        })}
        levels={pickerLevels}
        onClose={props.onClose}
        onPick={(level) => void pickThinking(level)}
      />
    );
  }
  return (
    <>
      {restartTarget && (
        <ConfirmDialog
          title={t("app.modelRestartTitle")}
          message={t("app.modelRestartBody", { model: restartTarget.model })}
          confirmLabel={t("common.confirm")}
          onConfirm={() => {
            confirmingRestartRef.current = true;
            void confirmRestart();
          }}
          onCancel={() => {
            // 只关框：点确定也会先走 onOpenChange(false)→onCancel。
            // 不能在这里清 restartIntentRef，否则确认路径读到空、重启不会发生。
            setRestartTarget(null);
          }}
        />
      )}
    </>
  );
}
