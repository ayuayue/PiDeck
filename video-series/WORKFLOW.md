# PiDeck 视频制作工作流

本目录是一套**可复用**的「文案 → HTML 幻灯片 → TTS 旁白 → 成片」流水线，用于 PiDeck 上手系列（及后续同类教程视频）。

> **Git 只提交流程与文案源，不提交 PPT 成片 / 分片 / 截图缓存。**  
> 生成物已被 `video-series/.gitignore` 与根目录 `.gitignore` 忽略。

---

## 1. 目录里什么要提交、什么不要

### 建议提交（源）

| 路径 | 作用 |
|------|------|
| `WORKFLOW.md` | 本说明：怎么跑通、怎么复用 |
| `publish-copy.md` | 分集标题 / 简介 / 公共链接 / QQ 群 |
| `requirements.txt` | Python 依赖 |
| `templates/deck_index.html` | 幻灯片聚合壳（概览墙 + 翻页） |
| `decks/generate_decks.py` | **幻灯片内容源**：每集结构、文案、版式 CSS |
| `pipeline/sync_assets.py` | 从 `docs/images` 同步产品截图 |
| `pipeline/render_one_slide.py` | 单页试跑：截图 + TTS + 一页 MP4 |
| `pipeline/render_episode.py` | 整集渲染：旁白脚本 + 批量合成 |
| `pipeline/concat_series.py` | 多集成片拼接合集 |
| `EP0X-narration.md`（可选） | 纯旁白长文稿，便于改词 |
| `cover/*.html` + `shot.cjs` + `check*.cjs` | **视频封面源**：`cover.html`（EP 系列）/ `pi-or-dsh.html`（介绍片「Pi Or Dsh？我全都要」），改文字/比例 → 导出 16:9（1920×1080）/ 3:4（1080×1440）封面 |
| `poster/` | 与正片无关、作者自用：充值价目海报生成器（`price.mjs` 改价 → 出图） |

### 不要提交（生成物）

| 路径 | 说明 |
|------|------|
| `decks/EP0*/`、`decks/index.html` | 生成的 HTML PPT |
| `decks/assets/*.png` | 从 `docs/images` 复制来的截图缓存 |
| `pipeline/EP0*/` | 每集截图 / mp3 / clips / 成片 |
| `pipeline/*.mp4` | 合集等输出 |
| `pipeline/demo/` | 早期单页试验输出 |
| `cover/*.png` | 封面出图（源是 `cover/cover.html`，图随时重出） |
| `poster/*.png` ⚠️ 例外要提交 | 价目海报成品图：根 README 引用了它（`docs/images/gpt-recharge-price.png` 同源） |

产品**源截图**放在仓库已有目录：`docs/images/`（例如 `files.png`、`piEnvCheck.png`）。

---

## 2. 通用脚本一览

```
文案源
  decks/generate_decks.py     ← 改幻灯片文案 / 版式 / 插图路径
  pipeline/render_episode.py  ← 改旁白（TTS 文案）

资源
  docs/images/*.png           ← 产品截图源
  pipeline/sync_assets.py     ← 同步到 decks/assets

生成
  decks/generate_decks.py     → decks/EP0X/slides + index.html
  pipeline/render_one_slide.py→ 单页预览 MP4
  pipeline/render_episode.py  → pipeline/EP0X/EP0X-full.mp4
  pipeline/concat_series.py   → pipeline/PiDeck-full-series.mp4
```

| 脚本 | 是否通用 | 说明 |
|------|----------|------|
| `sync_assets.py` | ✅ 通用 | 任意 `docs/images` → `decks/assets` |
| `generate_decks.py` | ⚠️ 半通用 | 引擎通用，**内容是本系列**；新系列可复制后改 `EPISODES` |
| `render_one_slide.py` | ✅ 通用 | 任意 HTML 幻灯片 + 任意文案 |
| `render_episode.py` | ⚠️ 半通用 | 管线通用，`EPISODE_SCRIPTS` 绑定本系列旁白 |
| `concat_series.py` | ✅ 通用 | 按集号拼接已有 MP4 |
| `templates/deck_index.html` | ✅ 通用 | 多页 deck 播放壳 |

