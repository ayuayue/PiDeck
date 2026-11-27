// One login per process. Pi owns credentials, provider behavior and callbacks.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkPath = process.argv[1];
const agentDir = process.argv[2];
const flow = new AbortController();
const waiters = new Map();
let started = false;
let finished = false;
let nextPrompt = 0;
let buffer = "";

function send(message) {
  if (!finished) process.stdout.write(JSON.stringify(message) + "\n");
}
function abortError() {
  return new DOMException("Login cancelled", "AbortError");
}
function abort() {
  flow.abort();
}
function complete(message) {
  if (finished) return;
  finished = true;
  process.stdin.pause();
  process.stdout.write(JSON.stringify(message) + "\n", () => process.exit(0));
}

async function installProxy() {
  if (!["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some((name) => process.env[name])) return;
  // SDK initialization installs its own dispatcher. Restore the Agent proxy
  // afterward and install fetch from the same undici instance.
  const require = createRequire(pathToFileURL(sdkPath));
  const undici = await import(pathToFileURL(require.resolve("undici")).href);
  if (typeof undici.EnvHttpProxyAgent !== "function" || typeof undici.setGlobalDispatcher !== "function") {
    throw new Error("The installed pi does not provide HTTP proxy support. Update pi and retry.");
  }
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  if (typeof undici.install === "function") undici.install();
}

function promptUser(prompt) {
  if (flow.signal.aborted || prompt.signal?.aborted) return Promise.reject(abortError());
  const id = String(++nextPrompt);
  return new Promise((resolvePrompt, rejectPrompt) => {
    const cancel = () => {
      if (!waiters.has(id)) return;
      clean();
      send({ type: "prompt-cancelled", id });
      rejectPrompt(abortError());
    };
    const clean = () => {
      waiters.delete(id);
      flow.signal.removeEventListener("abort", cancel);
      prompt.signal?.removeEventListener("abort", cancel);
    };
    waiters.set(id, {
      prompt,
      answer(value) { clean(); resolvePrompt(value); },
    });
    flow.signal.addEventListener("abort", cancel, { once: true });
    prompt.signal?.addEventListener("abort", cancel, { once: true });
    send({ type: "prompt", id, prompt: {
      kind: prompt.type, message: prompt.message, placeholder: prompt.placeholder,
      options: prompt.options?.map(({ id, label, description }) => ({ id, label, description })),
    } });
  });
}

async function login(command) {
  let runtime;
  let result;
  try {
    if (!sdkPath || !agentDir) throw new Error("Missing pi SDK or configuration directory.");
    if (typeof command.providerId !== "string" || !command.providerId.trim() || !["oauth", "api_key"].includes(command.type)) {
      throw new Error("Invalid provider or authentication type.");
    }
    const sdk = await import(pathToFileURL(resolve(sdkPath)).href);
    if (typeof sdk.ModelRuntime?.create !== "function") throw new Error("The installed pi does not support this login API. Update pi and retry.");
    await installProxy();
    if (flow.signal.aborted) throw abortError();
    runtime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    if (flow.signal.aborted) throw abortError();
    send({ type: "ready" });
    let settings;
    await runtime.login(command.providerId.trim(), command.type, {
      signal: flow.signal,
      prompt: promptUser,
      notify(event) { send({ type: "event", event }); },
    }, {
      getDeviceId() {
        settings ??= sdk.SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
        return settings.getOrCreateDeviceId();
      },
    });
    result = { type: "result", ok: true };
  } catch (error) {
    const cancelled = flow.signal.aborted || error?.name === "AbortError";
    result = { type: "result", ok: false, cancelled,
      ...(cancelled ? {} : { error: { message: error instanceof Error ? error.message : String(error) } }),
    };
  } finally {
    // Refresh tokens can be single-use: finish persistence before exiting.
    try { await runtime?.settleCredentialWrites(); }
    catch (error) { result = { type: "result", ok: false, error: { message: error instanceof Error ? error.message : String(error) } }; }
    abort();
    complete(result ?? { type: "result", ok: false, cancelled: true });
  }
}

function accept(line) {
  let command;
  try { command = JSON.parse(line); }
  catch { abort(); complete({ type: "fatal", message: "Invalid authentication command." }); return; }
  if (command.cmd === "cancel") { abort(); return; }
  if (command.cmd === "answer") {
    const waiter = waiters.get(command.id);
    if (!waiter || typeof command.value !== "string") return;
    if (waiter.prompt.type === "select" && !waiter.prompt.options.some((option) => option.id === command.value)) return;
    waiter.answer(command.value);
    return;
  }
  if (command.cmd === "login" && !started) {
    started = true;
    void login(command);
    return;
  }
  abort();
  complete({ type: "fatal", message: "Unexpected authentication command." });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (finished) return;
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(line, "utf8") > 64 * 1024) { abort(); complete({ type: "fatal", message: "Authentication command exceeds the limit." }); return; }
    if (line.trim()) accept(line);
    if (finished) return;
  }
  if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) { abort(); complete({ type: "fatal", message: "Authentication command exceeds the limit." }); }
});
process.stdin.on("end", () => {
  abort();
  if (!started) complete({ type: "fatal", message: "Authentication input closed." });
});
process.stdin.on("error", abort);
process.on("SIGTERM", abort);
process.on("SIGINT", abort);
