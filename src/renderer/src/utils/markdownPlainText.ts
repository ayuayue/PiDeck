import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm).freeze();
const tableDividers = { center: ":---:", left: ":---", right: "---:" };
type MarkdownNode = ReturnType<typeof parser.parse>["children"][number];

/** Preserve the line spacing between blocks after removing their Markdown syntax. */
function renderBlocks(nodes: readonly MarkdownNode[], indentNestedLists = false): string {
	let text = "";
	let previousEnd: number | undefined;
	for (const node of nodes) {
		let block = renderNode(node);
		if (!block) continue;
		if (indentNestedLists && node.type === "list") block = block.replace(/^/gm, "  ");
		if (previousEnd !== undefined && node.position) {
			text += "\n".repeat(Math.max(1, node.position.start.line - previousEnd));
		} else if (text) {
			text += "\n";
		}
		text += block;
		previousEnd = node.position?.end.line;
	}
	return text;
}

/** Render link labels as inline text and keep literal brackets from the parsed text nodes. */
function renderNode(node: MarkdownNode): string {
	switch (node.type) {
		case "text":
		case "inlineCode":
		case "code":
			return node.value;
		case "image":
		case "imageReference":
			return node.alt ?? "";
		case "html":
			return node.value.replace(/<[^>]*>/g, "");
		case "break":
			return "\n";
		case "blockquote":
		case "list":
			return renderBlocks(node.children);
		case "listItem": {
			const text = renderBlocks(node.children, true);
			return node.checked == null ? text : `${node.checked ? "[x]" : "[ ]"} ${text}`;
		}
		case "table": {
			const [header, ...rows] = node.children.map(renderNode);
			const divider = node.align?.map((alignment) => (alignment ? tableDividers[alignment] : "---"));
			return [header, divider && `| ${divider.join(" | ")} |`, ...rows].filter(Boolean).join("\n");
		}
		case "tableRow":
			return `| ${node.children.map(renderNode).join(" | ")} |`;
		default:
			return "children" in node && node.type !== "footnoteDefinition" ? node.children.map(renderNode).join("") : "";
	}
}

/** Convert chat Markdown to readable plain text for copying and previews. */
export function stripMarkdown(text: string): string {
	return renderBlocks(parser.parse(text).children);
}
