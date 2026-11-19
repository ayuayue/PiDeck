// The relay phone and desktop meet at. It is the same protocol as
// cmd/pideck-relay, on Cloudflare's edge: one Durable Object per
// environment, one desktop and one phone, bytes forwarded unchanged.
//
// The relay never sees plaintext. Both ends run the desktop's TLS inside
// the WebSocket, and the phone pins the certificate named by the pairing
// link, so this Worker only moves frames.

export interface Env {
  TUNNEL: DurableObjectNamespace;
}

const PATH = "/v1/tunnel";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== PATH) {
      return new Response("not found", { status: 404 });
    }
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }
    const envId = url.searchParams.get("env") ?? "";
    const role = url.searchParams.get("role") ?? "";
    const key = url.searchParams.get("key") ?? "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(envId)) {
      return new Response("bad environment", { status: 400 });
    }
    if (role !== "desktop" && role !== "phone") {
      return new Response("bad role", { status: 400 });
    }
    if (key.length < 16 || key.length > 128) {
      return new Response("bad key", { status: 400 });
    }
    const id = env.TUNNEL.idFromName(envId);
    return env.TUNNEL.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  role: "desktop" | "phone";
  hash: string;
}

// Tunnel pairs one desktop with one phone. The socket attachment carries
// the role and key hash, so the object can hibernate between messages
// without a table of its own.
export class Tunnel implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Attachment["role"];
    const key = url.searchParams.get("key") ?? "";
    const hash = await sha256(key);

    if (this.state.getWebSockets(role).length > 0) {
      return new Response("busy", { status: 409 });
    }
    if (role === "phone") {
      const desktop = this.state.getWebSockets("desktop")[0];
      if (!desktop) {
        return new Response("desktop offline", { status: 409 });
      }
      const attachment = desktop.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.hash !== hash) {
        return new Response("wrong key", { status: 401 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ role, hash } satisfies Attachment);
    this.state.acceptWebSocket(server, [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const peer = this.peerOf(ws);
    if (!peer) {
      return;
    }
    try {
      peer.send(message);
    } catch {
      // The peer closed between the lookup and the send.
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const peer = this.peerOf(ws);
    if (!peer) {
      return;
    }
    try {
      peer.close(code >= 1000 && code < 5000 ? code : 1011, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const peer = this.peerOf(ws);
    try {
      peer?.close(1011, "peer failed");
    } catch {
      // Already closed.
    }
  }

  private peerOf(ws: WebSocket): WebSocket | undefined {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      return undefined;
    }
    const role = attachment.role === "desktop" ? "phone" : "desktop";
    return this.state.getWebSockets(role)[0];
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
