/**
 * 一个内置扩展在**远端会话**里的处置：
 *
 * - `remote`：可以直接注入，无额外运行时输入；
 * - `remote-needs-env`：可以注入，但依赖 PiDeck 经 runner init 帧传下去的 `PIDECK_*` 环境；
 *   环境通道不可用（旧 runner / 未接线）时**不注入**，因为缺环境时它失败方向是「静默失效」；
 * - `local-only`：代码或依赖只对本机有意义（本机回环桥、vendored 原生依赖、本机回收站语义）；
 * - `not-applicable`：在远端平台/场景下没有意义（Windows-only、只在 PiDeck 注入本地代理时有意义）。
 *
 * 新增内置扩展时这里必须补一条：`Record<BuiltInExtensionName, …>` 让遗漏变成类型错误。
 */
export type RemoteExtensionDisposition = "remote" | "remote-needs-env" | "local-only" | "not-applicable";

/**
 * 每个内置扩展的远端处置（理由写在值旁边，改判断前先读）。
 *
 * 判据只有一条：**它需要的东西能不能跨 SSH 边界成立**。凡是依赖「本机 127.0.0.1」「本机文件路径」
 * 「本机平台特有行为」的，一律不进远端；凡是「纯 pi 扩展 API + 会话条目 + RPC UI」的都可以进。
 */
export const REMOTE_EXTENSION_DISPOSITIONS = {
	// 关联会话工具回调本机端点（`PIDECK_LINKED_SESSIONS_URL`，127.0.0.1），远端 pi 连不到。
	"pi-deck-linked-sessions.ts": "local-only",
	// 模型请求快照经本机端点（`PIDECK_MODEL_TRACE_URL`，127.0.0.1）上传，远端 pi 连不到；
	// 要做先设计 SSH 反向隧道。
	"pi-deck-model-trace.ts": "local-only",
	// 纯 input 钩子 + RPC UI（select/confirm），跨传输成立。
	"pi-deck-request-size-recovery.ts": "remote",
	// 注册 ask_question 工具，交互走 RPC Extension UI 子协议（与传输无关）。
	"pi-deck-ask-question.ts": "remote",
	// 纯 input / agent_end + appendEntry，状态落会话条目。
	"pi-deck-goal-mode.ts": "remote",
	// Git Bash(NUL) 的 Windows-only 修正；远端是 POSIX。
	"pi-deck-nul-redirect-fix.ts": "not-applicable",
	// 纯 input 钩子，按隐藏标记切换只读工具集。
	"pi-deck-plan-mode.ts": "remote",
	// message_end 里改写瞬态错误文案，让 pi 自己的重试名单命中。
	"pi-deck-retry-no-body.ts": "remote",
	// 读 PIDECK_SECURITY_CONFIG / PIDECK_SESSION_ID：缺环境时直接放行（fail-open），所以必须等 env 通道。
	"pi-deck-security-gate.ts": "remote-needs-env",
	// 首轮结束后用**远端**模型生成标题；PIDECK_AUTO_SESSION_TITLE 缺省即开启，关闭用「不注入」表达。
	"pi-deck-session-title.ts": "remote",
	// 订阅第三方 subagent 插件的生命周期事件；远端没装插件就是惰性，落了 record 才能在远端历史里投影。
	"pi-deck-subagents.ts": "remote",
	// 分支作用域的待办状态，落会话条目；依赖同名目录下的 pi-deck-todo-state.ts。
	"pi-deck-todo.ts": "remote",
	// Linux 走 gio trash，进的是**远端主机**的回收站；与 PiDeck 项目内 `.pideck-trash` 不是一套语义，待产品定。
	"pi-deck-trash-guard.ts": "local-only",
	// 依赖 vendored undici（1.6MB / 176 文件，需要子目录），当前快照是扁平声明；S3 再谈。
	"pi-deck-vision.ts": "local-only",
	// 只在 PiDeck 给 pi 进程注入本地代理环境（PIDECK_PI_PROXY_SCOPE）时才有意义；远端没有这份环境。
	"pi-deck-shell-proxy.ts": "not-applicable",
	// 纯 RPC 侧 `reload` 命令（ctx.reload()）：宿主经专用 IPC 触发，远端 pi 同样没有原生 /reload，
	// 且它不依赖任何本机资源，因此可以注入。
	"pi-deck-runtime.ts": "remote",
} as const;
