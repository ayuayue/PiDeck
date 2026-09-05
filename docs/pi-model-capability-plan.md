# Pi / PiDeck 模型能力与思考级别链路方案

> 本文回答四个问题：模型配置中的 `reasoning` / `thinkingLevelMap` 是否需要手配；草稿态和正式 Agent 态分别显示什么；“关闭”是否会写入配置；以及 `input: ["text", "image"]` 多模态能力到底怎样生效。
>
> 核对基线：Pi `0.85.0`（2026-09 跟进）、PiDeck 当前工作区代码。Pi 上游源码以本机安装包 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 为准。文中标注「已用真实 Pi 0.84.3 RPC 验证」的实测结论为当时记录，行为语义未在本版变更。

## 结论先行

1. `thinkingLevelMap` 不是“当前选中的思考强度”，而是 **规范档位 → provider wire 值/支持声明**。
2. Pi 真实的 `/thinking` 选择器与 RPC `get_available_thinking_levels` 使用同一套 Pi 逻辑：
   `reasoning` 决定是否支持推理；`thinkingLevelMap` 的 `null` 禁用档位、缺失键对基础档位表示采用默认值、对 `xhigh/max` 表示不提供该档位。
3. 欢迎页和草稿会话优先读取启动 capability cache；运行 Agent 读取自身 runtime cache。旧 Pi 或 probe 失败时才回退静态兼容档位。
4. 配置页里显示的“关闭”只表示当前 `xhigh` / `max` 映射为空，不等于 `reasoning: false`，也不一定会写入 `thinkingLevelMap`。
5. 手动新增 Pi 模型先保持能力字段为空，再按端点元数据、Pi 当前目录和内置目录的唯一模型本体匹配补全；不再写入乐观的 1M / 128K / reasoning / image 猜测值。
6. `input` 是 Pi 真正的多模态能力字段。没有 `image` 时，Pi/pi-ai 会把用户图片和工具图片替换为占位文本；PiDeck 目前仍允许附件并把图片发给 Pi，再由 Pi/视觉桥决定结果。

## 0. 本次实施技术汇总

> 本节是本轮 implementation 的唯一设计基线；后文保留调研证据、Pi 语义和配置页边界，供实现与评审时追溯。

### 0.1 目标与非目标

**目标**：应用启动后后台一次性读取当前用户安装 Pi 的全部可用模型及其精确 thinking levels；欢迎页、草稿会话和运行态 picker 都只读缓存，从而只展示 Pi 实际允许的档位。

**非目标**：本轮不升级 `@earendil-works/pi-ai`，不覆盖用户已经写入的 `models.json` / `auth.json` / `settings.json` 字段，不把 cache 落盘，也不改变 DSH 的 `reasoningEfforts` 链路。配置页仅在用户新增、失焦或保存时为**空字段**写入有来源的模型能力模板。

### 0.2 权威数据源与边界

| 数据 | 权威来源 | PiDeck 用途 |
|---|---|---|
| 全局可用模型、容量、输入模态、reasoning/map | 用户安装的 `pi --mode rpc --no-session` 的 `get_available_models` | 欢迎页模型列表和只读能力展示 |
| 每个模型实际可选 levels | 同一临时 Pi 进程的 `set_model → get_available_thinking_levels` | 欢迎页/草稿 thinking picker 精确过滤（运行态也统一读此 snapshot） |
| 运行中 session 的 levels（仅兜底） | 该 session 自己的 Pi runtime `get_available_thinking_levels` | idle + cache-miss 时后台补充，不是展示主源 |
| DSH thinking efforts | DSH host catalog | DSH picker；不得接入 Pi probe |
| `pi --list-models` / 本地 `models.json` | 兼容数据源 | 旧 Pi、probe 失败或 hydration 尚未成功时的 fallback |

临时 probe 使用全局模型列表相同的 fast flags：`--offline --no-themes --no-extensions --no-skills`。这保证全局 picker 与 capability cache 的模型范围一致，也避免应用启动时执行任意用户/项目扩展。项目扩展注册的模型不属于当前全局 picker 范围；已运行 Agent 仍以其自身 runtime RPC 为准。

### 0.3 主进程所有权和事务模型

新增 `src/main/pi/PiModelCapabilityCache.ts`，作为唯一 owner。它持有：

```text
PiModelCapabilityCache
  ├─ generation                 配置版本；拒绝旧任务迟到结果
  ├─ inFlight                   同 generation 的 refresh 去重
  ├─ snapshot                   已发布的 models + thinking levels
  ├─ temporary PiProcess        仅 hydration 期间存在
  └─ config watcher / dispose   外部文件变更和退出清理
```

一次 `refresh()` 是原子事务：

