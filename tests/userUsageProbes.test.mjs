import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadUserUsageProbes, loadUserUsageProbesDetailed, normalizeUserUsageProbes, loadUsageProbeSettings, saveUsageProbeForProvider, normalizeProviderConfig } = loadTsCommonJs("src/main/config/userUsageProbes.ts");
const { buildDeclarativeUsageProbeTemplate, USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID } = loadTsCommonJs("src/main/config/usageProbeTemplates.ts");
const { USAGE_PROBE_CANDIDATES } = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

// loadTsCommonJs 用 vm 加载模块，产物是跨 realm 对象；deepStrictEqual 会按原型判等。
// 统一走 JSON 序列化比较，避免跨 realm 的数组/对象误判。
const json = (value) => JSON.stringify(value);

async function withProbesFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-"));
  try {
    if (content != null) {
      await writeFile(join(dir, "usage-probes.json"), content, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("文件不存在时返回空列表且无错误", async () => {
  await withProbesFile(null, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(json(result), json({ candidates: [], errors: [] }));
  });
});

test("合法 balance 探针被转换成内部候选", async () => {
  const content = JSON.stringify({
    probes: [
      {
        name: "我的网关",
        match: { baseUrlContains: ["gateway.example.com"] },
        request: { path: "/v1/balance" },
        parse: { kind: "balance", valuePath: "data.balance", currencyPath: "data.currency" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.path, "/v1/balance");
    assert.equal(c.method, "GET");
    assert.equal(json(c.baseUrlContains), json(["gateway.example.com"]));
    assert.equal(json(c.parse), json({ kind: "balance", valuePath: "data.balance", currencyPath: "data.currency" }));
  });
});

test("credits 探针保留 remainingPath，POST + body + headers 保留", async () => {
  const content = JSON.stringify({
    probes: [
      {
        match: { baseUrlContains: ["openrouter.ai"] },
        request: {
          path: "/credits",
          method: "POST",
          body: { q: 1 },
          headers: { "X-API-Key": "{{apiKey}}" },
        },
        parse: { kind: "credits", remainingPath: "data.total_credits", usedPath: "data.total_usage" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    const c = result.candidates[0];
    assert.equal(c.method, "POST");
    assert.equal(json(c.body), json({ q: 1 }));
    assert.equal(json(c.headers), json({ "X-API-Key": "{{apiKey}}" }));
    assert.equal(c.parse.kind, "credits");
  });
});

test("非法条目被跳过并给出人话错误，不拖垮合法条目", async () => {
  const content = JSON.stringify({
    probes: [
      { match: { baseUrlContains: [] } }, // 缺 baseUrlContains
      { match: { baseUrlContains: ["x.com"] }, request: {} }, // 缺 path
      { match: { baseUrlContains: ["y.com"] }, request: { path: "/balance" }, parse: { kind: "balance" } }, // balance 缺 valuePath
      { match: { baseUrlContains: ["ok.com"] }, request: { path: "/balance" }, parse: { kind: "balance", valuePath: "data.balance" } },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 3);
    assert.equal(result.candidates.length, 1);
    assert.equal(json(result.candidates[0].baseUrlContains), json(["ok.com"]));
  });
});

test("损坏 JSON 报错；文档缺 probes 数组不再是错误（弹窗黄条回归）", async () => {
  await withProbesFile("{ not json", async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
  });
  // 新格式文档（providers 映射由弹窗维护）或任意「没有 probes 键」的文档：
  // 缺 probes 是合法常态，读盘必须零错误——否则 DSH/pi 用量查询弹窗会显示
  // 「缺少 probes 数组」黄条（真实截图 bug）。
  await withProbesFile(JSON.stringify({ foo: 1 }), async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 0);
  });
  await withProbesFile(JSON.stringify({ providers: { deepseek: { enabled: true } } }), async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 0);
  });
  // probes 键存在但类型错误才是结构错误（给可读提示）。
  await withProbesFile(JSON.stringify({ probes: "not-an-array" }), async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /probes 必须是数组/);
  });
});

