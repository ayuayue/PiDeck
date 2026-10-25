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
		<div className="brand-lockup flex h-9 min-w-0 items-center gap-2.5" aria-label="PiDeck">
			{logoStyle === "pi-tui" ? <PiTuiLogoCanvas size={18} playOnClick /> : <PiLogoCanvas size={18} playOnClick />}
			<span className="brand-wordmark translate-x-0.5 truncate text-brand font-[PiDeckDepartureMono] font-normal uppercase leading-none text-zinc-950 dark:text-white" aria-hidden="true">
				PiDeck
			</span>
		</div>
	);
}
