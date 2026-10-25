# 对话内图片渲染改造计划（Markdown 图 / 本地路径 / 工具结果图）

状态：阶段 1（渲染层）、阶段 2（`pideck-file://` 只读协议）已落地（2026-10-19）；阶段 3（工具结果图）探针已完成、结论可行，当日决定先记账暂不实施。
立项 2026-10-19，结论依据见文末「决策记录」，落地清单见「落地记录」。
起点：`docs/maintenance-domains.md` →「对话内图片渲染（Markdown img / 本地路径 / 协议取舍）」小节的现状盘点。
参照实现：dsh（本机 `F:\deepseek-harness`，只作设计参照，不引入任何依赖）。
目标：让「agent 把图贴给我看」在 **dev 与打包版行为一致**、**失败可诊断**、**历史不再白块**；不改会话 JSONL 结构。

## 1. 现状与证据

| 问题 | 现象 | 代码位置 |
| --- | --- | --- |
| Markdown `img` 裸渲染 | 无懒加载、无限高、无点击放大、失败即白块 | `src/renderer/src/components/session/MarkdownStream.tsx` 的 `components` 只覆盖了 `a`；样式仅 `.markdown-body img{max-width:100%}`（`src/renderer/src/styles/timeline.css`） |
| 只认 `file://` | `![](C:\a.png)`、`![](./chart.png)` 静默破图 | `markdownUrlTransform` / `defaultUrlTransform`（`MarkdownLinkCore.ts`）放行盘符路径但原样进 `src`；`data:` 被清空 |
| dev 全白 | dev 页源是 `http://localhost`，Chromium 拒 `file://` 子资源 | `src/main/index.ts` 的 `loadURL(devRendererUrl)` vs `loadFile`；CSP `img-src` 见 `src/renderer/index.html` |
| 工具结果图不可见 | 只显示「已读取图片」文案 | `src/renderer/src/components/session/timeline/toolCategory.ts`；主进程 `AgentManager.upsertToolMessage` → `formatToolDetail` 只出文本 |
| assistant image block 被丢 | 历史里的 image block 直接消失 | `src/main/pi/messageContent.ts` 的 `extractMessageText`：`if (typed.type === "image") continue;` |
| 无预览入口 | 时间线图片可点开预览，Markdown 图不行 | `ImagePreviewModal`（`SurfaceComponents.tsx`）只吃 `ImageContent`（data/ref），没有 `src` 形态 |

已具备、可直接复用的部分：`pideck-img://` 协议与内容寻址 blob store（`src/main/imagegen/ImageGenImageProtocol.ts`、`ImageBlobStore.ts`）、`shared/imageContentSrc.ts` 的 `imageContentSrc()` / `localImageUrl` 同类入口、`--shell` 级别的图片压缩与上限校验。

## 2. 参照 dsh：结论是「两条通道」，不是二选一

