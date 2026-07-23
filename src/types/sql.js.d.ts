declare module "sql.js" {
	interface SqlJsStatic {
		Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
	}

	interface Database {
		run(sql: string, params?: any[]): Database;
		exec(sql: string, params?: any[]): QueryExecResult[];
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	interface Statement {
		run(params?: any[]): Statement;
		free(): boolean;
	}

	interface QueryExecResult {
		columns: string[];
		values: any[][];
	}

	interface SqlJsConfig {
		locateFile?: (file: string) => string;
	}

	export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