```text
1. generation + 1，停止旧 probe，清空旧的精确 snapshot
2. 启动一个 PiProcess（--mode rpc、--no-session、fast flags）
3. get_available_models
4. 对返回的每个模型顺序执行 set_model → get_available_thinking_levels
5. 仅当 generation 仍匹配时，一次性发布完整 snapshot
6. 无论成功、失败或取消都 stop() probe
```

`set_model` 只修改 `--no-session` 进程中的内存 session，且未传 `persist`；它不写 Pi 全局默认、不创建会话文件、不发送 prompt 或模型请求。若单个模型查询失败，该模型保留在列表中但 `thinkingLevels` 为 `undefined`；若 catalog 查询或能力 RPC 整体不兼容，则不发布“精确” snapshot，回退现有模型列表链路。

### 0.4 共享数据契约和 UI 消费

主进程在 memory snapshot 中保留模型级 map；跨 IPC 只传不含密钥的展示/配置字段。`AvailableModel` 现扩展为：

```ts
type AvailableModel = {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  images?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  thinkingLevels?: string[];
};
```

语义必须固定：

- `thinkingLevels: undefined`：未知、旧 Pi 或 fallback，不能声称是精确能力；
- `thinkingLevels: []`：Pi 的权威空响应，不能自动改为静态列表；
- 非空数组：Pi 已确认的档位，欢迎页和草稿 picker 只能显示这些值；
- Pi 返回未来未知档位时保留原始 id，由现有 label fallback 展示。

优先复用 `projects:listModelsReport` 返回带 capability 的 `AvailableModel[]`，避免为全局模型能力再开一套 IPC。运行态沿用已有 `sessions:runtime-thinking-levels` IPC，但将 renderer 请求结果缓存到按 `sessionId + agentId + runtimeGeneration + provider + modelId` 隔离的 atom；只在 runtime 创建/模型变化时查询一次，不能每次打开 thinking picker 都查询。

### 0.5 启动、失效与刷新规则

应用 ready 后，与现有模型预取相同的后台时机启动一次 hydration。精确 snapshot 就绪后，后续欢迎页打开模型/思考 picker 只读内存，不再 fork Pi 或发送 RPC。`get_available_models` 可以成为新版模型列表的主来源；现有 `pi --list-models` 保留为失败和旧版兼容 fallback，而不是和 probe 并发重复启动。

以下事件必须统一调用 `invalidateAndRefresh()`：

1. 表单保存 `models.json` 或 `auth.json`；
2. raw 配置保存涉及 `models.json` / `auth.json`，或 config import；
3. Pi ↔ DSH provider migration；
4. Pi 自更新、custom Pi path/WSL 配置改变、版本缓存失效；
5. watcher 发现 Pi 配置目录下 `models.json` / `auth.json` 外部变化；
6. 手动刷新模型列表和启动 Agent 前的兜底刷新。

watcher 使用目录级、按文件名过滤、短 debounce 的策略；创建与 `dispose()` 必须在同一模块，`app` quit 时统一释放。写入路径触发显式 invalidation，不依赖 watcher 时序。首次 hydration 未完成或失败时，UI 继续用现有 fallback，不阻塞主窗口。

本轮只做**进程内**缓存。每次 PiDeck 启动重新 hydration；约 657ms 的后台成本低于维护跨重启 cache 的 Pi 命令、版本、模型/auth 文件指纹和安全边界的复杂度。

### 0.6 兼容与错误策略

- Pi `>=0.81.0` 支持精确 levels RPC；结果可用时它始终压过 PiDeck 静态列表和本地 catalog 推导。
- 旧 Pi、unknown command、错误结构、process start 失败：保留原 `pi --list-models → models.json` 兼容链路，thinking picker 使用现有 fallback，但 UI/数据状态不得把它标为“已确认”。
- 模型或 auth 配置在 hydration 中途更新：旧 generation 的任何结果均丢弃；新 generation 完成前不复用旧的精确 levels。
- DSH 不启动 Pi probe，也不读取 `thinkingLevels`；它继续从 `reasoningEfforts` 生成选项。

### 0.7 实施顺序与验收

1. 先实现纯解析/转换函数及 `PiModelCapabilityCache`，提供可注入的 Pi process factory，写完单元测试再接 Electron。
2. 在 `main/index.ts` 装配启动、config invalidation、quit cleanup；`systemIpc` 的 list/report 优先读取 capability snapshot。
3. 扩展共享类型、preload/renderer 数据流；欢迎页按 `thinkingLevels` 过滤，运行态改为 session-scoped cache。
4. 覆盖 startup hydration 命令序列、398/任意多模型、单模型失败、旧 Pi、配置变更竞态、外部 watcher、运行态隔离、DSH 不受影响，并跑 typecheck 与针对性测试。

