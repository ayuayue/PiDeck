/**
 * js-yaml 模块声明（第三方包无内置类型；仅声明本应用使用到的 load）。
 * 用途：主进程读取 DSH 凭证文档（$DSH_HOME/.credentials.yaml，严格 ref→value 映射）。
 */
declare module "js-yaml" {
	export class Type {
		constructor(tag: string, options: { kind: "scalar"; construct: (value: unknown) => unknown; predicate: (value: unknown) => boolean; represent: (value: unknown) => string });
	}
	export interface Schema {
		extend(type: Type): Schema;
	}
	export const DEFAULT_SCHEMA: Schema;
	export function load(text: string, options?: { schema?: Schema }): unknown;
	export function dump(
		value: unknown,
		options?: {
			schema?: Schema;
			lineWidth?: number;
			noRefs?: boolean;
			quotingType?: "'" | '"';
			sortKeys?: boolean;
		},
	): string;
}
