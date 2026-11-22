import { useId } from "react";
import { Folder, FolderOpen } from "lucide-react";

/**
 * 云朵轮廓（10 单位局部坐标）。整块放在 20 单位的槽位里，`BADGE_TRANSFORM` 把它落到
 * 文件夹图标的右下角——尺寸与位置按 lucide `Folder`/`FolderOpen` 在最外层 14px、槽位 20px
 * 时的实际几何推出来（图标横向 4.17→15.83、纵向 4.75→14.67），改图标尺寸时一起改这两个常量。
 */
const CLOUD_PATH = "M2.69 8.54C1.22 8.54.3 7.56.3 6.3c0-1.18.79-2.14 1.89-2.36.38-1.49 1.54-2.5 3.04-2.5 1.66 0 2.97 1.16 3.16 2.74 1 .24 1.61 1.03 1.61 2.07 0 1.3-1.02 2.29-2.32 2.29Z";
const BADGE_TRANSFORM = "translate(8.5 9) scale(.96)";

/**
 * 远端项目的文件夹图标：保留本机的开/合形态，右下角叠一个雾蓝色云朵角标。
 *
 * 只做识别，不承担连接状态（状态点由 `RemoteProjectHostTag` 单独在行尾）。两个细节：
 * - 云朵用 `<mask>` 抠出 1px 透明描边，而不是像旧地球角标那样垫一个 `bg-sidebar` 的圆盘。
 * 行会被 hover / 选中染成不同底色，透明镂空跟着行底色走，不会留一块对不上的圆片。
 * - `useId` 给 mask 生成实例级 id：侧栏同时挂很多个项目行，重复 id 会让后面的行拿到错的镂空。
 * `aria-hidden` 让读屏只读行内文字与状态标签。
 */
export function RemoteProjectFolderIcon(props: { collapsed: boolean }) {
	const Icon = props.collapsed ? Folder : FolderOpen;
	const maskId = useId();
	return (
		<span className="relative grid size-5 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
			<Icon size={14} />
			<svg viewBox="0 0 20 20" className="pointer-events-none absolute inset-0 size-5 text-info" fill="none">
				<mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20">
					<rect width="20" height="20" fill="white" />
					<path d={CLOUD_PATH} transform={BADGE_TRANSFORM} fill="black" stroke="black" strokeWidth={2} strokeLinejoin="round" />
				</mask>
				<path d={CLOUD_PATH} transform={BADGE_TRANSFORM} fill="currentColor" mask={`url(#${maskId})`} />
			</svg>
		</span>
	);
}
