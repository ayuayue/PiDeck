/**
 * 统一 API 薄入口（S7）：piDeckApi = composeUnifiedApi(desktopApi)。
 *
 * 消费前提（与 shared 层 S3/S7 同源裁定）：desktopApi 的回退链在 Electron 缺
 * preload 时返回 unavailable Proxy，任取命名空间即抛 app.preloadMissing——本入口
 * 不做第二次兜底，preload 缺席时调用方本就拿不到有效 API。
 *
 * 语义：叠加不替换。既有 desktopApi 调用零迁移（A23）；本入口只做目录表驱动的
 * 命名空间引用透传与 sessions/config 收口（A11：无缓存/重试/去重/逐方法包装）。
 */
import { composeUnifiedApi } from "../../shared/api/composeFacade";
import { desktopApi } from "./desktopApi";

/** 统一 API 视图：聚合域恒等（piDeckApi.git === desktopApi.git）、sessions/config 按分组表收口、
 *  红线域（pi/piAuth/enhance 等）只透传原命名空间引用。 */
export const piDeckApi = composeUnifiedApi(desktopApi);
