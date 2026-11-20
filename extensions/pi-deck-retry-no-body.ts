// Keep bounded retries in pi's queue, including its abort and retry events.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function retryMessage(error: string, api = ""): string | undefined {
  if (/\(connection error\)/i.test(error)) return;
  if (/\b(?:401|402|403|404|405|409|410|422)\b|余额|配额|鉴权|未授权|参数错误|格式错误/.test(error)) return;
  const noBody = /\(no body\)|(?:empty|no)\s+response\s+body/i.test(error);
  if (noBody && /anthropic/i.test(api) && /\b(?:400|413)\b/.test(error)) return;
  if (!noBody && !/unexpected\s+eof|\b(?:ECONNRESET|EPIPE|EAI_AGAIN|ETIMEDOUT)\b|\bGOAWAY\b|^stream_read_error\b|tool_arguments_stalled|服务暂时不可用|上游连接中断/i.test(error)) return;
  if (!noBody && /\b4\d\d\b/.test(error)) return;
  // Remove the old overflow detector's leading 400/413 only for bodyless
  // gateway failures. The original status remains available in the text.
  return `transient upstream failure (connection error): ${error}`;
}

export default function (pi: ExtensionAPI): void {
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return;
    const errorMessage = retryMessage(message.errorMessage, message.api);
    if (errorMessage) return { message: { ...message, errorMessage } };
  });
}