| dsh 做法 | 判定 | PiDeck 落法 |
| --- | --- | --- |
| **入库通道**：图从产生时就写 attachment store，会话只存 `ImageAttachmentRef{ attachmentId(sha256), mediaType, bytes, width, height }`；渲染时 `session.readAttachment()` 拿字节 → `blob:` URL，按会话绑定缓存并 revoke | ✅ 抄设计 | PiDeck 生图链路已是同一套（`ImageContent{ref}` + `pideck-img://`）；缺口是让「工具产出图」也走这里，而不是再造第二套 store |
| **借看通道**：Markdown 路径图不复制，走只读文件接口 `api/file?path=<绝对路径>`（桌面 `dsh-app://app/api/file`），host 侧校验 + 字节上限 + `no-store` + `nosniff` + CSP sandbox | ✅ 抄机制，**加严** | 新增 `pideck-file://` 只读协议：绝对路径 + **根白名单** + 扩展名白名单 + ≤32 MiB + `nosniff`。dsh 靠 fs sandbox 兜底，PiDeck 没有那一层，白名单必须自己写 |
| 失败降级：无 resolver 不渲染 `<img>`，只显示 alt；加载失败替换成「加载失败 · alt(或原路径)」 | ✅ 照抄 | `MarkdownImage` 组件的 failed 态，文案走 i18n |
| `recoverLocalImages`：整段唯一节点、未转义、扩展名为图片、路径含空格时，把被解析器拆坏的 `![alt](/abs/a b.png)` 还原成 image 节点 | ✅ 照抄 | 新增 remark 插件 `remarkRecoverLocalImages`（放 `src/renderer/src/utils/markdownPlugins.ts`） |
| 相对路径按会话 cwd 解析（`resolveWorkspacePath`），绝对路径才直读 | ✅ 照抄 | 纯函数 `resolveMarkdownImageSrc(url, ctx)` 里做，ctx 注入会话 cwd + 工作区根 |
| 尺寸规则（两档不同起源，别搞混）：**markdown 路径图** = `display:block` + `max-width: min(100%, 640px)` + `max-height: 360px`（contain）；**消息附件图**才是「单图长边 240、长宽比夹 [0.25, 4] 且裁切贴上/贴左」与「多图 64px 瓷砖」 | ✅ 均已对照吸收：markdown 图用前一套数值；**同段多图**直接借后一套的 64px 瓷砖 + 失败图标重试 | `MarkdownImage` 两档（`groupCount` 切）+ `remarkMarkMultiImageParagraphs` 标注 |
| 工具结果图有专属卡片，引用**只从 result content 取**、不从 meta 复制（防 hook 改过结果后显示旧图） | ✅ 抄原则 | 阶段 3；通用化为「任何工具结果里的 image block 都渲染成画廊」 |
| 准入：单图字节 / 每消息张数 / 总字节 / 像素 / 边长 + **魔数校验**（声明格式必须与解码一致） | 🟡 部分抄 | 只抄魔数校验；字节与张数上限已有，不引 sharp |
| 会话授权 → 字节 → blob URL → 手动 revoke（`historical-images.ts`） | ❌ 不抄 | 自定义协议由 Chromium 管缓存，少一层生命周期 |
| `data:` 进图片 vocabulary | ❌ 不抄 | 保持 `data:` 被拦，避免 base64 回流消息（生图侧已有 OOM 教训） |
| Markdown delegate / slot 注入体系 | ❌ 不抄 | 只需要一个 `resolve(url)` 函数 |

dsh 参照文件（需要复核时直接读）：`packages/client/ui-primitives/src/markdown/{render.tsx,local-image-syntax.ts}`、`packages/client/ui-primitives/src/{ImagePreview,ImageLightbox}.tsx`、`packages/client/ui-attachment/src/MessageImage.tsx`、`packages/api/session-controller/src/media-references.ts`、`packages/util/workspace-path/src/index.ts`、`packages/attachment/attachment/src/types.ts`、`packages/fs/tool-fs/src/read-image.ts`、`packages/client/ui-tool/src/client/tool/models/image-card-model.ts`、`packages/client/ui-primitives/tests/markdown-path-images.client.spec.tsx`。

## 3. 目标能力（parity 表）

| # | 能力 | 阶段 | 验收 |
| --- | --- | --- | --- |
| 1 | Markdown 图懒加载 + 限高 + 点击放大 | 1 | 长截图不再占满时间线；点击出 lightbox，Esc 关闭，焦点回缩略图 |
| 2 | 加载失败降级为「失败文案 + alt / 原路径」 | 1 | 源文件不存在时不再白块，文字里能看到原路径 |
| 3 | 路径容错：`file://`、盘符、相对路径（会话 cwd）、畸形写法带空格 | 1 | 四种写法都能出图；不能解析时降级为 alt |
| 4 | dev 与打包行为一致 | 2 | dev（`http://localhost` 页源）与打包（`file://` 页源）都出图 |
| 5 | 本地图读取收窄为白名单 | 2 | 白名单外路径返回 403；`..` 逃逸无效；非图片扩展名拒绝 |
| 6 | 工具结果里的 image block 可见 | 3 | 工具卡内出现画廊，点击可放大，历史重开后仍在 |
| 7 | WSL 项目（UNC 路径）不炸 | 2 | `\\wsl.localhost\...` 直接降级为 alt + 路径，不发请求 |