## 1. Pi 的权威规则

### 1.1 配置字段职责

| 字段 | 所在位置 | 真实职责 |
|---|---|---|
| `reasoning` | `models.json` 的模型 | `false`/缺省时，Pi 只返回 `["off"]`；`true` 才进入推理档位计算 |
| `thinkingLevelMap` | `models.json` 的模型 | 映射 canonical thinking level 到 provider 值；`null` 明确禁用该档位；`xhigh/max` 只有存在非 `null` 映射时才可用 |
| `compat.supportsReasoningEffort` | provider/model compat | provider 是否能接收 `reasoning_effort` 等参数；只写 map 不一定会让网关收到对应参数 |
| `input` | `models.json` 的模型 | 输入模态；缺省时 Pi 自定义模型默认为 `["text"]`，包含 `"image"` 才视为原生视觉模型 |
| `settings.json.defaultThinkingLevel` | Pi 全局/项目设置 | 默认请求档位，不是能力声明 |
| `settings.json.modelThinkingLevels` | Pi 全局/项目设置 | provider/model 的默认请求档位，不是能力声明 |

Pi 的 `ModelDefinitionSchema` 支持 `off/minimal/low/medium/high/xhigh/max` 全部 map 键，但 PiDeck 当前可视化配置只提供 `xhigh` 和 `max` 两行。

### 1.2 Pi 0.84.3 的实际算法

Pi `@earendil-works/pi-ai/dist/models.js` 的等价逻辑是：

```ts
if (!model.reasoning) return ["off"];

return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  .filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
```

所以：

- 基础五档 `off` 到 `high`：没有 map 时默认存在；写 `null` 才会移除；
- `xhigh` / `max`：没有 map 时不存在；写字符串才存在；写 `null` 也不存在；
- `reasoning: false` 时，map 即使写了也完全无效；
- map 不会自动选择 `max`，当前选中值仍由 Pi 的 default/session preference 决定；无设置时新模型默认是 `medium`，再按能力 clamp。

### 1.3 已用真实 Pi 0.84.3 RPC 验证

使用临时 `models.json` 启动真实 `pi --mode rpc --no-session`，调用 `get_state` 和 `get_available_thinking_levels`，结果如下：

| 配置 | Pi 返回的 levels | 数量 | 初始 thinking |
|---|---|---:|---|
| `reasoning: false`，即使 map 有 `xhigh/max` | `off` | 1 | `off` |
| `reasoning: true`，没有 map | `off, minimal, low, medium, high` | 5 | `medium` |
| `reasoning: true`，`{ xhigh: "xhigh" }` | `off, minimal, low, medium, high, xhigh` | 6 | `medium` |
| `reasoning: true`，`{ xhigh: "max", max: "max" }` | `off, minimal, low, medium, high, xhigh, max` | 7 | `medium` |

例如配置 `defaultThinkingLevel: "max"`、模型没有 map 时，Pi 会把请求 clamp 到可用的 `high`，不是 `off`。

## 2. PiDeck 配置页：用户不处理“思考级别”到底写不写

### 2.1 手动新增 Pi 模型的能力模板

`src/renderer/src/ConfigModal.tsx` 的“手动添加”现在只创建 `id/name` 空草稿，不再预写容量、推理或图片字段。用户填写模型 ID 或显示名后，以及保存整个配置前，PiDeck 按下列优先级补**空字段**：

1. 中转站 `/models` 已报告的容量字段；
2. 当前用户安装 Pi 的完整 `get_available_models` 目录；
3. PiDeck 内置 `pi-ai` catalog。

匹配不是要求第三方 provider 名相同：先尝试 `provider + modelId` 精确匹配，再尝试跨 provider 的标准模型 ID；例如 `luna-relay/gpt-5.6` 可复用 `openai/gpt-5.6` 的模型级事实。`GPT-5.6 Luna` 一类重命名会做边界明确、唯一且最长的名称别名匹配；`gpt-5` 不会被拿来冒充 `gpt-5.6`，歧义或未知名称保持空字段供用户编辑。

命中模板可补 `contextWindow`、`maxTokens`、完整 `input`、`reasoning` 和 `thinkingLevelMap`，但永不改写 provider、baseUrl、API 协议、认证、用户已填字段或用户手写 map。配置表会展示能力卡，说明匹配到的标准模型、数据源和映射档位；它是可审计说明，不是对远端中转站行为的伪造证明。

### 2.2 “关闭”按钮的真实语义

`ModelsTab.tsx` 的思考级别弹窗只编辑 `xhigh` 与 `max`：

