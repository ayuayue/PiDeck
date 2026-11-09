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
			    「WEB」只留一行 mono 小字，不加边框底盒——徽标、字标、关闭钮同处一条
			    44px 品牌行，多一个框只会和下方搜索框/按钮抢层级。 */}
			<span className="brand-wordmark truncate text-brand font-[PiDeckDepartureMono] font-bold leading-none text-foreground dark:text-white" aria-hidden="true">
				PiDeck
			</span>
			<span className="shrink-0 font-mono text-micro font-medium uppercase leading-none tracking-[0.08em] text-muted-foreground" aria-hidden="true">
				Web
			</span>
		</div>
	);
}
