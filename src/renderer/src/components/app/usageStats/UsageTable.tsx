/**
 * 用量明细表（模型/项目共用）：前 12 行 + 首列 title 全文。
 */

import { t } from "../../../i18n";

export function UsageTable(props: { headers: string[]; rows: string[][] }) {
	if (props.rows.length === 0) {
		return <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>;
	}
	return (
		<table className="usage-stats-table">
			<thead>
				<tr>
					{props.headers.map((h, i) => (
						<th key={i}>{h}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{props.rows.slice(0, 12).map((row, ri) => (
					<tr key={ri}>
						{row.map((cell, ci) => (
							<td key={ci} title={ci === 0 ? cell : undefined}>
								{cell}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