## 4. 分阶段实施

### 阶段 1：渲染层（不碰主进程，可独立交付）

改动清单：

- 新增 `src/renderer/src/components/session/MarkdownImage.tsx`
  - props：`{ src, alt, destination }`；三态 `loading | ready | failed`（`onLoad` / `onError`）。
  - `loading="lazy" decoding="async" referrerPolicy="no-referrer"`。
  - 限高：`max-h-[420px]`（视觉定稿时确认）；并排多图靠容器 `flex-wrap` 自然成行，不写死列数。
  - 点击打开 lightbox：把 `ImagePreviewModal` 里与 `ImageContent` 耦合的部分抽成 `src`-形态组件（`ImageLightbox`），`ImagePreviewModal` 改为复用它，避免复制第二套关闭/Esc/动作条逻辑。
  - failed 态：`{t("markdownImage.loadFailed")} · {alt || destination}`。
- 新增纯策略 `src/renderer/src/components/session/markdownImageSrc.ts`
  - `resolveMarkdownImageSrc(url, { cwd, workspaceRoot, fileProtocol })`：
    - `http(s):` 原样；`data:` 拒绝；`pideck-img:` 原样；`pideck-file:` 原样。
    - `file://` → 解码后按绝对路径处理 → `fileProtocol(abs)`。
    - 盘符路径（`^[a-zA-Z]:[\\/]`）与 UNC 判定：盘符 → 协议；UNC → `undefined`（降级 alt）。
    - 相对路径 → 依次尝试 `cwd`、`workspaceRoot`；两者都不可用返回 `undefined`。
  - 与 `MarkdownLinkCore.defaultUrlTransform` 的「盘符先于协议判定」口径保持一致，避免两处规则漂移。
- `MarkdownStream.tsx`：`components` 里补 `img`，并在 `remarkPlugins` 默认集合里加 `remarkRecoverLocalImages`（流式精简集合也要加，否则流式中看不到图）。
- `src/renderer/src/utils/markdownPlugins.ts`：`remarkRecoverLocalImages` —— 仅当「段落只有单个 text 节点、原文与节点值完全一致（未转义）、匹配 `!\[alt\]\((绝对/相对路径带空格).(图片扩展名)\)`、且扩展名属于 `png|jpg|jpeg|gif|webp|svg|bmp|avif`」时替换为 image 节点。**不处理**包含 `()`、`<>`、引号的路径（歧义太大，宁可不救）。
- i18n：`rendererCopy.zh-CN.ts` + `rendererCopy.en-US.ts` 加 `markdownImage.loading / loadFailed / open / lightboxClose`，然后 `node scripts/genZhTwCopy.mjs`。
- 测试（node --test + `tests/helpers/loadTsCommonJs.mjs`）：
  - `tests/markdownImageSrc.test.mjs`：http/data/file:///盘符/相对 cwd/相对 workspaceRoot/UNC 七种输入 → 期望输出（含"所有失败分支都返回 undefined"）。
  - `tests/markdownLocalImageRecovery.test.mjs`：用 unified + remark-parse + 插件对比，断言「带空格路径被还原」「转义写法不动」「含 `()` 的路径不动」「代码围栏内不动」。

验收：dev 里贴 `![x](file:///C:/…/a.png)`、`![x](C:\…\a.png)`、`![x](./a.png)` 三种写法都出图；删掉源文件后显示失败文案 + 路径；点开能放大。

### 阶段 2：主进程只读协议（替换裸 `file://`）

