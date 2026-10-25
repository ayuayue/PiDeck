import { VOLC_FLASH_RESOURCE_ID, VOLC_STREAM_RESOURCE_ID, VOLC_SUPPORTED_RESOURCE_IDS } from "../../../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionTestResult } from "../../../../../shared/types/voiceTranscription";
import { t } from "../../../i18n";

/**
 * 资源 ID → 展示名。清单来自 shared（只有客户端真正实现了的协议才出现在这里），
 * 设置页因此不再给自由文本：填错一个字符就是服务端 45000001「参数无效」，用户完全无从下手。
 */
export const VOLC_RESOURCE_ID_LABELS: Record<(typeof VOLC_SUPPORTED_RESOURCE_IDS)[number], "voice.settings.cloudResourceIdStream" | "voice.settings.cloudResourceIdTurbo"> = {
	[VOLC_STREAM_RESOURCE_ID]: "voice.settings.cloudResourceIdStream",
	[VOLC_FLASH_RESOURCE_ID]: "voice.settings.cloudResourceIdTurbo",
};

/**
 * 安装失败码的展示文案：中止 / 并发这类已知码走 i18n，未知码原样带出
 * （size-mismatch、sha256-mismatch 这类信息对定位镜像问题是线索，不要翻译成空泛提示）。
 */
export function installErrorCopy(error?: string): string {
	if (error === "cancelled") return t("voice.settings.error.cancelled");
	if (error === "already-installing") return t("voice.settings.error.alreadyInstalling");
	return error || t("voice.settings.error.installFailed");
}

/** 检测结果的文案：错误码复用录音失败那套话术，豆包的业务码追加在后面。 */
export function testCopy(result: VoiceTranscriptionTestResult | null): string {
	if (!result) return t("voice.settings.test.unexpected");
	if (result.ok) return t("voice.settings.test.ok");
	const base = t(`voice.error.${result.error}`);
	const statusCode = result.detail?.statusCode;
	if (!statusCode) return base;
	// 服务端原文（X-Api-Message）是最有用的线索：45000030 的 "requested resource not granted"
	// 直接说明「没开通」，而我们自己造的中文文案只能说「权限不足」。
	const serverMessage = result.detail?.message;
	const hint = result.error === "notGranted" ? ` ${t("voice.settings.test.notGrantedHint")}` : result.error === "http" ? ` ${t("voice.settings.test.volcHint")}` : "";
	return `${base}（${statusCode}${serverMessage ? ` ${serverMessage}` : ""}）${hint}`;
}
