import type { AvailableModel } from "../../../shared/types";

export type ChatSessionBootstrapAction =
  | { kind: "none" }
  | { kind: "load" }
  | { kind: "wait" };

/**
 * 引导页空白输入框的 renderer-only 虚拟会话 ID：无会话打开时（启动 / 清空 Tab /
 * 空项目）引导页直接挂居中 ComposerArea，此 ID 只存在于渲染层 atoms，不落
 * Catalog；用户首次发送时由 App.ensureSessionForSend 创建真实会话（Chat 匿名 /
 * 非 Chat draft）并把 composer 状态整体提升过去。
 */
export const GUIDE_BOOTSTRAP_SESSION_ID = "renderer:guide-bootstrap";

/** 欢迎页（未启动 Agent）选择的模型偏好存储 key。 */
export const WELCOME_MODEL_KEY = "pideck:welcome-model";
/** 欢迎页（未启动 Agent）显式选择的思考级别存储 key；首次发送时提升到真实会话。 */
export const WELCOME_THINKING_KEY = "pideck:welcome-thinking";

/** 读取欢迎页最后选择的模型偏好（无则 undefined）。 */
export function readWelcomeModelPreference(): {
  model: { provider: string; modelId: string };
} | undefined {
  try {
    const raw = localStorage.getItem(WELCOME_MODEL_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { provider?: string; modelId?: string };
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      return { model: { provider: parsed.provider, modelId: parsed.modelId } };
    }
  } catch {
    // 解析失败视为无偏好
  }
  return undefined;
}

/** 读取欢迎页最后选择的思考级别（无则 undefined）。 */
export function readWelcomeThinkingPreference(): { thinkingLevel: string } | undefined {
  try {
    const level = localStorage.getItem(WELCOME_THINKING_KEY);
    if (level) return { thinkingLevel: level };
  } catch {
    // 读取失败视为无偏好
  }
  return undefined;
}

/**
 * welcome 偏好（localStorage 残留）中的模型是否已从模型目录消失。
 * 供应商/模型被删除后偏好仍会指向旧模型（用户反馈「模型都删了新建会话还是它」）；
 * 调用方（引导页底栏展示 / 模型选择器）应忽略该偏好并清理 localStorage，
 * 让显示回落到主进程解析的启动默认（launchDefaults 已校验 models.json 存在性）。
 * 目录未就绪（models 为空）时不判定——避免误清仍有效的偏好（目录加载失败场景）。
 */
export function isWelcomeModelLost(
  welcomeModel: { provider: string; modelId: string } | undefined,
  models: AvailableModel[],
): boolean {
  if (!welcomeModel) return false;
  if (models.length === 0) return false;
  return !models.some(
    (model) => model.provider === welcomeModel.provider && model.id === welcomeModel.modelId,
  );
}

/**
 * 是否该把引导页点选偏好从 localStorage 真的删掉——这是唯一会**销毁**用户点选的路径，
 * 判定必须比展示判定（isWelcomeModelLost）更保守：忽略是临时的、删除是不可逆的。
 *
 * 两道闸门各自的业务理由：
 * - catalogLoaded：偏好是持久数据，而目录可能还在加载中或 IPC 已失败（此时列表为空或残缺）。
 *   拿瞬时状态去毁持久偏好，就是用户反馈的「切了模型但发送后又变回去」的静默丢盘路径。
 * - catalogIsGlobal：偏好存在**全局** localStorage，但 ComposerPickerHost 在有 record 时按
 *   record.projectId 加载**项目范围**目录；项目列表合法地不含该模型时，不能证明全局偏好已死，
 *   否则用户在别的项目里的选择会被无声销毁。
 *
 * 点选已升为创建解析的最高优先级（引导页点选 > 显式默认 > enabledModels > 上次使用），
 * 误删的代价比历史上更大，因此这里宁可不删（残留项由展示层忽略 + 主进程创建时兜底丢弃）。
 */
export function shouldClearWelcomePreference(input: {
  welcomeModel: { provider: string; modelId: string } | undefined;
  models: AvailableModel[];
  /** 目录是否来自一次成功的完整加载（ModelListReport.ok === true）。 */
  catalogLoaded: boolean;
  /** 目录是否按全局范围加载（未传 projectId）。 */
  catalogIsGlobal: boolean;
}): boolean {
  const { welcomeModel, models, catalogLoaded, catalogIsGlobal } = input;
  if (!welcomeModel) return false;
  if (!catalogLoaded || !catalogIsGlobal) return false;
  return isWelcomeModelLost(welcomeModel, models);
}

/**
 * The built-in Chat view needs an identity before the composer renders, but
 * opening the app must not add an unrequested row to history. This renderer-
 * only ID is promoted to a Catalog record only when the user sends.
 */
export function resolveChatSessionBootstrap(input: {
  isChatProject: boolean;
  currentSessionId?: string;
  catalogStatus?: "idle" | "loading" | "ready" | "error";
}): ChatSessionBootstrapAction {
  if (!input.isChatProject || input.currentSessionId) return { kind: "none" };
  // The Chat project can remain collapsed in the sidebar, so it cannot rely on
  // the normal expanded-project scan to reach `ready`. Loading its empty catalog
  // gives the sidebar a deterministic point to list history without creating a
  // durable entry or starting pi.
  if (input.catalogStatus === "idle" || input.catalogStatus === "error" || !input.catalogStatus) {
    return { kind: "load" };
  }
  if (input.catalogStatus !== "ready") return { kind: "wait" };
  // 不再自动选中 renderer-only 虚拟会话：聊天项目点开后与普通项目一致，
  // 先显示统一引导页（新建 Agent / 匿名聊天），用户主动选择后才进入 composer。
  // 避免“聊天项目直接落大输入框、普通项目落引导页”的行为分叉。
  return { kind: "none" };
}