改动清单：

- 新增 `src/main/media/LocalImageProtocol.ts`
  - scheme：`pideck-file`（`pideck-file://local/?path=<encodeURIComponent(绝对路径)>`，与 `pideck-bg` 的 query 形态一致；不用 path 段，避免 Windows 盘符/空格编码歧义）。
  - 根白名单（`realpath` 后判定，防符号链接逃逸）：
    - 会话 cwd 与工作区根（`ProjectStore` / runtime 已能提供）；
    - `app.getPath("userData")`（dev 有 `-dev` 后缀，禁止硬编码）；
    - `<tmp>/pideck-shots`（**只放行这个子目录**，不放行整个 `%TEMP%`）。
  - 其它规则：路径必须绝对、拒绝 `\0` 与控制字符、扩展名白名单（与阶段 1 的图片扩展名一致）、`stat` 上限 32 MiB、`Content-Type` 按扩展名映射、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`。
  - 失败语义：非白名单/逃逸 403、不存在 404、超限 413。
- `src/main/index.ts`：`registerSchemesAsPrivileged` 增 `pideck-file`（`secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false`），`whenReady` 后注册 handler（参照 `registerImageGenImageProtocol` 的注册点）。
- `src/renderer/index.html` 的 CSP `img-src` 增 `pideck-file:`。
- `src/shared/imageContentSrc.ts` 增 `localImageUrl(absPath)`（编码规则与协议解析互为唯一来源）。
- 阶段 1 的 `fileProtocol` 参数接上 `localImageUrl`（dev/打包一致，不再出现 `file://`）。
- 测试 `tests/localImageProtocol.test.mjs`：白名单内 200、白名单外 403、`..` 逃逸 403、非图片扩展名 403、超大 413、不存在 404、UNC 路径 403。

验收：dev 与打包都能出图；白名单外路径不出图且控制台/主进程日志有可判定原因。

### 阶段 3：工具结果图片（探针已完成：可行；2026-10-19 决定先记账，未实施）

**探针结果（2026-10-19 实测当前会话 JSONL）**：pi 的 `toolResult.content` 确实带图片块——
实形是 `[{type:"text"},…,{type:"image", data:"<base64>", mimeType:"image/png"},…]`
（一次 `read` 的 95KB PNG → base64 130060 字符）。用户贴图同样是 `{type:"image", data, mimeType}` 内联。
⇒ **数据前提成立**，不是“拿不到”，而是主进程 `formatToolDetail` 只抽文本、image block 被丢掉，
所以工具卡只剩「已读取图片」四个字。

**实现约束（真的要做时照此执行）**：

- 落点：main 侧投影。工具结果 image block → 现有内容寻址 blob store → 工具消息带 `ImageContent{ref}` →
  工具卡缩略图（点击复用 `ImageLightbox`）。
- **绝不把 base64 塞进消息对象**：一次会话几张图就是上百万字符的堆内存，正是 2026-09 生图白屏事故的形态（`base64 不进会话`是生图侧的铁律）。源头在 pi（它把 base64 内联写进会话文件），
  PiDeck 只做**读时投影**，不参与写入。
- **不改写 pi 会话文件**（pi 活着禁改）：历史重载时按同一规则重新投影；blob put 是内容寻址的，幂等。
- 兜底：>32MiB / mime 不在白名单 / 投影失败 → 跳过并保留工具卡原有文本，不影响工具执行。
- 范围：`AgentManager.upsertToolMessage` + `SessionHistoryReader` 各一处投影 + 工具卡渲染 +
  测试（1 图 / 多图 / 无图 / 超大 / mime 非白名单）。

**为什么先不做**：价值最高场景是「agent 看图后下结论」——错误不易被发现时，「过程可见」才有意义；
日常不受影响。所以不做不阻塞任何东西，真痛了再上。

## 5. 非目标

