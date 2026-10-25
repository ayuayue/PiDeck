import rawDefinitions from "./definitions.json" with { type: "json" };
import rawIcons from "./icons.json" with { type: "json" };

export type SetiIconColor = "blue" | "grey" | "grey-light" | "green" | "orange" | "pink" | "purple" | "red" | "white" | "yellow" | "ignore";

type IconDetails = readonly [icon: string, color: SetiIconColor];
type SetiDefinitions = {
	files: Readonly<Record<string, IconDetails>>;
	extensions: Readonly<Record<string, IconDetails>>;
	partials: ReadonlyArray<readonly [needle: string, details: IconDetails]>;
	default: IconDetails;
};

// JSON 导入会被 TypeScript 推断为可变 string[]；数据快照由专项测试验证后在此收窄为只读映射结构。
const definitions = rawDefinitions as unknown as SetiDefinitions;
const icons = rawIcons as Record<string, string>;
const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

function getDetails(fileName: string): IconDetails {
	if (hasOwn(definitions.files, fileName)) return definitions.files[fileName];

	// Multi-part mappings such as `.spec.tsx` take priority before the final `.tsx` suffix.
	for (let dot = fileName.indexOf("."); dot !== -1; dot = fileName.indexOf(".", dot + 1)) {
		const extension = fileName.slice(dot);
		if (hasOwn(definitions.extensions, extension)) {
			return definitions.extensions[extension];
		}
	}

	for (const [needle, details] of definitions.partials) {
		if (fileName.includes(needle)) return details;
	}
	return definitions.default;
}

/** Returns a trusted, bundled Seti SVG and its semantic color name. */
export function getSetiIcon(fileName: string): { svg: string; color: SetiIconColor } {
	const [iconName, color] = getDetails(fileName);
	return {
		svg: icons[iconName] ?? icons[definitions.default[0]],
		color,
	};
}
