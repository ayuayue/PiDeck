/**
 * TokenDance（词元跳动）产品接入共享常量。
 *
 * 主进程（模型目录/授权交换/用量查询）与渲染层（内置供应商卡片、授权引导）
 * 统一从这里取字符串，避免三个地方各写一份 URL 导致归因/端点漂移。
 * 纯常量文件，不引入任何运行时依赖（shared 层约束）。
 *
 * 相关文档：https://tokendance.space/docs/ai-integration.md
 *  - 应用归因：app_url 写入 API Key，请求维度用 X-App-URL 覆盖；
 *  - OAuth 式授权：/auth + PKCE(S256)，code 在 /portal/api/v1/auth/keys 交换。
 */

/** 内置供应商名（pi models.json 的 provider key、模型选择器分组名）。 */
export const TOKENDANCE_PROVIDER = "tokendance";

/** OpenAI 兼容网关 base URL（模型目录 /models 与协议请求共用）。 */
export const TOKENDANCE_BASE_URL = "https://tokendance.space/gateway/v1";

/** PiDeck 的 App URL：写入 API Key 归因 + 请求头 X-App-URL 的值。 */
export const TOKENDANCE_APP_URL = "https://pideck.caoayu.top/";

/** OAuth 授权页（PKCE headless 模式：无 callback_url，确认后展示一次性 code）。 */
export const TOKENDANCE_AUTH_URL = "https://tokendance.space/auth";

/** code 交换 API Key 的端点（POST /portal/api/v1/auth/keys）。 */
export const TOKENDANCE_EXCHANGE_URL = "https://tokendance.space/portal/api/v1/auth/keys";

/** 授权页展示的应用名（key_name 参数，也是新 Key 的默认名称）。 */
export const TOKENDANCE_KEY_NAME = "PiDeck";

/** 兜底解析内置端点时发出的归因请求头（请求维度归因，覆盖 Key 上的 app_url）。 */
export const TOKENDANCE_APP_URL_HEADER = "X-App-URL";