test("method 非法值回退 GET，非字符串 headers 值被过滤", async () => {
  const content = JSON.stringify({
    probes: [
      {
        match: { baseUrlContains: ["x.com"] },
        request: { path: "/b", method: "DELETE", headers: { good: "v", bad: 123 } },
        parse: { kind: "balance", valuePath: "data.balance" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates[0].method, "GET");
    assert.equal(json(result.candidates[0].headers), json({ good: "v" }));
  });
});

// ── normalizeUserUsageProbes（IPC 载荷与文件共用校验） ──────────────────────

test("normalizeUserUsageProbes 接受裸数组与 {probes} 形态，缺少 probes 数组报错", () => {
  const probe = {
    match: { baseUrlContains: ["x.com"] },
    request: { path: "/b" },
  };
  const fromArray = normalizeUserUsageProbes([probe]);
  assert.equal(fromArray.errors.length, 0);
  assert.equal(fromArray.probes.length, 1);
  assert.equal(fromArray.candidates.length, 1);
  const fromWrapped = normalizeUserUsageProbes({ probes: [probe] });
  assert.equal(json(fromWrapped.probes), json(fromArray.probes));
  const missing = normalizeUserUsageProbes({ foo: 1 });
  assert.equal(missing.probes.length, 0);
  assert.equal(missing.errors.length, 1);
});

test("rootPath 标记透传到候选（host 根端点场景）", () => {
  const result = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["open.bigmodel.cn"] },
      request: { path: "/api/monitor/usage", rootPath: true },
      parse: { kind: "balance", valuePath: "data.balance" },
    },
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.candidates[0].rootPath, true);
});

test("skipBearer 透传到候选 noBearer（Cookie 登录态接口场景）", () => {
  const result = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["tokenrhythm.studio"] },
      request: {
        path: "/api/wallet/summary",
        rootPath: true,
        skipBearer: true,
        headers: { Cookie: "tr_session=sess_x" },
      },
      parse: { kind: "balance", valuePath: "data.availableBalanceCny" },
    },
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.candidates[0].noBearer, true);
  // 规范化后的 probe 不再需要 skipBearer 字段（只影响候选请求头组装）
  assert.equal(result.probes[0].request.skipBearer, undefined);
});

test("windows 的 listPath/where 形态被校验保留，eq 非基本类型的条件被丢弃", () => {
  const result = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["gw.example.com"] },
      request: { path: "/limits" },
      parse: {
        kind: "credits",
        windows: [
          // 合法：listPath + where（基本类型 eq）
          {
            key: "fiveHour",
            listPath: "data.limits",
            where: [{ path: "type", eq: "CREDIT_LIMIT" }, { path: "unit", eq: 3 }],
            totalPath: "usage",
            usedPath: "currentValue",
          },
          // 非法：eq 是对象（JSON.parse 后引用不等，永远匹配不上）→ 窗口被跳过
          { key: "bad", listPath: "data.limits", where: [{ path: "x", eq: { deep: 1 } }], totalPath: "a", usedPath: "b" },
          // 非法：where 全被过滤 → 窗口无效
          { key: "bad2", listPath: "data.limits", where: [], totalPath: "a", usedPath: "b" },
          // 合法：绝对路径单窗
          { key: "monthly", totalPath: "data.monthly.total", usedPath: "data.monthly.used" },
        ],
      },
    },
  ]);
  assert.equal(result.errors.length, 0);
  const windows = result.candidates[0].parse.windows;
  assert.equal(windows.length, 2);
  assert.equal(windows[0].key, "fiveHour");
  assert.equal(windows[0].where.length, 2);
  assert.equal(windows[1].key, "monthly");
  assert.equal("listPath" in windows[1], false);
});

test("windows-only 探针（主值三路径全空）也合法；三处全空才报错", () => {
  const windowsOnly = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["gw.example.com"] },
      request: { path: "/limits" },
      parse: { kind: "credits", windows: [{ key: "w", totalPath: "t", usedPath: "u" }] },
    },
  ]);
  assert.equal(windowsOnly.errors.length, 0);
  const empty = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["gw.example.com"] },
      request: { path: "/limits" },
      parse: { kind: "credits" },
    },
  ]);
  assert.equal(empty.errors.length, 1);
});

