/**
 * pi-subagents 插件适配用的共享类型。
 *
 * 持有 pi-subagents 扩展产生的子代理条目结构，跨主进程和渲染层使用。
 * 该类型仅描述从插件事件和会话文件中提取的数据，不描述插件内部运行时。
 */

/** 子代理生命周期状态（与 @tintinweb/pi-subagents AgentRecord.status 对齐）。 */
export type PiSubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "steered"
  | "aborted"
  | "stopped"
  | "error";

/** 子代理条目：从 subagents:record / 桥接事件 / 工具调用推导合成。 */
export interface PiSubagentEntry {
  /** 插件内部 agentId（record 或事件携带）；异步派发为回执 asyncId（与 subagent-async widget 同源）；无桥接兜底时用工具调用 entryId 合成。 */
  id: string;
  /** 子代理类型（如 "Explore"），对应 AgentRecord.type。 */
  type: string;
  /** spawn 时的描述文本。 */
  description: string;
  /** 当前生命周期状态。 */
  status: PiSubagentStatus;
  /** 终态结果文本（record.result 或 completed 事件）。 */
  result?: string;
  /** 错误信息（failed 事件或 record.error）。 */
  error?: string;
  /** 启动时间戳（epoch ms）。 */
  startedAt?: number;
  /** 完成时间戳（epoch ms）。 */
  completedAt?: number;
  /** 工具调用次数（完成事件或 record 携带）。 */
  toolUses?: number;
  /** token 消耗（完成事件或 record 携带）。 */
  tokens?: number;
  /** 来源标记：record（会话文件权威）、bridge（桥接实时）、toolcall（消息推导兜底）。 */
  source: "record" | "bridge" | "toolcall";
  /**
   * 产出来源通道：acp-delegate = billion-context-pi 的 acp_delegate 委托链；
   * pi-subagents-tool = nicobailon pi-subagents 的 subagent 工具链。
   * 两条链都不落插件 record/事件（acp 不落任何东西，subagent 后台链不落会话文件），
   * 条目由工具调用推导或桥接产生，无插件子会话目录等完整上下文。
   */
  via?: "acp-delegate" | "pi-subagents-tool";
  /**
   * 关联的子会话文件路径（主进程按 `${type}#${id 前 8 位}` 匹配 catalog 后回填）。
   * 不存在时降级展示 record.result 文本。
   */
  childSessionPath?: string;
  /**
   * 关联子会话的稳定会话 id（与 childSessionPath 同源回填）。
   * 渲染层「打开子会话」直接以 id 走 openSidebarSessionById 通路，无需再按路径反查。
   */
  childSessionId?: string;
}