- 下拉选择 `xhigh` / `max`：写入 `thinkingLevelMap[key]`；
- 选择“关闭”（空值）：删除该 key；两个 key 都空时删除整个 `thinkingLevelMap`；
- 清空 map 时不会把已有的 `reasoning: true` 改成 `false`；
- `reasoning` checkbox 是另一个独立字段，必须单独取消才能让 Pi 只显示 `off`。

因此截图中的“关闭”应理解为：

> “没有为这个扩展档位配置 provider 映射”，不是“模型思考能力关闭”，也不是“必然会写入 `thinkingLevelMap`”。

当前文案容易误导，建议改成“未配置”或“未声明支持”，并在旁边明确说明：基础 `off~high` 仍由 Pi 按 `reasoning` 计算。

### 2.3 配置页只展示 xhigh/max 的问题

Pi 原生允许配置所有七个 map 键，例如：

```json
"thinkingLevelMap": {
  "off": null,
  "minimal": null,
  "low": "low",
  "medium": null,
  "high": "high",
  "xhigh": null,
  "max": "max"
}
```

Pi 会据此只显示 `off/low/high/max`。PiDeck 可视化弹窗目前不能编辑基础五档，只能保留它们、不能管理它们。含有基础 map 的模型会被标记为 advanced preserved fields，但用户无法在普通弹窗内完整核对。

## 3. 草稿态/欢迎页链路

当前 PiDeck 的草稿态没有 Pi runtime，因此不能调用 Pi RPC：

```text
欢迎页 localStorage（可选）
        │
        ├─ 创建 draft：写入 SessionRecord.model / thinkingLevel
        │
        └─ ComposerPickerHost 打开 thinking picker
                 │ 无 agentId / 无 runtime
                 └─ ThinkingPicker.levels = 静态 THINKING_LEVELS
                    [off, minimal, low, medium, high, xhigh, max]
```

当前表现：

- 不管模型 `reasoning` 是 `false`、没有 map，还是只支持 `off/high`，草稿 picker 都可能显示 7 档；
- 用户选择后，PiDeck 会把所选字符串写进 `SessionRecord.thinkingLevel`；
- 欢迎页则先写 `localStorage`，发送时作为 `SessionLaunchPreferences` 带入 draft；
- 草稿阶段没有 `thinkingLevelMap` 的运行时解析，也不会因为配置页的模型行而过滤。

这就是当前“草稿显示几个”和真实 Pi 不一致的根因。

## 4. 正式 Agent 链路

### 4.1 打开 picker

当前已接入的链路：

```text
ComposerPickerHost
  └─ active Pi runtime
      └─ sessions:listRuntimeThinkingLevels
          └─ SessionRuntimeCoordinator target 校验
              └─ AgentManager.getAvailableThinkingLevels
                  └─ Pi RPC get_available_thinking_levels
                      └─ Pi AgentSession.getAvailableThinkingLevels()
                          └─ Pi/pi-ai getSupportedThinkingLevels(currentModel)
```

因此正式运行且查询成功后，PiDeck 最终显示数量与真实 Pi 完全一致：

- map 有两个扩展映射：7 个；
- 没有 map 且 reasoning true：5 个；
- reasoning false：1 个 `off`。

打开 picker 的第一次 React render 在 RPC 返回前仍会暂时回退静态 7 档；RPC 返回后替换为真实列表。旧 Pi unknown command、查询失败、没有 runtime 时也会回退静态列表。

### 4.2 选择档位

```text
PiDeck pickThinking(level)
  ├─ 有 runtime
  │   └─ sessions:setRuntimeThinking
  │       └─ AgentManager.setThinking
  │           └─ Pi RPC set_thinking_level
  │               └─ Pi setThinkingLevel：按当前 model 能力 clamp
  │
  └─ 无 runtime
      └─ 只更新 SessionRecord.thinkingLevel
          └─ 下次 activate/restart 时 applyPreferences 再交给 Pi clamp
```

当前有两个需要修正的持久化漂移点：

1. `SessionRuntimeCoordinator.setRuntimeThinking()` 已拿到 AgentManager 返回的真实 runtime state，但写 catalog 时仍保存用户请求的 `level`，没有保存 Pi clamp 后的 effective level；
2. `setRuntimeModel()` 换模型时 Pi 会按新模型重新选择/clamp thinking，但 catalog 只更新 model，不同步新的 effective thinking level；草稿激活的 `applyPreferences()` 也没有把 clamp 后值回写 catalog。

所以 UI 当前运行态通常是对的，但会话记录可能保存一个 Pi 实际没有使用的档位。

## 5. `reasoning` / `thinkingLevelMap` 到底要不要用户自己配

建议采用以下语义，而不是让用户把所有强度都手填：

### 标准 Pi 内置模型

