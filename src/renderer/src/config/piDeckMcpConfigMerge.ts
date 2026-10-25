/** Insert-only handoff: never overwrite an inherited or locally configured service. */
import type { McpConfigFile, McpServerDefinition } from "../../../shared/types/mcp";

export function addPiDeckMcpDefinition(current: McpConfigFile, existingNames: ReadonlySet<string>, definition: McpServerDefinition): McpConfigFile | null {
	if (existingNames.has("pideck") || Object.hasOwn(current.mcpServers ?? {}, "pideck")) return null;
	return { ...current, mcpServers: { ...current.mcpServers, pideck: { ...definition, enabled: false } } };
}