- 不做「消息内 ref 存储」改造：路径图不复制、不入库，会话 JSONL 结构不变。
- 不引入 sharp 或任何图片处理库；不做 EXIF 归一化。
- 不支持 `data:` 内联图（保持被拦）。
- 不做「截图/贴图到会话」的工具 API（agent 行为归 pi）。
- 不改造 Markdown 渲染引擎（仍是 streamdown 唯一引擎）。

## 6. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 协议在个别环境下加载失败（企业策略/杀软） | 保持 `file://` 作为阶段 2 的临时回退开关（设置项，默认关），失败文案带路径便于诊断 |
| 白名单不覆盖 agent 实际落盘目录 | 表现为「失败文案 + 原路径」，属可诊断失败；`<tmp>/pideck-shots` 之外的临时目录由用户/agent 自行搬到项目内 |
| 大图（长截图）渲染内存 | 限高 + `loading="lazy"`；超大图（>32 MiB）在协议层 413 |
| WSL / UNC 项目 | 直接降级 alt（不请求），避免 Chromium 长时间挂起 |
| 画像并排时的布局抖动 | 缩略图容器给固定 height（按限高随宽度自适应），`overflow-hidden + shrink-0`（AGENTS.md 限高 flex 列规则） |

## 7. 验证门禁

- `npm run typecheck`；`npm run format`（biome）。
- 针对性单测：`node --test tests/markdownImageSrc.test.mjs tests/markdownImageGroups.test.mjs tests/markdownImageFallback.test.mjs tests/markdownLocalImageRecovery.test.mjs tests/localImageProtocol.test.mjs`；触动 `MarkdownStream` 时加跑 `tests/markdownStreamPolicy.test.mjs`、`tests/markdownPathTailTruncation.test.mjs`。
- 布局 e2e（真实 Electron + 真实渲染管线）：先 `npm run build:fast`，再 `npx playwright test e2e/markdown-image-layout.spec.ts`；CI 的 windows job 在 Build 之后已接同一个命令（`ci.yml` → `Markdown image layout e2e`），PR/main 自动跑，dev 直推不触发。断言：同段两张 = 两个 96×96 瓷砖且同一行、单图高度 360 上限、`src` 走 `pideck-file://`、点击开预览 + Esc 可关。它兜住的正是单测看不见的三层：hast 的 `%5C` 编码、`rehype-sanitize` 剥非白名单属性、Windows 8.3 短名。
- 手工 smoke（两种加载方式 × 四类图 × 三种失败）：

|  | 远程 http | 绝对路径 | 相对路径 | 畸形（带空格） |
| --- | --- | --- | --- | --- |
| dev | 出图 | 出图 | 出图 | 出图 |
| 打包 | 出图 | 出图 | 出图 | 出图 |

失败用例：文件不存在（失败文案 + 路径）、白名单外（不出图 + 失败文案）、超大文件（不出图，不卡 UI）。

## 8. 待决策

1. `<tmp>/pideck-shots` 由 PiDeck 创建并定期清理，还是只放行不管理？（建议：只放行，创建交给 agent；PiDeck 不新增清理任务）
2. 工具结果图若入 store，复用 `<userData>/imagegen/blobs` 还是新建 `<userData>/agent-images`？（建议复用，避免第二套 GC）
3. 单图限高取 420px 是否合适（取决于时间线宽度与截图类内容的可读性）。

## 决策记录

- 2026-10-19：确认「两条通道」而非单一方案；放弃「事后把路径图复制进内容寻址 store」的设想（等价于给会话打补丁，dsh 证明正解是**产生时入库**）。
- 2026-10-19：确认不做消息内 ref 改造，协议直读优先，缓存按抱怨再加。

## 落地记录

阶段 1 + 2（2026-10-19）——可加载 URL 从「裸 `file://`」换成协议直读，渲染层补齐降级/预览/路径容错。