- 不要为了“启用思考”手工复制模型行到 `models.json`；
- 让 Pi 内置 catalog 提供 `reasoning`、`input`、`thinkingLevelMap`；
- 只在确实需要覆盖 base URL、headers 或 provider 兼容参数时写配置；
- 如果把内置模型重新写进 `models.json`，Pi 的 custom model definition 可能覆盖内置条目，缺失的 map 不会自动从 PiDeck 的 catalog 补回。

### 自定义 provider / 网关

用户至少需要确认两个事实：

1. 模型是否真的支持 reasoning：`reasoning: true/false`；
2. 模型是否真的接受图片：`input: ["text", "image"]` 或仅 `["text"]`。

只有在下面情况才需要手配 `thinkingLevelMap`：

- 上游只接受部分档位；
- `xhigh` / `max` 需要显式开放；
- canonical level 与 provider wire 值不同，例如 `high -> medium`；
- 某些基础档位需要用 `null` 明确禁用；
- 同时需要把 provider compat 的 `supportsReasoningEffort` 打开。

因此 map 应是“高级 provider 能力声明”，不应被当作每个模型都必须填的默认表。

## 6. images 多模态链路

### 6.1 Pi 原生行为

PiDeck 将图片作为 RPC `prompt.images` 发送。Pi AgentSession 把它们放进 user content；Pi/pi-ai 的公共 `transformMessages()` 再根据当前模型的 `input` 处理：

- `input` 包含 `image`：保留图片，provider API 收到 base64 image block；
- 不包含 `image`：用户图片替换为 `(image omitted: model does not support images)`，工具图片替换为对应占位文本；
- `input` 缺省的自定义模型在 Pi 内部默认为 `["text"]`。

### 6.2 PiDeck 视觉桥

PiDeck 内置 `resources/extensions/pi-deck-vision.ts`，正常 RPC 启动时会注入：

- 当前 Pi 模型声明支持图片：原图直通，不调用视觉桥；
- 当前模型不支持图片，且视觉桥配置完整：调用视觉模型，把图片改写为文字后再发给聊天模型；
- 当前模型不支持图片，视觉桥未配置/失败：放行原图，最终由 Pi 替换为占位文本。

所以 `input` 配错会直接改变行为：

- 错误地勾上图片：原图会发给可能不支持的上游，可能得到 400；
- 错误地不勾图片：原生视觉能力被 Pi 当成非视觉，图片可能被视觉桥二次描述，或最终被省略。

### 6.3 当前 PiDeck UI 缺口

- `AvailableModel.images` 已从 `pi --list-models` / `models.json` 得到，但普通模型选择器和附件入口没有据此做能力提示或发送前门禁；
- 附件仍可对所有 Pi 模型添加，最后才由 Pi/视觉桥处理；
- 配置页手动新增模型默认勾选图片输入，未知网关的默认值过于乐观；
- 视觉桥是否已配置、是否会接管当前图片，没有直接显示在当前模型/附件状态上。

DSH 的图片链路与 Pi 不同：`DshAgentManager` 会把图片转成 host 的 `PromptContentPart.image`，校验 PNG/JPEG/WebP/GIF 后发送，host/adapter 再按其模型目录能力处理；不能把 DSH 的 `input` 语义直接当成 Pi 的 RPC 能力查询替代。

## 7. 实施后的范围

用户已明确：**既有用户配置不能被覆盖，但新增模型应尽可能自适应。**

因此本轮建立两条配套链路：配置阶段识别模型本体、按来源补空字段；使用阶段由 Pi 的只读能力 cache 和 runtime RPC 过滤真实 thinking levels。能力模板写入仅发生在用户编辑/保存模型配置时，不能反向改变会话偏好或 DSH 配置。

### Phase A：构建期提取官方 catalog 的只读能力数据

PiDeck 已有一份本地规格匹配库：早期的 `resources/model-specs.db` 先被官方 `@earendil-works/pi-ai/dist/providers/data/*.json` 替代；当前再由构建脚本裁剪为随应用分发的 `resources/pi-ai-catalog.json` artifact，运行时不加载完整 pi-ai SDK。

这份原始 catalog 已包含：

- `contextWindow`；
- `maxTokens`；
- `reasoning`；
- `input`（含图片）；
- **`thinkingLevelMap`**；
- 模型级 `api` / `baseUrl` 元数据（条目提供时）。

`piAiBuiltinCatalog.ts` 现已保留 `thinkingLevelMap`，`ModelSpec` 现暴露完整 `input`、map、来源和匹配方式。配置阶段将当前 Pi 目录与内置目录合并为能力候选：精确 ID 可自动补空；唯一的名称别名可作为受控模板；不唯一或不安全的名称不自动写入。

