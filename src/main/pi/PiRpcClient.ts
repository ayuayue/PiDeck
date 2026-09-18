import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** 超过该长度的 JSONL 行延后到 setImmediate 再 JSON.parse，避免 stdout data 回调堵住主进程。 */
export const LARGE_RPC_LINE_PARSE_CHARS = 256 * 1024;

/** 单行缓冲硬上限：无 LF 的失控输出（启动脚本打印二进制/死循环刷屏）会让行缓冲无界增长。
 *  上限取大行解析阈值的 32 倍——正常 get_entries 响应远小于此，超限即视为 stdout 已被污染。 */
export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

export class PiRpcClient extends EventEmitter {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  /** 大行按到达顺序排队，保证同一 client 的 response/event 不乱序。 */
  private parseQueue: Promise<void> = Promise.resolve();
  /**
   * close() 后 client 为终态：pi 已死/从未起来，再写 stdin 只会拿到
   * ERR_STREAM_DESTROYED（未监听的 stream error 会变成 uncaughtException），
   * 新请求也必须立刻失败——否则调用方（如启动握手）会为一个不会再来的响应干等满超时。
   */
  private closed = false;
  private closeReason: Error | null = null;

  constructor(
    private readonly stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream,
  ) {
    super();
    stdout.on("data", chunk => this.consumeChunk(chunk));
    stdout.on("end", () => this.consumeEnd());
  }

  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    const id = String(command.id ?? randomUUID());
    const payload = { ...command, id };

    // 进程已收尾：直接以 close 原因失败。启动握手时 spawn 失败与 get_state 请求存在竞态，
    // 若这里不短路，用户要等满 rpcTimeout（默认 10 分钟）才看到「启动失败」。
    if (this.closed) {
      return Promise.reject(
        this.closeReason
          ? new Error(`${this.closeReason.message} (RPC command not sent: ${String(command.type)})`)
          : new Error(`RPC client closed: ${String(command.type)}`),
      );
    }

    const promise = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 错误文本带超时时长，方便 toast/诊断卡直接看出是等待过久而非连接断开
        reject(new Error(`RPC command timed out after ${timeoutMs}ms: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.write(payload);
    return promise;
  }

  notify(command: Record<string, unknown>) {
    this.write(command);
  }

  /** 直接向 pi 的 stdin 写入原始 JSONL，不经过 pending 跟踪（用于 extension_ui_response 等消息） */
  sendRaw(payload: Record<string, unknown>) {
    if (this.closed) return;
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = error ?? null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error(`RPC client closed before response: ${id}`));
    }
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>) {
    // close 之后不再触碰 stdin：管道已被销毁，写入会抛 ERR_STREAM_DESTROYED
    // 或以未监听 error 事件的形式冒泡成未捕获异常。
    if (this.closed) return;
    // 记录发出的 RPC 命令，方便调试
    this.emit("log", { direction: "send", data: payload });
    // pi RPC 使用严格 JSONL 协议；每条命令必须以 LF 结尾，不能依赖 readline 之类的宽松分行。
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consumeChunk(chunk: Buffer | string) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    // 行缓冲硬上限：超限说明 stdout 已被无换行的失控输出污染，继续累积只会 OOM。
    // 丢弃整段缓冲并按协议错误上报（AgentManager 会转 agentsLog + appLogger），
    // 进程随后由启动失败/退出路径回收。
    if (this.buffer.length > MAX_RPC_LINE_BYTES) {
      const droppedBytes = this.buffer.length;
      this.buffer = "";
      this.emit("protocol-error", `rpc line buffer overflow: dropped ${droppedBytes} bytes without newline`);
      return;
    }
    this.drainLines();
  }

  private consumeEnd() {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
      this.buffer = "";
    }
  }

  private drainLines() {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    // 小行仍同步解析，保持流式 token 低延迟；大行（get_entries / 巨型事件）让出事件循环，
    // 关窗/设置 IPC 才能在 JSON.parse 完成前被处理。
    if (line.length > LARGE_RPC_LINE_PARSE_CHARS) {
      this.parseQueue = this.parseQueue.then(
        () => new Promise<void>((resolve) => {
          setImmediate(() => {
            this.dispatchParsedLine(line);
            resolve();
          });
        }),
      );
      return;
    }
    this.dispatchParsedLine(line);
  }

  private dispatchParsedLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout 被非 JSON 内容污染时保留原文，方便用户排查 PATH、pi 版本或启动脚本问题。
      this.emit("protocol-error", line);
      return;
    }

    // 记录收到的 RPC 消息，方便调试
    this.emit("log", { direction: "recv", data: message });

    if (this.isResponse(message) && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    this.emit("event", message);
  }

  private isResponse(value: unknown): value is RpcResponse {
    return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "response");
  }
}
