/**
 * WebBrandLockup — Web 端品牌区（与桌面 AppParts.BrandLockup 同视觉）。
 *
 * 不直接复用 AppParts.BrandLockup 是为了避免把桌面端整棵渲染组件树
 * （SurfaceComponents / atoms / desktopApi 等）拖进 Web 包；这里只复用
 * 自包含的 PiLogoCanvas / PiTuiLogoCanvas（React hooks + jotai atom + CSS
 * 变量，无桌面依赖）。Web 独立环境无人写 logoStyleAtom → 恒取 atom 默认
 * 风格（pi-tui 三色像素标），桌面默认换风格时 Web 品牌位跟着走。
 */
import { PiLogoCanvas } from "../components/app/PiLogoCanvas";
import { PiTuiLogoCanvas, useLogoStyle } from "../components/app/PiTuiLogo";

export function WebBrandLockup() {
	const logoStyle = useLogoStyle();
	return (
		<div className="brand-lockup flex h-9 min-w-0 items-center gap-2" aria-label="PiDeck">
			{logoStyle === "pi-tui" ? <PiTuiLogoCanvas size={18} playOnClick /> : <PiLogoCanvas size={18} playOnClick />}
			{/* 字标对齐桌面 AppParts.BrandLockup：18px DepartureMono 700 混合大小写。
			    早先 web 独有的 font-normal / uppercase / translate-x 视觉漂移已回收；
			    尾随的 mono 小徽标标明「远程 Web 面」——手机上看到的 PIDECK 与桌面同名，
			    靠它区分入口，也把品牌行右侧的留白用起来。 */}
			<span className="brand-wordmark truncate text-brand font-[PiDeckDepartureMono] font-bold leading-none text-foreground dark:text-white" aria-hidden="true">
				PiDeck
			</span>
			<span className="mt-px shrink-0 rounded border border-border-subtle bg-muted/50 px-1 py-px font-mono text-micro font-medium uppercase leading-[1.3] tracking-[0.08em] text-muted-foreground">Web</span>
		</div>
	);
}