第三方 provider 的 endpoint/协议不是 catalog 匹配目标，仍保留用户配置。候选只提供模型固有事实；运行时 probe 负责确认 Pi 实际可选档位。

### Phase B：启动时构建 Pi 权威 capability cache

catalog 能立刻展示容量、推理和图片事实，也能给出已知模型的候选档位；但最终“Pi 会接受哪些档位”必须由 Pi 自己回答，因为用户的 `models.json` 可能覆盖内置定义。

Pi 上游从 **0.81.0** 开始提供 `get_available_thinking_levels`，但它只能查询**当前进程已选中的模型**。因此欢迎页不应在每次打开 picker 时再启动 probe；应在应用 ready 后用一个一次性的 `PiModelCapabilityCache.refresh()` 后台 hydration 同时填充模型列表和精确思考档位：

1. 与现有模型列表预取同一时机启动一个 `pi --mode rpc --no-session --offline --no-themes --no-extensions --no-skills`，不阻塞主窗口或 renderer；这些旗标与现有全局 `pi --list-models` 的模型范围一致，避免启动期执行用户/项目扩展；
2. 先调用一次 `get_available_models`，缓存 Pi 解析后的完整 Model 快照（`contextWindow/maxTokens/input/reasoning/thinkingLevelMap`），并将其转换为现有 `AvailableModel` 列表；
3. 在**同一个已启动**的 probe 内，对每个可用模型顺序调用 `set_model → get_available_thinking_levels`，把 Pi 算出的精确 levels 存为 `provider + modelId` 的 capability 条目。`--no-session` 使 model change 只存在内存，`set_model` 未传 persist 也不会写全局默认；全程不发送 prompt 或调用模型推理；
4. hydration 完成后停止 probe。欢迎页和未启动的草稿 session 只读这份内存缓存，不在点击模型/思考 picker 时发 RPC；已有运行态继续直接问该 runtime；
5. `models.json`、`auth.json` 的表单保存、raw/import 写入、provider migration、Pi 更新，以及外部文件 watcher 检测到相关文件变化时，使 capability cache 和模型列表一起失效，以新的 generation 重建。旧 generation 的迟到结果不得覆盖新缓存；
6. Pi 不支持 RPC 或 hydration 失败时，继续走现有 `pi --list-models` / 本地 `models.json` 的兼容链路，并把 thinking 状态标为兼容 fallback，不伪装成已确认能力。

本机 Pi 0.84.3 实测（上述 fast flags）：`get_available_models` 返回 398 个模型、约 154KB，耗时约 605ms；同一 probe 顺序完成全部 398 次 `set_model → get_available_thinking_levels` 的总耗时约 657ms，全部成功。也就是说，完整启动 hydration 比现有一次 `pi --list-models` 冷启动多出的成本很小，却能避免用户每次换模型时重新查询。

这仍然只有 PiDeck ↔ Pi 的 stdio JSON-RPC 一条通信边界，不在 PiDeck 复制 Pi 的能力算法。现有 `pi --list-models` 可在旧 Pi 或 capability hydration 失败时继续担任兼容 fallback；长期可推动 Pi 提供一次返回所有模型已计算 levels 的 RPC，去掉批量 `set_model → get_available_thinking_levels` 循环。

### Phase C：运行态与全局统一为 capability cache，runtime RPC 仅兑底

运行中 Pi Agent 的思考强度**统一读同一份 `PiModelCapabilityCache` snapshot**，不再把 runtime RPC 当作展示主源；`get_available_thinking_levels` 只在「菜单打开 + idle + cache 未就绪/无该模型档位」时后台查一次，结果按 `sessionId + agentId + runtimeGeneration + provider + modelId` 缓存；模型切换或 runtime 替换后重新查询，晚到的旧 runtime 响应无法覆盖新 identity。**运行中（非 idle）不为展示发该 RPC，打开菜单只读 cache / 兼容档位，绝不被后台往返卡成 loading。**

| 场景 | 容量/图片/是否推理 | 可选 thinking levels |
|---|---|---|
| 欢迎页，Pi capability cache 就绪 | Pi 的完整 model snapshot | 启动/配置变更时已由 Pi 精确过滤 |
| 欢迎页，旧 Pi 或 cache hydration 失败 | `/list-models` 给出的字段或“未知” | 兼容 fallback，不标成精确能力 |
| 正在运行的 Pi Agent | runtime state / model list | 当前 runtime RPC，权威 |
| DSH | DSH host catalog | `reasoningEfforts`，继续独立处理 |

### Phase D：以能力卡片降低模型配置门槛

配置表在自动识别模型后展示能力卡：

