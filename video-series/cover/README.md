# 视频封面生成器

给 PiDeck 视频出封面图。纯静态 HTML、零依赖，双击就能用；
尺寸按 B 站 / YouTube / 小红书实际要的对齐。

| 封面源 | 用在 | 版式 |
|--------|------|------|
| `cover.html` | EP01–EP07 上手系列 | 左标题 + 右侧「设置页」示意面板 |
| `pi-or-dsh.html` | 介绍片「Pi Or Dsh？我全都要」 | 左标题 + 右侧「双运行时」卡（pi / DSH 两个 logo） |

两个文件共用同一套系列 token、外壳与导出链路，只换右侧卡片的版式；
`shot.cjs` 用 `--file` 选源，`check.cjs` / `check-pi-or-dsh.cjs` 各自自检。

## 快速用法

1. 双击要用的那份 HTML（浏览器打开，左边实时预览）
2. 右侧改文字（`cover.html`：期数标签 / 标题前半 / 金色强调 / 卖点 / 标签 / 落款；
   `pi-or-dsh.html`：问句 / 落点 / 卖点 / 两张运行时卡的名字与说明）
3. 底部选比例与倍率 → 点「导出 PNG」，图存到浏览器默认下载目录

命名形如 `EP07配置管理_封面_16x9_2x.png`、`PiOrDsh_封面_16x9_2x.png`
（`pi-or-dsh.html` 用 `slug` 字段做前缀）。

| 比例 | 逻辑尺寸 | 用来发 |
|------|----------|--------|
| 16:9 横版 | 1920×1080 | B 站 / YouTube 封面 |
| 3:4 竖版 | 1080×1440 | 小红书 / 抖音 |

倍率：`2×` 是 3840×2160 / 2160×2880（平台会自己压，压完更清晰），`1×` 就是平台标准尺寸。

## 命令行出图（批量 / 不开浏览器）

```bash
node shot.cjs                                 # 两种比例都出 2 倍图（默认 cover.html）
node shot.cjs --ratio 16x9 --scale 1          # 只出 16:9 的 1 倍图
node shot.cjs --ep "EP08 · 多项目" --title "pi" --accent "多项目协作" --lead "..." --chips "实操, 约 6 分钟"
node shot.cjs --file pi-or-dsh.html           # 出介绍片「Pi Or Dsh」封面
```

命令行覆盖只作用于本次出图，不改 HTML 里的默认内容；
`--ep/--title/--accent/--lead/--chips` 只对 `cover.html` 有意义。

## 自检

```bash
node check.cjs             # 15 项：cover.html（尺寸/溢出/导出保真/参数化/预览模式/示意面板增删改移/行数过多自动缩小/无网络字体）
node check-pi-or-dsh.cjs   # 13 项：pi-or-dsh.html（尺寸/溢出/导出保真/问句落点参数化/两张卡与两个 logo/无网络字体）
```

## 预览模式

面板右上角「预览 P」按钮（或按 `P`）把右侧操作区整个收起来，封面按整窗重新适配；按 `Esc`（或再按一次 `P`）退回。
输入框里打字时 `P` 不触发切换；只影响外壳预览，导出与默认内容不变。

## 改默认内容

- 面板里能改的字段：期数标签；品牌名 / 品牌后缀；标题前半 / 强调 / 卖点；三个标签；仓库地址 / 作者署名；示意面板的窗口标题 / 每一行（键、值、右侧胶囊，可增删行、可上下移）/ 底部一句话。
- `cover.html` 顶部就是这套默认值：`DEFAULT_STATE` + `ROWS`（`ROWS` 是示意面板的默认行，`s` 留空则不显示胶囊）。顶部 logo 是 pi 官方 TUI 彩色位标，源码在 `TUI_COLORS` / `TUI_CELLS`（色值取自 `src/renderer/src/components/app/piTuiLogoData.ts`）。
- 示意面板行数多时 `fitMock()` 把它整体等比缩小，避免撑破画布（自检里 14 行仍不溢出）。
- 配色、字号、间距在 `#cover-style` 里。**这套 token 与 `decks/generate_decks.py` 的 `SLIDE_CSS`
  是同一套系列 grammar**，改配色两处一起改，别让封面和正片不像一家人。
- `pi-or-dsh.html` 的默认值同样是顶部 `DEFAULT_STATE`（问句 / 落点 / 两张运行时卡 / 底部一句话 / `slug`）。
  两个 logo 都是源码内联的矢量：pi 是 `TUI_COLORS` / `TUI_CELLS` 的 4×4 像素 π，
  DSH 是 `DSH_LOGO`（DeepSeek 鲸鱼，path 取自 `src/renderer/src/components/session/SessionSourceBadge.tsx` 的 `DshLogo`）。
  问句里的 `Or` 会被 `markOr()` 自动压成灰色斜体；字段里没写 `Or` 就原样输出。
- `pi-or-dsh.html` 的标题是两行固定行（上行问句 `.q`、下行落点 `.a`，都是 `display:block`），
  故意不让浏览器折行——长标题折出第三种断句会毁掉「问句 / 落点」的对比。

## 两个坑（改之前先看）

1. **布局规则必须写进 `#cover-style`，不能只写在外壳 `<style>` 里。** 导出走
   「DOM → SVG foreignObject → canvas」，只内联 `#cover-style`；外壳里的 `*` 规则不会跟着走，
   漏掉 `box-sizing` 会让出图右边被裁掉一块（预览却正常）。`check.cjs` / `check-pi-or-dsh.cjs` 的缩略图比对专门守这条。
2. **只能引用系统字体、不许引外链图片。** 带 web font / 外链图导出会掉字丢图，两份 check 都会拦。
   右侧示意面板只写「设置页里有什么」、运行时卡只写「两个都在」，不下效果结论——结论留给正片讲。
