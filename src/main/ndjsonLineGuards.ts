/**
 * stdio NDJSON JSON-RPC 传输的共享护栏（pi RPC 与 ACP 同一套约束，数值刻意对齐）。
 *
 * - 大行延迟解析：超过阈值字符数的行延后到 setImmediate 再 JSON.parse，避免 stdout
 *   data 回调里同步 parse 巨型响应堵住主进程事件循环。
 * - 单行硬上限：无 LF 的失控输出（启动脚本打印二进制/死循环刷屏）会让行缓冲无界增长；
 *   上限取大行解析阈值的 32 倍——正常大响应（如 get_entries 全量历史）远小于此，
 *   超限即视为 stdout 已被污染，按协议错误结算。
 *
 * 消费方：src/main/pi/PiRpcClient.ts（pi RPC）、src/main/acp/AcpConnection.ts（ACP）。
 * 两侧保留各自的旧名 re-export（*_RPC_* / *_ACP_*），测试与调用方不需要改。
 */

/** 大行延迟解析阈值（字符数）。 */
export const LARGE_NDJSON_LINE_PARSE_CHARS = 256 * 1024;

/** 单行缓冲硬上限（字节）。 */
export const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
