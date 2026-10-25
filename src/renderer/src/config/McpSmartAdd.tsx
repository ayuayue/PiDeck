/**
 * MCP 智能添加面板（docs/mcp-config-ux-redesign.md A 片）。
 *
 * 一个粘贴框认三种输入（URL / 命令行 / JSON 片段），识别结果即时预览、名称可改；
 * 「添加并保存」把条目写入草稿并触发保存 + 自动检测（检测在父层 save 成功后执行）。
 * 「手动配置」退回旧的类型选择表单（保留高级能力，不走智能识别）。
 */

import { useMemo, useState } from "react";
import { Bot, FileJson, Globe, Plus, Terminal } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { parseSmartAddInput, suggestNameFromCommand, suggestNameFromDefinition, suggestNameFromUrl, uniqueServerName, type SmartAddParse } from "./mcpForm";
import type { McpServerDefinition } from "../../../shared/types/mcp";

export type SmartAddEntry = { name: string; definition: McpServerDefinition };

/** 由识别结果生成待添加条目：URL/命令补建议名，JSON 用键名并去重。 */
function buildEntries(parse: SmartAddParse, nameOverride: string | null, existingNames: ReadonlySet<string>): SmartAddEntry[] {
	if (parse.kind === "json") {
		return parse.servers.map((server) => {
			const base = server.name || suggestNameFromDefinition(server.definition) || "server";
			return { name: uniqueServerName(base, existingNames), definition: server.definition };
		});
	}
	if (parse.kind === "url") {
		const base = nameOverride ?? suggestNameFromUrl(parse.url);
		return [{ name: uniqueServerName(base, existingNames), definition: { url: parse.url } }];
	}
	const base = nameOverride ?? suggestNameFromCommand(parse.command, parse.args);
	const definition: McpServerDefinition = parse.args.length > 0 ? { command: parse.command, args: parse.args } : { command: parse.command };
	return [{ name: uniqueServerName(base, existingNames), definition }];
}

type SmartAddLabelKey = "config.mcp.smartAdd.kindUrl" | "config.mcp.smartAdd.kindCommand" | "config.mcp.smartAdd.kindJson";
const KIND_BADGE: Record<"url" | "command" | "json", { icon: typeof Globe; labelKey: SmartAddLabelKey }> = {
	url: { icon: Globe, labelKey: "config.mcp.smartAdd.kindUrl" },
	command: { icon: Terminal, labelKey: "config.mcp.smartAdd.kindCommand" },
	json: { icon: FileJson, labelKey: "config.mcp.smartAdd.kindJson" },
};

export function McpSmartAdd(props: { existingNames: ReadonlySet<string>; disabled?: boolean; onAdd: (entries: SmartAddEntry[]) => void; onManual: () => void; onInstallAiSetupSkill: () => Promise<boolean> }) {
	const [raw, setRaw] = useState("");
	const [nameOverride, setNameOverride] = useState<string | null>(null);
	const [aiSetupState, setAiSetupState] = useState<"idle" | "installing" | "installed" | "failed">("idle");
	const parse = useMemo(() => parseSmartAddInput(raw), [raw]);
	const entries = useMemo(() => (parse ? buildEntries(parse, nameOverride, props.existingNames) : []), [parse, nameOverride, props.existingNames]);
	const badge = parse ? KIND_BADGE[parse.kind] : null;
	// 名称输入框只在单条（URL/命令）时出现；JSON 多条直接用键名去重
	const singleEntry = parse && parse.kind !== "json" ? entries[0] : null;

	const add = () => {
		if (entries.length === 0) return;
		props.onAdd(entries);
		setRaw("");
		setNameOverride(null);
	};

	return (
		<div className="flex flex-col gap-2.5 rounded-md border border-border-subtle bg-bg-panel p-3">
			<div>
				<div className="text-control font-medium">{t("config.mcp.smartAdd.title")}</div>
				<p className="mt-0.5 text-micro text-muted-foreground">{t("config.mcp.smartAdd.hint")}</p>
				<p className="text-micro text-muted-foreground">{t("config.mcp.smartAdd.authHint")}</p>
				<p className="text-micro text-muted-foreground">{t("config.mcp.secretStorageHint")}</p>
			</div>
			<Input
				value={raw}
				onChange={(event) => {
					setRaw(event.target.value);
					setNameOverride(null);
				}}
				disabled={props.disabled}
				className="h-9 font-mono"
				placeholder={t("config.mcp.smartAdd.placeholder")}
			/>
			{parse && badge ? (
				<div className="flex flex-wrap items-center gap-2 rounded-sm border border-border-subtle bg-bg-hover px-2.5 py-2 text-control">
					<span className="flex items-center gap-1.5 rounded-sm border border-border-subtle px-1.5 py-0.5 text-micro text-muted-foreground">
						<badge.icon size={12} aria-hidden="true" />
						{parse.kind === "json" ? t("config.mcp.smartAdd.kindJsonCount", { count: parse.servers.length }) : t(badge.labelKey)}
					</span>
					<span className="truncate font-mono text-micro">{parse.kind === "url" ? parse.url : parse.kind === "command" ? [parse.command, ...parse.args].join(" ") : parse.servers.map((server) => server.name).join(", ")}</span>
				</div>
			) : raw.trim() ? (
				<p className="text-micro text-danger">{t("config.mcp.smartAdd.invalid")}</p>
			) : null}
			{singleEntry ? (
				<div className="grid gap-1">
					<Label className="text-micro text-muted-foreground">{t("config.mcp.smartAdd.nameLabel")}</Label>
					<Input value={singleEntry.name} onChange={(event) => setNameOverride(event.target.value)} disabled={props.disabled} className="h-8 font-mono" />
				</div>
			) : null}
			<div className="flex flex-wrap items-center gap-1.5">
				<Button size="sm" onClick={() => add()} disabled={!parse || entries.length === 0 || props.disabled}>
					<Plus size={14} />
					{t("config.mcp.smartAdd.addButton")}
				</Button>
				<Button variant="ghost" size="sm" onClick={props.onManual} disabled={props.disabled}>
					{t("config.mcp.smartAdd.manual")}
				</Button>
			</div>
			{/* AI 代配入口：不会配的用户交给会话里的 AI（技能教它查官方文档 + 写 mcp.json + 验证）。 */}
			<div className="mt-1 rounded-sm border border-border-subtle bg-bg-hover px-2.5 py-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-1.5">
						<Bot size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="text-control font-medium">{t("config.mcp.catalog.aiSetup.title")}</span>
					</div>
					<Button variant="outline" size="xs" disabled={props.disabled || aiSetupState === "installing"} onClick={() => void props.onInstallAiSetupSkill().then((ok) => setAiSetupState(ok ? "installed" : "failed"))}>
						{t("config.mcp.catalog.aiSetup.install")}
					</Button>
				</div>
				<p className="mt-1 text-micro text-muted-foreground">{t(aiSetupState === "installed" ? "config.mcp.catalog.aiSetup.installed" : aiSetupState === "failed" ? "config.mcp.catalog.aiSetup.failed" : "config.mcp.catalog.aiSetup.desc")}</p>
			</div>
		</div>
	);
}
