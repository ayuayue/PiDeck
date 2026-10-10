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
| `cover/cover.html` + `shot.cjs` + `check.cjs` | **视频封面源**：改文字/比例 → 导出 16:9（1920×1080）/ 3:4（1080×1440）封面 |
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
