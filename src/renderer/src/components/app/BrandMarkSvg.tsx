/**
 * BrandMarkSvg — 启动页 / preload 失败页用的几何跳蛛标。
 *
 * 不用系统 PNG：圆角透明边会在浅色启动底上漏出白隙，且标内字标
 * 缩到小尺寸后看不清。这里用铺满圆角方的矢量，字标放在图标外放大。
 */
export function BrandMarkSvg(props: { className?: string; size?: number }) {
	const size = props.size ?? 120;
	return (
		<svg viewBox="0 0 120 120" width={size} height={size} className={props.className} aria-hidden="true">
			<defs>
				<linearGradient id="brand-mark-svg-bg" x1="0" y1="0" x2="1" y2="1">
					<stop stopColor="#161719" />
					<stop offset="0.58" stopColor="#050506" />
					<stop offset="1" stopColor="#000000" />
				</linearGradient>
				<linearGradient id="brand-mark-svg-shine" x1="0.3" y1="0" x2="0.7" y2="1">
					<stop stopColor="#ffffff" stopOpacity="0.16" />
					<stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
				</linearGradient>
			</defs>
			{/* 铺满 viewBox，浅色启动底上看不到圆角外的白隙 */}
			<rect width="120" height="120" rx="26" fill="url(#brand-mark-svg-bg)" />
			<rect width="120" height="58" rx="26" fill="url(#brand-mark-svg-shine)" />
			<g fill="#f4f4f5">
				{/* 头胸部 + 腹部：俯视几何跳蛛，不把字标画进图标里 */}
				<ellipse cx="60" cy="50" rx="17" ry="15" />
				<ellipse cx="60" cy="72" rx="11" ry="13" />
				{/* 八条尖角腿：前长后短，贴近正式标的放射结构 */}
				<path d="M47 40 24 16 34 14 54 38Z" />
				<path d="M43 48 12 34 20 28 46 46Z" />
				<path d="M43 60 12 76 20 82 46 62Z" />
				<path d="M49 70 28 98 38 100 56 72Z" />
				<path d="M73 40 96 16 86 14 66 38Z" />
				<path d="M77 48 108 34 100 28 74 46Z" />
				<path d="M77 60 108 76 100 82 74 62Z" />
				<path d="M71 70 92 98 82 100 64 72Z" />
			</g>
		</svg>
	);
}