---

## 3. 环境准备（一次性）

在仓库根目录：

```bash
# Python 依赖
python -m pip install -r video-series/requirements.txt

# Playwright 浏览器（首次）
python -m playwright install chromium

# 系统需已安装 ffmpeg，且在 PATH 中
ffmpeg -version
```

可选：本机 Edge-TTS 走代理（网络不稳时 `render_episode.py` 会先试 `http://127.0.0.1:7890`）。

---

## 4. 标准流水线（跑通一整集）

在**仓库根目录**执行：

```bash
# 1) 同步最新产品截图
python video-series/pipeline/sync_assets.py

# 2) 根据 generate_decks.py 生成 HTML 幻灯片
python video-series/decks/generate_decks.py

# 3) 浏览器预览某一集 PPT（可选）
# 打开 video-series/decks/EP02/index.html
# Space / ← → 翻页，ESC 回概览

# 4) 单页试跑（可选，验证音色与排版）
python video-series/pipeline/render_one_slide.py ^
  --slide video-series/decks/EP02/slides/01-cover.html ^
  --text "PiDeck 上手系列第二集。安装与环境检测。"

# 5) 渲染整集
python video-series/pipeline/render_episode.py --ep EP02

# 6) 多集都渲染完后，拼合集
python video-series/pipeline/concat_series.py
```

输出：

- 单集：`video-series/pipeline/EP0X/EP0X-full.mp4`
- 合集：`video-series/pipeline/PiDeck-full-series.mp4`

---

## 5. 改内容时改哪里

| 你想改… | 改这个文件 | 然后执行 |
|---------|------------|----------|
| 幻灯片标题 / 要点 / 插图 | `decks/generate_decks.py` 里对应 `EPISODES["EP0X"]` | `generate_decks.py` → `render_episode.py --ep EP0X` |
| 旁白口播词 | `pipeline/render_episode.py` 里 `EPISODE_SCRIPTS` | `render_episode.py --ep EP0X` |
| 产品截图 | `docs/images/xxx.png` | `sync_assets.py` → 再生成 + 渲染 |
| 音色 / 语速 | `render_episode.py` 顶部 `VOICE` / `RATE` / `PITCH` | 重渲对应集 |
| 发布标题简介 | `publish-copy.md` | 无需重渲 |

**注意：** 幻灯片文案和旁白是两套源，改一边时记得同步另一边，避免「画面写 A、嘴里说 B」。

---

## 6. 单页试跑（推荐先验证再批量）

```bash
python video-series/pipeline/render_one_slide.py \
  --slide video-series/decks/EP05/slides/03-at-file.html \
  --text "文件引用很简单：在输入框输入艾特，选择项目文件。"
```

默认输出：`video-series/pipeline/demo/preview.mp4`。

---

## 7. 后续系列怎么复用

### 方案 A：继续做 PiDeck 新一集

1. 在 `generate_decks.py` 增加 `EPISODES["EP07"] = [...]`
2. 在 `render_episode.py` 增加 `EPISODE_SCRIPTS["EP07"] = [...]`
3. `sync_assets` → `generate_decks` → `render_episode --ep EP07`
4. 更新 `concat_series.py` 的默认集列表或命令行传 `--eps`
5. 更新 `publish-copy.md` 标题简介

### 方案 B：开全新系列（其它产品）

1. 复制整个 `video-series/` 为例如 `video-series-other/`
2. 清空 / 重写 `generate_decks.py` 的 `EPISODES`
3. 清空 / 重写 `render_episode.py` 的 `EPISODE_SCRIPTS`
4. 产品图放到对应 `docs/images` 或改 `sync_assets.py` 源目录
5. 依赖与 `templates/deck_index.html` 可原样复用

