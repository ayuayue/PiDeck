import { Button } from "../components/ui-shadcn/button";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { Input } from "../components/ui-shadcn/input";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";

/**
 * trust.json 结构：{ "C:\\Users": true, "D:\\project": false }
 * true = 已信任，false = 显式不信任（忽略）
 */
export type TrustFile = Record<string, boolean>;

export function TrustTab(props: { data: TrustFile; saving: boolean; onChange: (data: TrustFile) => void; onSave: () => void }) {
	const [addPath, setAddPath] = useState("");
	const entries = Object.entries(props.data).sort(([left], [right]) => left.localeCompare(right));

	const addEntry = () => {
		// trust.json 由 pi 读取，保留用户输入的原生路径分隔符，仅去掉末尾多余斜杠。
		const path = addPath.trim().replace(/[\\/]+$/, "");
		if (!path) return;
		props.onChange({ ...props.data, [path]: true });
		setAddPath("");
	};

	const toggleEntry = (path: string, trusted: boolean) => {
		props.onChange({ ...props.data, [path]: trusted });
	};

	const removeEntry = (path: string) => {
		const next = { ...props.data };
		delete next[path];
		props.onChange(next);
	};

	return (
		<div className="config-trust-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				<div>
					<strong>{t("config.nav.trust")}</strong>
					<p>{t("config.trust.hint")}</p>
				</div>
			</div>

			<div className="config-trust-add">
				<Input
					className="config-trust-input"
					type="text"
					value={addPath}
					onChange={(e) => setAddPath(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") addEntry();
					}}
					placeholder={t("config.trust.addPlaceholder")}
				/>
				<Button size="sm" variant="outline" onClick={addEntry} disabled={!addPath.trim() || props.saving}>
					<Plus size={14} />
					{t("config.trust.add")}
				</Button>
			</div>

			{entries.length === 0 ? (
				<div className="config-trust-empty">
					<strong>{t("config.trust.emptyTitle")}</strong>
					<span>{t("config.trust.emptyDesc")}</span>
				</div>
			) : (
				<div className="config-trust-list">
					{entries.map(([path, trusted]) => (
						<div key={path} className="config-trust-row" data-trusted={trusted || undefined}>
							<Label className="config-trust-toggle">
								<Checkbox checked={trusted} onCheckedChange={(checked) => toggleEntry(path, checked === true)} />
								<span className="config-trust-path" title={path}>
									{path}
								</span>
								<span className="config-trust-status">{trusted ? t("config.trust.statusTrusted") : t("config.trust.statusIgnored")}</span>
							</Label>
							<Button variant="outline" size="sm" className="text-destructive" title={t("common.delete")} onClick={() => removeEntry(path)} disabled={props.saving}>
								<Trash2 size={13} />
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
