import { t } from "../../i18n";
import { PiTuiLogoMark, useBrandGlyph } from "./PiTuiLogo";

/**
 * π 品牌标。默认 32（错误页）；起始页 / 空态可放大。
 * logoStyle 分支：classic = 银灰拼图 π；pi-tui = pi 官方 TUI 三色像素标；custom = 用户自备图片。
 * classic / pi-tui 共用黑底容器与同一内框占比（glyph = 56.25%），切换风格不改变占位。
 * custom 不套黑底：用户上传的图多半自带底色/外形（如应用图标），再垫一层黑方块会变成双层嵌套，且与「上传什么就显示什么」不符。
 * 独立成文件，避免 Web 空态为了 LogoMark 拖进整棵会话组件树。
 */
export function LogoMark({ size = 32 }: { size?: number } = {}) {
	const { style: logoStyle, customLogo } = useBrandGlyph();
	// 自定义图直接铺满外框（object-contain 保比例），黑底容器只服务内置两种标
	if (customLogo) return <img src={customLogo} alt="" width={size} height={size} className="logo-mark shrink-0 object-contain" style={{ width: size, height: size }} />;
	const glyph = Math.round(size * 0.5625); // 位图为 1:1 正方形，宽度与 classic glyph 对齐
	return (
		<div className="logo-mark relative grid place-items-center overflow-hidden rounded-md bg-black text-white shadow-sm ring-1 ring-white/15" style={{ width: size, height: size }} aria-label={t("app.logoLabel")}>
			{logoStyle === "pi-tui" ? (
				/* pi 官方 TUI logo：4×4 像素位图（1:1 正方形），宽度与 classic glyph 一致，品牌色固定不随主题变 */
				<PiTuiLogoMark size={glyph} />
			) : (
				<svg viewBox="140 140 520 520" width={glyph} height={glyph} aria-hidden="true">
					<defs>
						<linearGradient id="logo-mark-silver" x1="0.2" y1="0" x2="0.8" y2="1">
							<stop stopColor="#ffffff" />
							<stop offset="0.5" stopColor="#f4f4f5" />
							<stop offset="1" stopColor="#a7a8ab" />
						</linearGradient>
					</defs>
					<path fill="url(#logo-mark-silver)" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
					<path fill="url(#logo-mark-silver)" d="M517.36 400H634.72V634.72H517.36Z" />
				</svg>
			)}
		</div>
	);
}