管线骨架始终是：

```
sync 截图 → generate HTML → TTS + screenshot → ffmpeg 分片 → concat 成片
```

---

## 8. 依赖与故障排查

| 现象 | 处理 |
|------|------|
| `No module named edge_tts` | `pip install -r video-series/requirements.txt` |
| Playwright 找不到浏览器 | `python -m playwright install chromium`；或本机已有 `ms-playwright/chromium-*/chrome.exe`（脚本会探测） |
| Edge-TTS `NoAudioReceived` | 检查网络；脚本会优先走 `127.0.0.1:7890` 代理再直连 |
| 截图空白 / 裂图 | 先 `sync_assets.py`；确认 `generate_decks` 里图片路径为 `../../assets/xxx.png` |
| 成片仍是旧画面 | 确认已重跑 `generate_decks` + `render_episode`；合集需再跑 `concat_series` |
| Windows 控制台中文乱码 | 脚本已 `reconfigure(utf-8)`；必要时 `chcp 65001` |

---

## 9. 发布文案

分集标题、简介、标签、公共 GitHub / QQ 群信息见：

**`video-series/publish-copy.md`**

---

## 10. 推荐提交到 Git 的文件清单

```
video-series/
  WORKFLOW.md
  publish-copy.md
  requirements.txt
  .gitignore
  templates/deck_index.html
  decks/generate_decks.py
  pipeline/sync_assets.py
  pipeline/render_one_slide.py
  pipeline/render_episode.py
  pipeline/concat_series.py
  EP01-narration.md … EP06-narration.md   # 可选
```

不要 `git add` 整个 `pipeline/EP0*` 或 `decks/EP0*`。

快速检查是否误加产物：

```bash
git status video-series
# 不应出现 *.mp4 / pipeline/EP0* / decks/EP0*
```

---

## 11. PiDeck AI 日更（`daily/`，另一条流水线）

> 上手系列（`decks/` + `pipeline/`）是**长教程合集**；日更是**每天一条 60–90 秒短视频**。
> 两条流水线独立，目录、脚本、产物都不共用。

### 11.1 目录

```
daily/
  config/series.json      栏目配置：账号、平台、画幅、时长区间、内容配比、音色、链接
  prompts/daily-script.md 写稿 prompt（喂给写稿模型，输出定稿 JSON）
  scripts/YYYY-MM-DD.json 定稿脚本：一份 JSON 描述整期（唯一事实源）
  topics/build_pool.py    选题池：挖 CHANGELOG / 公告 / 维护域文档 / git log / gh issue
  templates/deck_css.py   幻灯片设计语言 + 动效层（16:9 + 3:4 双画幅）
  pipeline/daily_deck.py  脚本 JSON → 整集单页 HTML（所有屏叠一页，逐屏带时间轴变量）
  pipeline/timeline.py    纯计算：各屏时长 → 整集时间轴 → 图层出入场窗口
  pipeline/subtitles.py   SRT 解析 + 整集一份 ASS（折行、淡入、去悬空标点）
  pipeline/render_motion.py 逐帧渲染：定位 CSS 动画时间轴 → PNG 管道 → ffmpeg 编码
  pipeline/render_daily.py 渲染编排：配音 → 时间轴 → 音轨 → HTML → ASS → 成片
  pipeline/publish_copy.py 发布文案：B 站 / 竖版 / 动态
  probe_motion.py         按时刻抽帧验收（不重渲，秒级出图）
  tests/test_daily_pipeline.py 纯逻辑单测（32 条）
  publish/YYYY-MM-DD.md   发布文案成品（可提交）
  out/YYYY-MM-DD/         渲染产物（可重新生成，不提交）
```

### 11.2 一天的工作流

