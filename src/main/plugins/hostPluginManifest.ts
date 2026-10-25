/** Validates the small, browser-only v1 plugin contract; unknown capabilities fail closed. */
import type { HostPluginManifest, HostPluginPanelPresentation, HostPluginPermission } from "../../shared/types/hostPlugin";
import { isHostPluginPanelIconName } from "../../shared/hostPluginIcons";
import { isLocalServiceId } from "../../shared/localServices";
import { parseHostPluginNetworkPolicy } from "./hostPluginNetworkPolicy";

export function isPluginRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHostPluginId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 80;
}

export function isHostPluginAsset(value: unknown): value is string {
	return typeof value === "string" && value.length <= 240 && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith("/") && value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0);
}

function label(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value);
}

const HOST_PLUGIN_PERMISSIONS = new Set<string>(["sessions.read", "workbench.navigate", "workbench.openExternal", "network.https", "network.local", "service.local"]);
/** 权限白名单校验：manifest 解析与管理入口（脚手架）共用同一份，保证两边不会拒/收不一致。 */
export const isHostPluginPermission = (value: unknown): value is HostPluginPermission => typeof value === "string" && HOST_PLUGIN_PERMISSIONS.has(value);

/**
 * `services` 只允许点名 PiDeck 已实现的本地服务（shared/localServices 白名单），
 * 与 `service.local` 权限互为必需：声明了权限就必须给服务列表，反之亦然。
 * 插件提供不了命令/参数/端口，因此这份列表不构成「执行任意命令」的能力面。
 */
function parseHostPluginServices(value: unknown, permissions: HostPluginPermission[]): string[] | undefined {
	const declared = permissions.includes("service.local");
	if (value === undefined) {
		if (declared) throw new Error("invalid-services");
		return undefined;
	}
	if (!declared || !Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("invalid-services");
	if (!value.every(isLocalServiceId) || new Set(value).size !== value.length) throw new Error("invalid-services");
	return [...value];
}

/** Returns a newly constructed manifest instead of trusting properties from JSON. */
export function parseHostPluginManifest(value: unknown): HostPluginManifest {
	if (!isPluginRecord(value) || value.schemaVersion !== 1 || value.apiVersion !== 1 || !isHostPluginId(value.id) || !label(value.name) || !label(value.version)) throw new Error("invalid-manifest");
	if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1000)) throw new Error("invalid-manifest");
	if (!Array.isArray(value.permissions) || !value.permissions.every(isHostPluginPermission) || new Set(value.permissions).size !== value.permissions.length) throw new Error("unsupported-permission");
	const permissions = value.permissions.filter(isHostPluginPermission);
	const services = parseHostPluginServices(value.services, permissions);
	const network = parseHostPluginNetworkPolicy(value.network, permissions);
	const contributes = value.contributes;
	if (!isPluginRecord(contributes) || !Array.isArray(contributes.panels) || contributes.panels.length < 1 || contributes.panels.length > 8 || !Array.isArray(contributes.commands) || contributes.commands.length > 16) throw new Error("invalid-contributions");
	const panels = contributes.panels.map((panel) => {
		// icon/presentation 可选：icon 必须在白名单内；presentation 只接受 modal|page|popover，未知值 fail-closed 拒装（缺省 modal，旧包不带此字段）。
		if (!isPluginRecord(panel) || !isHostPluginId(panel.id) || !label(panel.title) || !isHostPluginAsset(panel.entry) || !panel.entry.endsWith(".html")) throw new Error("invalid-panel");
		if (panel.icon !== undefined && !isHostPluginPanelIconName(panel.icon)) throw new Error("invalid-panel-icon");
		let presentation: HostPluginPanelPresentation | undefined;
		if (panel.presentation === "modal" || panel.presentation === "page" || panel.presentation === "popover") presentation = panel.presentation;
		else if (panel.presentation !== undefined) throw new Error("invalid-panel-presentation");
		return { id: panel.id, title: panel.title, entry: panel.entry, ...(panel.icon !== undefined ? { icon: panel.icon } : {}), ...(presentation !== undefined ? { presentation } : {}) };
	});
	if (new Set(panels.map((panel) => panel.id)).size !== panels.length) throw new Error("duplicate-panel");
	const commands = contributes.commands.map((command) => {
		if (!isPluginRecord(command) || !isHostPluginId(command.id) || !label(command.title) || typeof command.panelId !== "string" || !panels.some((panel) => panel.id === command.panelId)) throw new Error("invalid-command");
		return { id: command.id, title: command.title, panelId: command.panelId };
	});
	if (new Set(commands.map((command) => command.id)).size !== commands.length) throw new Error("duplicate-command");
	return { schemaVersion: 1, apiVersion: 1, id: value.id, name: value.name, version: value.version, description: value.description, permissions, ...(services ? { services } : {}), ...(network ? { network } : {}), contributes: { panels, commands } };
}