| 文件 | 作用 |
| --- | --- |
| `src/shared/localImage.ts` | 协议名/体积上限/MIME 白名单/URL 生成与解析（主进程与渲染层唯一来源） |
| `src/main/media/localImageAccess.ts` | 纯判定：形态闸 400、边界闸 403、体积闸 413、`isInsideRoot` |
| `src/main/media/LocalImageProtocol.ts` | `protocol.handle` 注册、realpath 逃逸复检、响应头（`no-store`/`nosniff`/CSP sandbox） |
| `src/main/index.ts` | scheme 特权声明 + ready 后注册 + 白名单根（userData / 桌面 / `<tmp>/pideck-shots` / 聊天工作区 / 全部项目路径） |
| `src/renderer/index.html` | CSP `img-src` 增 `pideck-file:` |
| `src/renderer/src/components/session/markdownImageSrc.ts` | 目标 → URL 的解析规则（盘符/`file://`/相对 cwd/百分号解码/UNC 与 `~` 降级） |
| `src/renderer/src/components/session/MarkdownImage.tsx` | 懒加载、限高 420px、点击放大、失败降级「失败文案 · alt/原路径」 |
| `src/renderer/src/components/session/ImageLightbox.tsx` | 从 `ImagePreviewModal` 抽出的 `src` 形态浮层（portal 到 body；Markdown 图与附件图共用） |
| `src/renderer/src/utils/markdownPlugins.ts` | `remarkRecoverLocalImages`：救带空格路径被解析器拆坏的段落 |
| 测试 | `tests/markdownImageSrc.test.mjs`、`tests/markdownLocalImageRecovery.test.mjs`、`tests/localImageProtocol.test.mjs` |

与计划的偏差（有意）：

- 阶段 1 不再产出 `file://`，`fileUrlFromAbsolutePath` 直接删掉而不是留作阶段 2 的过渡——两个阶段同批交付，留过渡函数等于留死代码。
- Markdown 图未用 `<button>` 包裹（dsh 的做法）：没有 `inLink` 上下文时按钮可能与 `<a>` 嵌套产生非法 DOM，改为 `img` + `role="button"` + Enter/Space 打开预览。
- `ImageLightbox` 用 `createPortal(…, document.body)`：`image-preview-modal` 是 `absolute; inset: 0`，挂在时间线里只会覆盖会话栏。

验证到哪一步：

- `npm run typecheck` 通过；`npx biome format` 无改动。
- 单测：`markdownImageSrc` 12 项、`markdownLocalImageRecovery` 9 项、`localImageProtocol` 7 项，连同受影响的契约测试（`imageAndFileChipActions`、`modalKeyboardAccess`）与既有 markdown 套件共 79 + 78 项全绿。
- **未做** dev / 打包双态人工 smoke：需要重启宿主进程（当前会话即由它托管），按约定留给用户在下一轮启动后验证；协议失败时表现为「失败文案 + 原路径」，不会白块。

真机 smoke（dev 实例，2026-10-19）又暴露并修了两个单测看不见的坑：

1. **Windows 8.3 短名**：`app.getPath("temp")` 返回 `C:\Users\ADMINI~1\…`，消息里写的是 `C:\Users\Administrator\…`，`path.relative` 认为两者无关 → 白名单内的临时图片全判 403（现象：只有项目内的图能显示）。普通 `fs.realpath` **不展开中间段短名**，必须用 `realpath.native`（`src/main/media/nativeRealpath.ts`）。
2. **hast 层的百分号编码**：`mdast-util-to-hast` 把 `\` 编码成 `%5C`（`C:\Users\a` → `C:%5CUsers%5Ca`），而解析器先判形态后解码 → 盘符前缀不匹配，被当未知协议丢弃 → 图静默变 alt（现象：灰字 alt，无报错）。修复：本地目标先百分号解码再判形态。

教训：图片链路的测试必须喂 **hast 形态的 src**（或直接跑 `toHast`）；只测 mdast url 会漏掉编码层。另外失败态要绑定到具体 `src`（而不是布尔），否则流式期间的半截路径会把图片永久粘在失败态。

再次验证：真机四条正例（盘符 / `file://` / 相对 / 带空格）全部出图，`%TEMP%` 根目录的反例按预期 403 降级为「失败文案 + 原路径」。