```bash
cd video-series/daily

# 1) 选题：从仓库真实素材里挖候选（技巧 / 更新 / 日志三类）
python topics/build_pool.py --days 14

# 2) 写稿：把 prompts/daily-script.md + 选题喂给写稿模型，产出 scripts/<date>.json
#    （人工核对功能真实性与口径，必要时手改）

# 3) 出片：一条命令跑完两个画幅
python pipeline/render_daily.py --script scripts/2026-10-20.json
#    产物：out/2026-10-20/2026-10-20-16x9.mp4 与 2026-10-20-3x4.mp4

# 4) 发布文案
python pipeline/publish_copy.py --script scripts/2026-10-20.json
#    产物：publish/2026-10-20.md（含 B 站标题/简介/标签/动态 + 竖版标题/简介）

# 5) 人工审核后自己上传（B 站 / 抖音 / 小红书）
```

### 11.3 常用参数

| 命令 | 作用 |
|------|------|
| `render_daily.py --formats 16x9` | 只出一个画幅（调版式时快一半） |
| `render_daily.py --no-tts` | 复用已有音频，只重烧画面（改字幕样式时用） |
| `render_daily.py --force-tts` | 忽略缓存重新配音 |
| `render_daily.py --limit 15` | 只渲前 15 秒（试片用，整集重渲约 3 分钟/画幅） |
| `render_daily.py --fps 24` | 降帧率（默认 30） |
| `daily_deck.py --script ... ` | 只出 HTML，不配音（预览排版） |
| `probe_motion.py` | 按时刻抽帧到 `out/<date>/probe/`，秒级验收画面 |

### 11.4 脚本 JSON 结构

```jsonc
{
  "date": "2026-10-20",
  "episode": 1,
  "kind": "tip",                       // tip 技巧 / update 更新 / devlog 日志
  "title": "在 PiDeck 里用 @ 引用文件，不用再手打路径",
  "epTag": "Day 001",
  "formats": ["16x9", "3x4"],
  "voice": { "name": "zh-CN-YunxiNeural", "rate": "-10%", "pitch": "-2Hz" },
  "slides": [
    {
      "id": "01-hook",                 // 两位序号前缀，决定顺序
      "type": "hook",                 // hook/cover/steps/bullets/shot/quote/cta
      "title": "还在手打文件路径？",
      "lead": "想让 AI 读你项目里的文件，敲一个 @ 就够了。",
      "narration": "还在手打文件路径？……"   // 口播词，逐 slide 一段 TTS
    },
    {
      "id": "02-picker",
      "type": "shot",
      "image": "docs/images/files.png",     // 仓库 docs/images 下真实文件
      "crop":    { "x": 0.145, "y": 0.45, "w": 0.30, "h": 0.45 },  // 16:9 裁剪框（0..1 比例）
      "crop3x4": { "x": 0.155, "y": 0.46, "w": 0.265, "h": 0.42 }, // 竖版裁剪框，缺省回退 crop
      "caption": "输入框里敲 @，项目里的文件直接列出来",
      "narration": "……"
    }
  ],
  "publish": { "bilibili": {...}, "vertical": {...}, "dynamic": "……" }
}
```

`crop` / `crop3x4` 是 **0..1 的比例框**（x/y/w/h），不是像素。产品截图原图多在 2560×1380，
整屏缩到窄画幅里只剩一条，必须裁到「弹窗/面板」那块才看得清。裁剪用 Pillow，
缺 Pillow 时退化为不裁剪（出片优先于构图）。

### 11.5 动效管线：动画怎么做出来的

成片不是「一张张静帧拼的」，而是**整集一页 HTML**：

1. `timeline.py` 把各屏时长排成时间轴，每屏得到一个图层窗口（`enter_at` / `exit_at`）。
2. `daily_deck.py` 把所有屏写成**同一页**里叠放的绝对定位图层，每层带 `--in` / `--out` 两个 CSS 变量；
   入场 stagger、交叉溶解、进度条、背景漂移、首尾淡入淡出全是 CSS keyframes（`templates/deck_css.py`）。
