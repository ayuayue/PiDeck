import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { deepEqual } from "../utils/deepEqual";
import { getProviderHeaders } from "./providerHeaders";
import { createDshHeaderRows, serializeDshHeaderRows, updateDshHeaderRow, type DshHeaderRow } from "./dshHeaderRows";

/** DSH profile.headers 的行编辑器；自动会话头由请求层提供，这里只保存显式覆盖。 */
export function DshHeadersEditor(props: { value: unknown; onChange: (next: Record<string, string> | undefined) => void; writable: boolean }) {
	const [rows, setRows] = useState(() => createDshHeaderRows(props.value));
	const lastValue = useRef(getProviderHeaders(props.value));
	useEffect(() => {
		const incoming = getProviderHeaders(props.value);
		// 父级回显自己的修改不能重建行：否则改名会丢焦点，临时清空名称也会丢掉整行。
		// 真正的外部刷新才重建本地草稿（含从无配置恢复为有配置）。
		if (!deepEqual(incoming, lastValue.current)) {
			setRows(createDshHeaderRows(incoming));
			lastValue.current = incoming;
		}
	}, [props.value]);

	/** 行身份只在创建时分配；序列化不 trim 值，以保留空串等显式覆盖。 */
	const commit = (next: DshHeaderRow[]) => {
		if (!props.writable) return;
		setRows(next);
		const headers = serializeDshHeaderRows(next);
		lastValue.current = headers;
		props.onChange(headers);
	};
	const addHeader = (name?: string) => {
		// 快捷项已存在时不清空用户的值，大小写不同也视为同一 HTTP 头。
		if (name && rows.some((row) => row.name.trim().toLowerCase() === name)) return;
		const [row] = createDshHeaderRows({ [name ?? "X-Custom-Header"]: "" });
		commit([...rows, name ? row : { ...row, name: "" }]);
	};

	return (
		<div className="grid min-w-0 gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="text-caption font-medium text-foreground">{t("config.dsh.field.headers")}</span>
				<div className="flex flex-wrap items-center gap-1">
					<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-micro" disabled={!props.writable} onClick={() => addHeader("x-opencode-session")}>
						{t("config.dsh.addOpencodeSession")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-micro" disabled={!props.writable} onClick={() => addHeader()}>
						<Plus className="size-3" aria-hidden="true" />
						{t("config.dsh.addHeader")}
					</Button>
				</div>
			</div>
			<p className="text-micro text-muted-foreground">{t("config.dsh.headersAutomaticHint")}</p>
			{/* DSH 在进入 pi-ai 前强制 attribution UA，不能提供实际上不会生效的 pi UA 预设。 */}
			<p className="text-micro text-muted-foreground">{t("config.dsh.headersUserAgentHint")}</p>
			{rows.length === 0 && <p className="text-micro text-muted-foreground">{t("config.dsh.customHeadersEmpty")}</p>}
			{rows.map((row) => (
				<div key={row.id} className="flex min-w-0 items-center gap-1.5">
					<Input size="sm" className="min-w-0 flex-1 font-mono text-micro" value={row.name} placeholder={t("config.dsh.headerNamePlaceholder")} disabled={!props.writable} onChange={(event) => commit(updateDshHeaderRow(rows, row.id, { name: event.target.value }))} aria-label={t("config.dsh.headerNamePlaceholder")} />
					<Input
						size="sm"
						className="min-w-0 flex-1 font-mono text-micro"
						value={row.value}
						placeholder={t("config.dsh.headerValuePlaceholder")}
						disabled={!props.writable}
						onChange={(event) => commit(updateDshHeaderRow(rows, row.id, { value: event.target.value }))}
						aria-label={t("config.dsh.headerValuePlaceholder")}
					/>
					<Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0 text-muted-foreground hover:text-danger" disabled={!props.writable} title={t("common.delete")} aria-label={t("common.delete")} onClick={() => commit(rows.filter((candidate) => candidate.id !== row.id))}>
						<Trash2 className="size-3" aria-hidden="true" />
					</Button>
				</div>
			))}
		</div>
	);
}
