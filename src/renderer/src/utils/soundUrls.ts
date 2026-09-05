/**
 * 渲染层音效 URL 解析：
 * - 预设：Vite 打包的 asset URL（必须用「静态字符串 + new URL」才能被 Vite 静态分析，
 *   模板字符串/变量拼接会被打包成空对象，运行时 URL 失效）；
 * - 自定义：pideck-sound://custom/<文件名>（主进程协议白名单校验后读 userData/sounds）。
 * 与 shared/types/soundAlert.ts 的引用格式（预设 id / custom:<file>）一一对应。
 */
import {
	parseSoundAlertRef,
	type SoundAlertPresetId,
} from "../../../shared/types/soundAlert";

// 静态引用：Vite 会把每个 wav 复制进 assets/ 并替换为 hashed URL（见 electron-vite build 产物）
const PRESET_URLS: Record<SoundAlertPresetId, string> = {
	"done-chime": new URL("../assets/sounds/done-chime.wav", import.meta.url).href,
	"done-bell": new URL("../assets/sounds/done-bell.wav", import.meta.url).href,
	"done-pop": new URL("../assets/sounds/done-pop.wav", import.meta.url).href,
	"error-buzz": new URL("../assets/sounds/error-buzz.wav", import.meta.url).href,
	"error-alert": new URL("../assets/sounds/error-alert.wav", import.meta.url).href,
	"waiting-ping": new URL("../assets/sounds/waiting-ping.wav", import.meta.url).href,
	"waiting-knock": new URL("../assets/sounds/waiting-knock.wav", import.meta.url).href,
};

/** 音效引用 → 可播放 URL；引用非法/自定义文件名为空时返回 null（调用方应静默）。 */
export function resolveSoundUrl(soundId: string): string | null {
	const ref = parseSoundAlertRef(soundId);
	if (!ref) return null;
	if (ref.kind === "preset") return PRESET_URLS[ref.id];
	return `pideck-sound://custom/${encodeURIComponent(ref.file)}`;
}