3. `render_motion.py` 用 Playwright 把 `document.getAnimations()` 全部 `pause()` 后把 `currentTime`
   定位到当前帧，逐帧截图（PNG）写进 ffmpeg 的 stdin 管道，与音轨、字幕共用同一套时间轴。
   CSS `animation-delay` 的语义会被完整还原（delay 3s 的元素在 currentTime=3.2s 时才出现）。
4. `subtitles.py` 把各屏 SRT 按时间轴偏移拼成**整集一份** ASS（分屏各烧各的会让字幕跟着画面闪），
   ffmpeg 用 `ass=` 滤镜烧进画面。

动效调整都在 `templates/deck_css.py` 里改（class 名：`.rise` `.rise-soft` `.pop` `.rule` `.reveal`），
改完跑 `daily_deck.py` + `probe_motion.py` 抽帧看效果，不用重渲整集。

### 11.6 字幕与编码的坑（都踩过）

1. **不能直接用 `subtitles=xxx.srt:force_style=...`**。SRT 没有分辨率信息，ffmpeg 内部转 ASS 时
   固定用 384×288 作脚本分辨率，libass 再按画面尺寸放大——26 号字在 1080p 下会变成近 100px，
   直接盖住画面。必须自己写 ASS 头，显式写死 `PlayResX/PlayResY` = 画幅尺寸。
2. **libass 不会给无空格的中文断行**（只在空格/连字符处断），长句会顶出画面两侧。
   `wrap_cjk()` 按字宽预估预折行（尽量在标点后断、避头尾），再用 ASS 的 `\N` 硬换行。
   每行字数上限在 `templates/deck_css.py` 的 `FORMATS[*].subtitle.max_em`。
3. **ASS 的 `Dialogue` 字段数必须与 `Format` 声明一致（10 个）**。多写一个空字段，
   libass 会把正文顶偏，并在行首多出一个杂字符（表现为字幕开头凭空多个「，」）。
4. **edge-tts 断句会把标点甩到下一条开头**（字幕行首孤零零一个「，」）。`trim_cue_text()` 削掉首尾悬空标点。
5. **ffmpeg 的 stderr 不能走 PIPE**：管道写满时 ffmpeg 阻塞，而我们还在往它 stdin 灌帧 → 直接死锁。
   `render_motion.py` 把 stderr 落到临时文件。
6. **浏览器中途崩了不能让整条渲染挂住**：页面是确定性的，`render_motion.py` 捕获异常后重开浏览器
   从当前帧继续（最多重启 3 次）。
7. **不要用 ffmpeg 的 `crop` 表达式做推镜**：`crop=w='iw/(1+0.06*t/3)'` 里的 `t` 不会逐帧重算，
   会报 `Nothing was written into output file, because at least one of its streams received no packets`。
   运镜一律用 CSS `transform: scale()`。
8. **时长以解码后的 PCM 为准**：mp3 容器时长带编码器填充，按屏各烧各的再拼会累积 1.5～2.1s 漂移。
   `decode_pcm()` 的样本数是权威时长，画面、字幕、音轨三者共用同一套秒数。
9. **烧录字幕会压住画面文案**：截图页的图是满屏的，字幕一上来就盖在图上。
   `templates/deck_css.py` 里的 `--sub-band`（16:9 = 230px，3:4 = 240px）是底部字幕安全区，
   `.layer.has-img .layer-in` 把它排成下内边距，把图整体顶上去；纯文字页不挂 `has-img`，保持垂直居中。

### 11.7 提交

只提交 `config/ prompts/ scripts/ templates/ pipeline/ topics/ tests/ publish/<date>.md`；
`daily/out/` 与 `daily/publish/pool.*` 已在 `.gitignore` 里忽略。

---