```text
匹配：gpt-5.6（当前 Pi 目录，按名称匹配）
上下文：400K  最大输出：128K  图片：支持  推理：支持  映射档位：low / medium / high / xhigh / max
```

这张卡解释本次补空模板的来源，provider、baseUrl、API 协议和任何用户已填字段保持不变。模型选择后，欢迎页/草稿读取 startup cache，运行 Agent 读取 runtime cache，thinking picker 只列出 Pi 已确认的档位。

对于完全未知 custom gateway，表格仍保留 context、输出、图片、推理和 thinking map 的所有可编辑字段；不会隐藏模型或写入乐观默认。名称候选不足以唯一识别模型时保持“未报告”，用户可手动配置，随后 Pi runtime probe 会验证 Pi 实际允许的档位。

## 8. 实施门禁与测试矩阵

至少覆盖：

- 官方 catalog 精确匹配保留 `contextWindow/maxTokens/reasoning/images/thinkingLevelMap`，未命中不猜；
- known model 在欢迎页显示能力卡片，且不会修改 `models.json`；
- startup hydration 在单个 probe 内依次 `get_available_models → set_model → get_available_thinking_levels`，全程不发送 prompt；
- `reasoning=false`、无 map、部分 map、全 map 的 probe 结果均与真实 Pi runtime RPC 一致；
- 快速切换模型时，旧 probe 的异步结果不能覆盖新模型；
- Pi 版本、models/auth 配置的表单/raw/import 更新、provider migration 或外部文件 watcher 变更后 capability cache 失效；
- 旧 Pi 不支持 RPC 时显示“能力未知/兼容降级”，而非标成准确 7 档；
- 运行态仍优先使用现有 runtime RPC；
- DSH 继续使用 `reasoningEfforts`，不走 Pi probe；
- `input` 缺省 → Pi 视为 text-only；`input:image` → 原图直传；视觉桥配置完整/缺失/失败三条路径。

## 当前建议

先实现 Phase A/B/C：把现有官方 catalog 的能力完整读出来，并用 Pi 的只读 RPC probe 解决欢迎页精确 thinking levels。整个改动不改变模型配置，也不要求用户理解或手填思考映射。

## 已落地实现（2026-08 收敛）

> 经评审收敛为最小职责边界：**配置阶段只读 PiDeck 自带、由 pi-ai 构建期提取的 catalog artifact；capability cache 只服务输入框/思考强度；endpoint `/models` 实报字段参与自适应模板。** 外部 Pi 安装目录的 catalog、models-store.json、PiDeck 自身的 capability cache 都不再参与配置模板计算。

### 数据源边界（最终）

| 消费面 | 数据源 | 说明 |
|---|---|---|
| 欢迎页/草稿态模型与思考强度选择 | `PiModelCapabilityCache`（启动/配置变更时 hydration） | `listModelsReport` 优先返回 cache snapshot；无 runtime 时 `ThinkingPicker` 直接读 cache 的 `thinkingLevels` |
| 运行态 Agent 思考强度 | 同一份 `PiModelCapabilityCache` snapshot（统一展示源）；runtime RPC `get_available_thinking_levels` 仅作 idle + cache-miss 的后台兜底 | session-scoped，旧 runtime 迟到结果丢弃；运行中不为此发 RPC，绝不阻塞菜单 |
| 配置页自适应模板（新增/失焦/保存补空） | 构建期 `pi-ai` catalog artifact（`getPiAiCatalogIndex`） | `projects:get-model-spec` 只从 artifact 匹配；不读 cache、不读外部 Pi 目录 |
| 配置页自适应模板（重置/拉取） | endpoint `/models` 实报字段 > catalog artifact 模板 | `mergeAdaptiveModelTemplate`：endpoint 实报优先，catalog 补空 |
| DSH | DSH host catalog `reasoningEfforts` | 独立，不接 Pi probe |

### 关键改动

1. `resolveModelSpecFromPiCatalogs(input, index)` 移除 capability cache/runtime 参数，只从 bundled catalog 构建候选（`modelCapabilityResolver.ts`）。
2. `ConfigManager.fetchProviderModels` 不再用 bundled catalog 预填，返回纯 endpoint 数据；catalog 补空统一走渲染层 `projects:get-model-spec`（`ConfigManager.ts`）。
3. 新增自适应模板纯函数 `mergeAdaptiveModelTemplate` / `applyAdaptiveTemplateReset`（`utils/modelSpecAutoFill.ts`）：
   - 合并优先级：endpoint 实报字段 > bundled catalog 模板 > 空；
   - 重置 = 先清空 `contextWindow / maxTokens / input / reasoning / thinkingLevelMap`，再只写模板有值字段；模板未知的字段不落盘（交还 Pi 默认行为）；
   - 重置是用户显式动作，允许覆盖此前手填值；与「自动补全只填空字段」（`computeModelSpecPatches`）语义分开。
