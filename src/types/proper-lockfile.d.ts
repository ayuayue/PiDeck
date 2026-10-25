/** proper-lockfile 4.x 未自带类型（pi 依赖链里的传递依赖）；只声明本项目用到的 API。 */
declare module "proper-lockfile" {
	export type LockOptions = {
		/** 不对 lock 目标做 realpath；必须与 pi 保持一致（settings-manager.js 传 false）。 */
		realpath?: boolean;
		retries?: number | { retries?: number; minTimeout?: number; maxTimeout?: number; factor?: number };
		stale?: number;
		lockfilePath?: string;
	};
	export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	export function lockSync(file: string, options?: LockOptions): () => void;
	const lockfile: { lock: typeof lock; lockSync: typeof lockSync };
	export default lockfile;
}
