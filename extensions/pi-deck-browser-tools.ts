import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function browserTools(pi: ExtensionAPI) {
  const url = process.env.PIDECK_V2_BROWSER_URL;
  const token = process.env.PIDECK_V2_BROWSER_TOKEN;
  if (!url || !token || typeof pi.registerMcpServer !== "function") return;

  pi.registerMcpServer("pideck-v2-browser", {
    url,
    headers: { Authorization: `Bearer ${token}` },
    exposure: "direct",
  });
}