test("booster 规格被校验保留（balancePath 必填，非法字段省略）", () => {
  const ok = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["api.kimi.com"] },
      request: { path: "/usages" },
      parse: {
        kind: "credits",
        totalPath: "usage.limit",
        booster: {
          balancePath: "boosterWallet.balance.amountLeft",
          currencyPath: "boosterWallet.monthlyUsed.currency",
          fixedPointPerCent: 1000000,
        },
      },
    },
  ]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.candidates[0].parse.booster.balancePath, "boosterWallet.balance.amountLeft");
  assert.equal(ok.candidates[0].parse.booster.fixedPointPerCent, 1000000);
  const bad = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["api.kimi.com"] },
      request: { path: "/usages" },
      parse: { kind: "credits", totalPath: "usage.limit", booster: { totalPath: "x" } },
    },
  ]);
  // booster 非法 → 整块省略，探针本身仍合法（主值仍在）
  assert.equal(bad.errors.length, 0);
  assert.equal(bad.candidates[0].parse.booster, undefined);
});

test('kind:"custom" 专用解析器被明确拒绝（安全边界）', () => {
  const result = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["api.x.ai"] },
      request: { path: "/v1/billing" },
      parse: { kind: "custom", resolver: "xai-billing" },
    },
  ]);
  assert.equal(result.probes.length, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /custom/);
});

// ── providers 映射（per-provider 用量查询配置） ──────────────────────────

test("保存 provider 配置后能读回；旧 probes 数组被原样保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-save-"));
  try {
    // 先写一份含旧 probes 的配置文件（模拟 AI 手写场景）。
    await writeFile(
      join(dir, "usage-probes.json"),
      JSON.stringify({
        probes: [{ name: "AI 写的探针", match: { baseUrlContains: ["gw.example.com"] }, request: { path: "/b" } }],
      }),
      "utf8",
    );
    const saved = await saveUsageProbeForProvider(dir, "deepseek", {
      enabled: true,
      template: "general",
      timeoutSecs: 10,
      intervalMinutes: 5,
    });
    assert.equal(saved.ok, true);
    const loaded = await loadUsageProbeSettings(dir, "deepseek");
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.template, "general");
    assert.equal(loaded.config.timeoutSecs, 10);
    // 磁盘形态：providers 映射 + 旧 probes 数组都在。
    const file = JSON.parse(await readFile(join(dir, "usage-probes.json"), "utf8"));
    assert.equal(file.providers.deepseek.template, "general");
    assert.equal(file.probes.length, 1);
    // 未配置过的 provider 读不到 config。
    const missing = await loadUsageProbeSettings(dir, "unknown");
    assert.equal(missing.config, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("按 provider 合并保存：只改目标条目，其它 providers 不动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-merge-"));
  try {
    await saveUsageProbeForProvider(dir, "deepseek", { enabled: true });
    await saveUsageProbeForProvider(dir, "openrouter", { enabled: false, template: "general" });
    const file = JSON.parse(await readFile(join(dir, "usage-probes.json"), "utf8"));
    assert.equal(file.providers.deepseek.enabled, true);
    assert.equal(file.providers.openrouter.enabled, false);
    assert.equal(file.providers.openrouter.template, "general");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeProviderConfig：enabled/template/超时/间隔边界校验", () => {
  assert.equal(json(normalizeProviderConfig({ enabled: false }).config), json({ enabled: false }));
  assert.equal(json(normalizeProviderConfig({ template: "newapi", timeoutSecs: 30, intervalMinutes: 0 }).config), json({ template: "newapi", timeoutSecs: 30, intervalMinutes: 0 }));
  assert.match(normalizeProviderConfig({ template: "hack" }).error, /未知模板/);
  assert.match(normalizeProviderConfig({ baseUrl: "ftp://x" }).error, /http/);
  assert.match(normalizeProviderConfig({ timeoutSecs: 0 }).error, /1-300/);
  assert.match(normalizeProviderConfig({ timeoutSecs: 301 }).error, /1-300/);
  assert.match(normalizeProviderConfig({ intervalMinutes: -1 }).error, /0-1440/);
  assert.match(normalizeProviderConfig({ intervalMinutes: 1441 }).error, /0-1440/);
  assert.match(normalizeProviderConfig({ enabled: "yes" }).error, /布尔/);
});

