import { t } from "../../i18n";
import { PiLogoCanvas } from "./PiLogoCanvas";
import { PiTuiLogoCanvas, PiTuiLogoMark, useBrandGlyph } from "./PiTuiLogo";

type BuiltinLogoMarkProps = {
	style: "classic" | "pi-tui";
	size: number;
	playOnClick?: boolean;
	variant?: "icon" | "inline";
};

/** 图标使用白底与 65% 主体；标题栏 inline 只展示主体，融入所在表面。 */
export function BuiltinLogoMark({ style, size, playOnClick = false, variant = "icon" }: BuiltinLogoMarkProps) {
	const framed = variant === "icon";
	const glyph = framed ? size * 0.65 : size;
	const mark = playOnClick ? (
		style === "pi-tui" ? (
			<PiTuiLogoCanvas size={glyph} playOnClick />
		) : (
			<PiLogoCanvas size={glyph} playOnClick foreground={framed ? "ink" : undefined} />
		)
	) : style === "pi-tui" ? (
		<PiTuiLogoMark size={glyph} />
	) : (
		<svg viewBox="165.29 165.29 469.43 469.43" width={glyph} height={glyph} fill={framed ? "#18181b" : "currentColor"} aria-hidden="true">
			<path fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
			<path d="M517.36 400H634.72V634.72H517.36Z" />
		</svg>
	);
	return (
		<div className={`logo-mark relative grid shrink-0 place-items-center ${framed ? "bg-white shadow-sm ring-1 ring-black/10" : "text-foreground"}`} style={{ width: size, height: size, borderRadius: framed ? (size * 228) / 1024 : undefined }} aria-label={t("app.logoLabel")}>
			{mark}
		</div>
	);
}

/** 应用品牌位统一入口；自定义图片自带外形，保持原比例且不叠底板。 */
export function LogoMark({ size = 32, playOnClick = false, variant = "icon" }: { size?: number; playOnClick?: boolean; variant?: "icon" | "inline" } = {}) {
	const { style: logoStyle, customLogo } = useBrandGlyph();
	if (customLogo) return <img src={customLogo} alt="" width={size} height={size} className="logo-mark shrink-0 object-contain" style={{ width: size, height: size }} />;
	return <BuiltinLogoMark style={logoStyle} size={size} playOnClick={playOnClick} variant={variant} />;
}