4. 重置按钮显式刷新 endpoint `/models`（失败也继续，listing 视为空），再按上述模板清空+重填（`ConfigModal.handleResetModelToAdaptive`）。
5. `ModelCapabilityCard` 展示**模型行当前有效配置**（不是旧模板快照），模板仅用于说明匹配到的标准模型与「重置为自适应」输入。用户手改任意能力字段后卡片立即反映新值。

### 已知取舍

- catalog artifact 的构建期来源固定为 `@earendil-works/pi-ai@0.85.0`；未来新于该版本的外部 Pi 模型仍可能不在 artifact 中。未配置/未匹配的模型保持空字段，由 endpoint 实报或用户手填，不猜容量默认值。
- **自适应未匹配时的思考兜底（2026-08 决策）**：目录/端点都没声明推理时，自适应模板与保存补全默认写 `reasoning: true` 并开放全部档位（`DEFAULT_OPEN_THINKING_MAP = {xhigh, max}`，`utils/modelSpecAutoFill.ts`），否则 Pi 按 `!reasoning → ["off"]` 只给 off，用户没有思考强度可选。端点/catalog 显式声明的 `reasoning: false` 或档位映射（含 null 禁用语义，如 MiniMax-M2.7）始终优先，不被默认值覆盖。
- 端点 `/models` 实报的 `reasoning / input / thinkingLevelMap` 在 `parseProviderModelsResponse` 完整保留（`parseProviderModels.ts`），参与自适应模板合并，不再被丢弃。
- **provider compat 联动（2026-08 决策）**：保存时 `deriveProviderCompat`（`utils/modelSpecAutoFill.ts`）检测该 provider 任一模型存在非空档位映射且 `reasoning !== false` → 自动写 `compat.supportsReasoningEffort: true`，否则 false。否则 pi 用 provider 级 compat 覆盖模型定义，用户选了思考强度也不发 `reasoning_effort`；旧版本无条件写 false，因此自动判定优先于已存在的 false（陈旧值非用户意图），显式 true 保留。UI 上的 supportsReasoningEffort 开关为显示/手动覆盖，下次保存仍按联动归一。
- capability cache 继续保留 Pi RPC 返回的完整模型字段（不只 provider/id/thinkingLevels），供视觉桥等既有消费方读取；配置模板计算不再消费它。
- 移除了 `enrichFetchedModelFromCatalog` / `lookupPiAiModelSpec` 等不再有调用方的 bundled catalog 导出。

### 统一标准（2026-08-29 收敛）

模型选择与思考强度统一为一个数据源：**`PiModelCapabilityCache` snapshot**。

1. **模型列表唯一来源 = cache**：欢迎页、草稿、运行态打开模型 picker 都只读 `projects:listModelsReport`（snapshot → 兼容 fallback）。运行中 Agent 不参与列表拉取，它只负责两件事：`set_model` 应用、busy 分支（`pickModelWhileBusy`）里的运行快照校验。
2. **思考强度唯一来源 = 同一 cache 的 per-model `thinkingLevels`**：打开任意 picker 直接读；runtime RPC 仅在 idle + cache-miss 时后台兑底；DSH 独立走 `reasoningEfforts`。
3. **设置保存即失效重建**：`configSaveModels` / `configSaveAuth` / custom Pi path 变更均触发 `refreshPiModelCatalogs()`（invalidate + 新 generation hydration），目录 watcher 兑底外部文件变更，选择器打开时 `ensure()` 等同一 generation 的在途结果 → 新增模型保存后即可在选择器看到。
4. **cache 不 gate 使用**：Pi Agent 每次 spawn 自行读 `models.json`（`--offline` 仅跳过启动期网络刷新）。cache 未刷新只影响展示；新模型只要在 `models.json`，新启动 Agent 的 `set_model` 直接成功，已运行 Agent 走既有 `needsRestart` 引导重启后生效。

运行态场景汇总：

| 场景 | 容量/图片/是否推理 | 可选 thinking levels |
|---|---|---|
| 欢迎页/草稿，cache 就绪 | Pi 的完整 model snapshot | cache 的 per-model `thinkingLevels`（hydration 已算好） |
| 欢迎页/草稿，旧 Pi 或 hydration 失败 | `/list-models` 字段或“未知” | 兼容 fallback，不标成精确能力 |
| 运行中的 Pi Agent | runtime state / record | 同一 cache snapshot；idle + cache-miss 时后台 runtime RPC 兑底，不阻塞 |
| DSH | DSH host catalog | `reasoningEfforts`，独立处理 |