test("providers-only 文件：弹窗读取零错误（DSH「缺少 probes 数组」黄条回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-noerr-"));
  try {
    // 与真实截图同构：DSH 弹窗保存后落盘的文件只有 providers 映射、没有 probes 键。
    await writeFile(
      join(dir, "usage-probes.json"),
      JSON.stringify({ providers: { deepseek: { enabled: true, timeoutSecs: 10, intervalMinutes: 5 } } }),
      "utf8",
    );
    const loaded = await loadUsageProbeSettings(dir, "deepseek");
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.timeoutSecs, 10);
    assert.equal(loaded.errors.length, 0, "providers-only 文件不得报「缺少 probes 数组」");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUserUsageProbesDetailed：文档形态返回原样探针与对应候选（Cookie 回显用）", async () => {
  const content = JSON.stringify({
    providers: { "thetoken-copy": { enabled: true } },
    probes: [
      {
        name: "Token Rhythm 钱包余额",
        match: { baseUrlContains: ["tokenrhythm.studio"] },
        request: { path: "/api/wallet/summary", rootPath: true, skipBearer: true, headers: { Cookie: "_c_abc=1; tr_session=sess_x" } },
        parse: { kind: "balance", valuePath: "data.availableBalanceCny", currencyPath: "data.currency" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbesDetailed(dir);
    assert.equal(result.errors.length, 0);
    assert.equal(result.probes.length, 1);
    assert.equal(result.candidates.length, 1);
    // 原始探测形态保留（弹窗回显迁移源），含 Cookie 头与 balance 分支字段
    assert.equal(result.probes[0].name, "Token Rhythm 钱包余额");
    assert.equal(result.probes[0].request?.headers?.Cookie, "_c_abc=1; tr_session=sess_x");
    assert.equal(result.probes[0].parse?.kind, "balance");
    assert.equal(result.candidates[0].path, "/api/wallet/summary");
  });
});

test("loadUserUsageProbesDetailed：skipBearer 进候选（noBearer），仅提示用原样不含该字段", async () => {
  const content = JSON.stringify({
    probes: [
      {
        match: { baseUrlContains: ["tokenrhythm.studio"] },
        request: { path: "/api/wallet/summary", skipBearer: true, headers: { Cookie: "x=1" } },
        parse: { kind: "balance", valuePath: "data.balance" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbesDetailed(dir);
    assert.equal(result.candidates[0].noBearer, true);
    assert.equal(result.probes[0].request?.skipBearer, undefined);
  });
});

test("配置损坏 / 非法条目返回错误而非抛异常", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-bad-"));
  try {
    await writeFile(join(dir, "usage-probes.json"), "{ not json", "utf8");
    const loaded = await loadUsageProbeSettings(dir, "deepseek");
    assert.equal(loaded.config, undefined);
    // providers 与旧 probes 两个错误源各报一条（同一次损坏 JSON）。
    assert.ok(loaded.errors.length >= 1);
    assert.ok(loaded.errors.some((e) => String(e).includes("JSON")));
    await writeFile(
      join(dir, "usage-probes.json"),
      JSON.stringify({ providers: { bad: { template: "nope" }, ok: { enabled: true } } }),
      "utf8",
    );
    const loaded2 = await loadUsageProbeSettings(dir, "ok");
    assert.equal(loaded2.config.enabled, true);
    // 非法条目被跳过并带 provider 名提示。
    const loadedBad = await loadUsageProbeSettings(dir, "bad");
    assert.equal(loadedBad.config, undefined);
    assert.ok(loadedBad.errors.some((e) => String(e).includes("providers.bad")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("保存到被文件占用的 configDir 返回结构化错误而非抛异常", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-bad2-"));
  try {
    await writeFile(join(dir, "occupied"), "not a dir", "utf8");
    const result = await saveUsageProbeForProvider(join(dir, "occupied"), "deepseek", { enabled: true });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 声明式模板构建（general / newapi，学 cc-switch 预设模板） ─────────────

test("通用模板：默认复用供应商端点与密钥，覆盖字段优先生效", () => {
  const endpoint = { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-provider" };
  const base = buildDeclarativeUsageProbeTemplate("general", {}, endpoint);
  assert.equal(base.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(base.apiKey, "sk-provider");
  assert.equal(base.candidate.path, "/usage");
  assert.equal(json(base.candidate.parse), json({ kind: "balance", valuePath: "balance", currencyPath: "unit" }));
  const overridden = buildDeclarativeUsageProbeTemplate(
    "general",
    { baseUrl: "https://usage.example.com", apiKey: "sk-override" },
    endpoint,
  );
  assert.equal(overridden.baseUrl, "https://usage.example.com");
  assert.equal(overridden.apiKey, "sk-override");
});

test("NewAPI 模板：缺访问令牌/用户 ID 报错；齐全时构建鉴权头与积分换算", () => {
  const endpoint = { baseUrl: "https://api.newapi.com", apiKey: "" };
  const missing = buildDeclarativeUsageProbeTemplate("newapi", { accessToken: "t" }, endpoint);
  assert.ok("error" in missing);
  const built = buildDeclarativeUsageProbeTemplate(
    "newapi",
    { accessToken: "token-123", userId: "114514", baseUrl: "https://relay.example.com" },
    endpoint,
  );
  assert.ok(!("error" in built));
  assert.equal(built.baseUrl, "https://relay.example.com");
  assert.equal(built.candidate.path, "/api/user/self");
  assert.equal(json(built.candidate.headers), json({ Authorization: "Bearer token-123", "New-Api-User": "114514" }));
  assert.equal(built.candidate.parse.kind, "credits");
  assert.equal(built.candidate.parse.scale, 500000);
  assert.equal(built.candidate.parse.remainingPath, "data.quota");
});

test("所有内置候选的 templateId 都在类别映射中登记（防漂移）", () => {
  for (const candidate of USAGE_PROBE_CANDIDATES) {
    if (!candidate.templateId) continue;
    assert.ok(
      USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID[candidate.templateId],
      `内置候选 ${candidate.templateId} 缺少类别登记`,
    );
  }
  // 反向：类别映射里登记的每个 id 必须有候选携带它——识别（recognizeUsageTemplate）
  // 与「测试」按钮都按 templateId 找候选，漏挂 = OAuth 订阅类（codex-usage /
  // xai-billing）识别不出来，弹窗回落到通用模板并显示 API Key/URL 字段（真实 bug）。
  for (const id of Object.keys(USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID)) {
    assert.ok(
      USAGE_PROBE_CANDIDATES.some((c) => c.templateId === id),
      `类别登记的模板 id ${id} 没有任何内置候选（识别/测试会失效）`,
    );
  }
});

test("credits 的 scale 仅接受正有限数（New API 积分换算场景）", () => {
  const ok = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["newapi.example.com"] },
      request: { path: "/api/user/self" },
      parse: { kind: "credits", remainingPath: "data.quota", scale: 500000 },
    },
  ]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.candidates[0].parse.scale, 500000);
  const invalid = normalizeUserUsageProbes([
    {
      match: { baseUrlContains: ["newapi.example.com"] },
      request: { path: "/api/user/self" },
      parse: { kind: "credits", remainingPath: "data.quota", scale: -1 },
    },
  ]);
  assert.equal(invalid.errors.length, 0);
  assert.equal(invalid.candidates[0].parse.scale, undefined, "非法 scale 丢弃，不缩放");
});
test("normalizeProviderConfig：cookie 模板字段合法时完整回填", () => {
  const res = normalizeProviderConfig({
    template: "cookie",
    cookie: "_c=1; tr_session=sess_abc",
    cookiePath: "/api/wallet/summary",
    valuePath: "data.availableBalanceCny",
    currencyPath: "data.currency",
  });
  assert.equal(res.error, undefined);
  assert.equal(res.config.template, "cookie");
  assert.equal(res.config.cookie, "_c=1; tr_session=sess_abc");
  assert.equal(res.config.cookiePath, "/api/wallet/summary");
  assert.equal(res.config.valuePath, "data.availableBalanceCny");
  assert.equal(res.config.currencyPath, "data.currency");
});

test("normalizeProviderConfig：cookiePath 非 / 开头报错", () => {
  const res = normalizeProviderConfig({ template: "cookie", cookiePath: "api/wallet/summary" });
  assert.match(res.error, /以 \/ 开头/);
});
