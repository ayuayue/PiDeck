/**
 * 文件图标映射模块
 * 使用本地许可的 Seti-UI 数据快照（VS Code Seti 主题同源图标）。
 */
import { getSetiIcon, type SetiIconColor } from "./vendor/seti-icons";

const SETI_COLOR_TO_CSS: Record<SetiIconColor, string> = {
	blue: "var(--file-icon-blue)",
	grey: "var(--file-icon-grey)",
	"grey-light": "var(--file-icon-grey-light)",
	green: "var(--file-icon-green)",
	orange: "var(--file-icon-orange)",
	pink: "var(--file-icon-pink)",
	purple: "var(--file-icon-purple)",
	red: "var(--file-icon-red)",
	white: "var(--file-icon-white)",
	yellow: "var(--file-icon-yellow)",
	ignore: "var(--file-icon-ignore)",
};

export function getFileIconSeti(fileName: string): { svg: string; colorName: SetiIconColor } {
	const result = getSetiIcon(fileName);
	return { svg: result.svg, colorName: result.color };
}

export function getFileIconColor(colorName: SetiIconColor): string {
	return SETI_COLOR_TO_CSS[colorName];
}

export function getFileTypeLabel(fileName: string): string {
	const base = fileName.split("/").pop()?.split("\\").pop() ?? fileName;
	const normalizedBase = base.toLowerCase();
	const special: Record<string, string> = {
		"package.json": "npm",
		"tsconfig.json": "TS Config",
		dockerfile: "Docker",
		"readme.md": "README",
		license: "LICENSE",
		".gitignore": "Git",
		".env": "ENV",
	};
	if (normalizedBase in special) return special[normalizedBase];

	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return "FILE";
	const ext = base.slice(dot).toLowerCase();
	const labels: Record<string, string> = {
		".ts": "TypeScript",
		".tsx": "React TSX",
		".js": "JavaScript",
		".jsx": "React JSX",
		".css": "CSS",
		".scss": "SCSS",
		".html": "HTML",
		".md": "Markdown",
		".json": "JSON",
		".yaml": "YAML",
		".yml": "YAML",
		".py": "Python",
		".go": "Go",
		".rs": "Rust",
		".java": "Java",
		".rb": "Ruby",
		".php": "PHP",
		".sh": "Shell",
		".sql": "SQL",
		".svg": "SVG",
		".xml": "XML",
		".png": "PNG",
		".jpg": "JPEG",
		".gif": "GIF",
		".mp4": "MP4",
		".mp3": "MP3",
		".zip": "ZIP",
		".ttf": "TTF",
		".woff2": "WOFF2",
	};
	return labels[ext] ?? ext.slice(1).toUpperCase();
}
