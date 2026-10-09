/**
 * 本文件由 `node scripts/genZhTwCopy.mjs` 生成，请勿手改。
 * 文案改动请修改对应的 zh-CN 源文件后重新生成；转换规则见该脚本的 OVERRIDES。
 * 注释刻意保留简体：属于开发者视角文本，不面向用户。
 */
import { mainProcessZhTW } from "../../shared/i18n/mainProcessCopy.zh-TW";
import type { WebTranslationKey } from "./WebI18n";

export const webZhTW: Record<WebTranslationKey, string> = {
	...mainProcessZhTW,
	"web.projects": "專案",
	"web.sessions": "會話",
	"web.chooseSession": "選擇或建立會話",
	"web.newProject": "新建專案",
	"web.projectPathPlaceholder": "輸入專案目錄路徑",
	"web.createProject": "新增專案",
	"web.model": "模型",
	"web.thinking": "思考",
	"web.connecting": "連線中...",

	"web.connected": "已連線",
	"web.closeSession": "關閉會話執行例項",
	"web.stopResponse": "停止響應",
	"web.emptySelection": "從左側選擇專案建立會話，或選擇現有會話。",
	"web.promptPlaceholder": "傳送訊息到當前會話",
	"web.send": "傳送",
	"web.composerHint": "Enter 傳送，Shift/Ctrl + Enter 換行",
	"web.opening": "正在開啟...",
	"web.responding": "正在響應...",
	"web.noMessages": "暫無訊息",
	"web.streamFailed": "流式連線失敗，請重新整理後重試",
	"web.closing": "關閉中",
	"web.processing": "處理中",
	"web.role.user": "使用者",
	"web.role.assistant": "助手",
	"web.role.tool": "工具",
	"web.role.system": "系統",
	"web.role.error": "錯誤",
	"web.status.starting": "啟動中",
	"web.status.running": "執行中",
	"web.status.idle": "空閒",
	"web.status.closed": "已關閉",
	"web.status.error": "錯誤",
	"web.status.draft": "草稿",
	"web.status.active": "已儲存",
	"web.status.unknown": "未知狀態",
	"webError.projectIdRequired": "projectId 不能為空",
	"webError.projectPathRequired": "專案路徑不能為空",
	"webError.projectNotFound": "專案不存在",
	"webError.chatProjectProtected": "內建聊天專案不能刪除",
	"webError.requestIdRequired": "requestId 不能為空",
	"webError.messageRequired": "message 或 images 不能為空",
	"webError.runtimeTargetRequired": "需要匹配當前會話的執行目標",
	"webError.apiNotFound": "API 不存在",
	"webError.internal": "Web 服務發生內部錯誤",
	"webError.unauthorized": "缺少或錯誤的 Web 服務訪問令牌",
	"webError.bodyTooLarge": "請求體超過大小限制",
};