吸收 dsh 的可用性细节（同批追加）：`ImageLightbox` 补上 `role="dialog"`/`aria-modal`、打开时焦点进关闭钮、**关闭后还原焦点**、Tab 圈在浮层内、Esc 捕获阶段 `stopPropagation`、backdrop 用 `mousedown` 判定（拖选松手不误关）；加载失败补「重试」按钮（清失败态 → img 重新挂载，文件修好后不用刷新会话）。

评审修复批次（2026-10-20，自审发现）：①保存/复制曾对本地图 100% 失败——`pideck-file://` 是 `corsEnabled:false` 的自定义 scheme，渲染层 `fetch` 直接 `TypeError: Failed to fetch`；改为 IPC `local-image:read-bytes`（`main/media/localImageRead.ts`，与协议共用同一份白名单判定），e2e 探针断言真拿到 `image/png` 且字节数 > 0。②下载名映射两份实现且不一致（svg/avif/bmp 被存成 `.png`），合并到 `shared/imageFilename.ts`。③白名单根每请求都做同步 `realpathSync.native`，改为 `localImageRoots.ts` 的 5s TTL + 并发合并缓存（规范化不能省：Windows 8.3 短名）。④图片被链接包裹时点图会跟着链接跳走，改为 `preventDefault + stopPropagation`。⑤e2e 不再依赖中文 aria-label，改用 `data-testid`。

评审第二批修复（2026-10-20，自审复核）：①去掉「解不出 URL 时的 96px 占位框」——流式期间本地图本来就不解析，占位框会先闪一下再变真图，统一改回 alt 文本（也净减一条分支）。②主进程读取改 `readBoundedImageFile`（open → stat → 定长 read → 长度校验），协议与 IPC 共用：`stat` 与 `readFile` 之间的 TOCTOU 会让体积闸形同虚设（被换成超大文件即整读进内存）。③hover 保存角标改用 Tailwind 具名 group（`group/image`），以后祖先加 `group` 不会误触发。

**已知限制**：远程图（http/https）能显示但**不能保存/复制**——渲染层 fetch 受 CORS/`connect-src` 限制，只给失败提示。要支持需主进程代取字节（会引入任意 URL 拉取面），暂不做。

下载/复制能力补回（2026-10-20）：改造前正文图片由 streamdown 内置组件渲染，右下角 hover 就有下载按钮；换成自研 `MarkdownImage` 后这个能力被静默丢掉（用户反馈）。现在 `MarkdownImageActions` 提供两条入口——预览浮层工具条（复制/保存）与大图 hover 角标；取字节走 `fetch(src)`，因此 **CSP `connect-src` 必须放行 `pideck-file:`**（漏了会出现「点保存没反应」）。

布局规则照 dsh 抄（2026-10-19）：markdown 单图 = `block` + `max-width: min(100%, 640px)` + `max-height: 360px`（contain，竖排）；**同段 ≥2 张** → 96px 方块瓷砖（cover）+ 点击开原图 + 失败给刷新图标重试（对应 dsh `MessageImage` 的 tile/error 形态）。数量靠 **React context** 传递：`p` 组件数出直接子级图片数（`imageCountInChildren`），经 `MarkdownImageGroupProvider` 下发给子树里的每个 `MarkdownImage`。**首版是用 mdast `data.hProperties` 打属性，真机全按单图渲染**——streamdown 内部跑 `rehype-sanitize` 的 `defaultSchema`，实测 `{src, alt, data-md-image-count}` 过一遍只剩 `{alt}`，属性通道根本到不了组件（2026-10-20 修正）。
