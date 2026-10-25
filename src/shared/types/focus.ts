/**
 * 主进程 → 渲染层跳转目标（复用 pet:focus-agent-target 通道/pending 队列）：
 * - sessionId：通知点击/宠物点击，跳转指定会话；
 * - projectId：文件夹右键打开且路径已收录，直接选中该项目（selectProjectCommand）；
 * - projectPath：文件夹右键打开但路径未收录，渲染层弹确认框走新增项目流程。
 */
export type FocusTargetPayload = { sessionId: string } | { projectId: string } | { projectPath: string };
