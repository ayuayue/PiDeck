import { readFileSync } from "node:fs";

const styleSources = ["src/renderer/src/styles/foundation.css", "src/renderer/src/styles/timeline.css", "src/renderer/src/styles/surfaces.css", "src/renderer/src/styles/integrations.css", "src/renderer/src/styles/workspace.css", "src/renderer/src/styles/streamdownChrome.css"];

/**
 * Returns renderer CSS in cascade order so source-contract tests remain valid
 * when a domain moves out of the root stylesheet.
 */
export function readRendererStyles() {
	return styleSources.map((filePath) => readFileSync(filePath, "utf8")).join("");
}
