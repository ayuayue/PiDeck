import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function localTools(pi: ExtensionAPI) {
  const url = process.env.PIDECK_LITE_MEMORY_URL;
  const token = process.env.PIDECK_LITE_MEMORY_TOKEN;
  if (url && token && typeof pi.registerMcpServer === "function") {
    pi.registerMcpServer("pideck-lite-memory", {
      url,
      headers: { Authorization: `Bearer ${token}` },
      exposure: "direct",
    });
  }
  const browserURL = process.env.PIDECK_LITE_BROWSER_URL;
  const browserToken = process.env.PIDECK_LITE_BROWSER_TOKEN;
  if (browserURL && browserToken && typeof pi.registerMcpServer === "function") {
    pi.registerMcpServer("pideck-lite-browser", {
      url: browserURL,
      headers: { Authorization: `Bearer ${browserToken}` },
      exposure: "direct",
    });
  }

  if (process.env.PIDECK_LITE_TRACE !== "1") return;
  let previous = "";
  pi.on("context_with_system", (event, ctx) => {
    const user = ctx.sessionManager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    if (!user || user.type !== "message") return;
    const instructions: string[] = [];
    const sections = new Map<string, string>();
    for (const message of event.messages) {
      if (message.role !== "system") continue;
      const content = typeof message.content === "string" ? message.content :
        message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (content) instructions.push(content);
      for (const [name, value] of Object.entries(message.sections ?? {})) {
        if (value === null) sections.delete(name);
        else sections.set(name, value);
      }
    }
    const text = [...instructions, ...sections.values()].join("\n\n").slice(0, 32_768);
    if (!text) return;
    const key = `${user.id}\n${text}`;
    if (key === previous) return;
    previous = key;
    pi.appendEntry("pideck-lite-trajectory", { entry: user.id, time: user.message.timestamp, system: text });
  });
}
