/**
 * JumpingSpiderLogo — 应用内品牌标，与系统图标 `build/icon.svg` 同一几何跳蛛。
 *
 * 正式标是带圆角黑底的整枚图标，不是旧卡通线稿；侧栏/Web 字标旁用整枚标，
 * 避免再画一套剪影导致任务栏和应用内两套脸。
 * 资源走 Vite 打包（`new URL`），不要内联 1024 的 data-URI。
 */
import { brandMarkSrc } from "./brandMark";

export function JumpingSpiderLogo(props: { className?: string }) {
	return <img src={brandMarkSrc} alt="" className={props.className} aria-hidden="true" draggable={false} />;
}
