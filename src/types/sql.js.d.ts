declare module "sql.js" {
	interface SqlJsStatic {
		Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
	}

	// 参数与单元格值一律 unknown：SQL 绑定参数/结果列都是外部数据，由调用方收窄
	interface Database {
		run(sql: string, params?: unknown[]): Database;
		exec(sql: string, params?: unknown[]): QueryExecResult[];
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	interface Statement {
		run(params?: unknown[]): Statement;
		/** 步进一行；有数据返回 true（游标到尾返回 false）。 */
		step(): boolean;
		/** 取当前行（列名 → 值）；必须在 step() 返回 true 后调用。 */
		getAsObject(): Record<string, unknown>;
		free(): boolean;
	}

	interface QueryExecResult {
		columns: string[];
		values: unknown[][];
	}

	interface SqlJsConfig {
		locateFile?: (file: string) => string;
	}

	export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
