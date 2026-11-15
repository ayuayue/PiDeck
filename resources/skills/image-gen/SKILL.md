---
name: image-gen
description: 生成图片。当用户想让 AI 生成图片、插画、海报、头像等图像内容时使用。读取生图供应商配置，调用 OpenAI 兼容的图片生成 API（支持 OpenAI、火山方舟、SiliconFlow 三种方言与参考图），把生成的图片保存到项目目录。
---

# 图片生成（image-gen）

## 这是什么

当用户说「帮我画一张图」「生成一张海报」「做一个 logo」等请求时，用本技能
直接调用生图 API 出图。生成的图片保存为本地文件，交给用户在项目里使用。

生图供应商配置与「会话 LLM」完全分离：生图用的是 PiDeck 的 `imagegen.json`
（或用户直接提供的 baseUrl / apiKey / 模型），不碰 AI 对话用的模型配置。

## 第一步：确定模型与凭据

生图请求最少需要三样：**baseUrl + apiKey + 模型 id**。按优先级取：

1. **读 PiDeck 生图配置**（如果用户在用 PiDeck）：

   | 平台 | 配置路径 |
   |------|----------|
   | Windows 安装版 | `%APPDATA%\PiDeck\imagegen.json`（即 `C:\Users\<用户>\AppData\Roaming\PiDeck\imagegen.json`） |
   | Windows 便携版 | `<exe 同目录>\data\imagegen.json` |
   | macOS | `~/Library/Application Support/PiDeck/imagegen.json` |
   | Linux | `~/.config/PiDeck/imagegen.json` |

   旧版数据目录名为 `pi-desktop`，新首启已自动改名为 `PiDeck`；若 `PiDeck` 下没有该文件，再回退查同名 `pi-desktop` 路径。

   文件结构：

   ```jsonc
   {
     "providers": [
       {
         "id": "ig-1",
         "name": "OpenAI 或 Ark",
         "baseUrl": "https://api.openai.com",   // 根地址，端点按规则推导（见下）
         "apiKey": "sk-xxxx",
         "models": ["gpt-image-1"],             // 该供应商可选模型
         "extraParams": { "size": true, "output_format": false, "watermark": true },
         "referenceMode": "none | edits | image-field",   // 参考图 API 形态
         "apiStyle": "openai | siliconflow"                // 字段名/响应方言
       }
     ],
     "activeProviderId": "ig-1",   // 用户上次选中的供应商
     "activeModel": "gpt-image-1"  // 用户上次选中的模型
   }
   ```

   - **默认用 `activeProviderId` + `activeModel`**：用户上次选的，通常是想要的。
   - 模型必须在该供应商的 `models[]` 里；如果有多个模型，**让用户确认用哪个**（用户会指定）。

2. **读不到配置 / 用户不在 PiDeck 里**：询问用户三样东西——
   `baseUrl`、`apiKey`、`模型 id`。并顺手问是否需要参考图（图生图）。

## 第二步：确定是否有参考图

用户可能要求「基于这张图改一下」（图生图 / 局部编辑）。有参考图时：
- 让用户提供图片的**文件路径**，或直接上传。
- 把图片转成 base64 / data URI 备用（见下文各形态）。
- **若供应商 `referenceMode` 是 `none`**：该供应商不支持图生图，直接告诉用户
  「这个供应商没开启参考图能力」，不要硬发图。

参考图约束（与 PiDeck 一致）：≤ 4 张，支持 png/jpeg/webp。

## 第三步：拼端点 URL

`baseUrl` 是根地址，生图端点按下面规则推导（不要盲猜）：

- 已经以 `/images/generations` 结尾 → 直接用。
- 以版本段结尾（`/v1`、`/v1beta`、`/api`、`/api/v3` 等）→ 直接追加 `/images/generations`。
  - 例：`https://ark.cn-beijing.volces.com/api/v3` → `.../api/v3/images/generations`
- 裸根地址 → 补 `/v1` 再追加。
  - 例：`https://api.openai.com` → `https://api.openai.com/v1/images/generations`

参考图走 `edits` 形态时，把上面结果里的尾段 `/images/generations` 换成 `/images/edits`。

## 第四步：发请求（三种方言）

鉴权一律 `Authorization: Bearer <apiKey>`。**apiKey 只放 header，绝不写进日志、对话回显、生成的文件名或注释里。**

### 方言 A：OpenAI 兼容（apiStyle=openai，默认）

无参考图或 `referenceMode=image-field` 时用这个：

```bash
curl -sS "$EP/generations" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"<提示词>","n":1,"response_format":"b64_json"}'
```

- 可选字段**只在用户/配置显式开启时才发**（避免未知字段 400）：
  - `size`：官方尺寸，如 `"1024x1024"`（OpenAI）或 `"2K"`（方舟）；
  - `watermark`：`true/false`（方舟支持，OpenAI 官方不支持）；
  - `output_format`：`"png"` / `"jpeg"`（文件编码，seedream 5.0 支持）。
- `response_format:"b64_json"` 固定要发：图片直接以 base64 返回，不依赖 24h 临时 url。
- **参考图（image-field）**：方舟 seedream 风格，图片作为 data URI 数组放进 JSON 体：

  ```jsonc
  { "model": "...", "prompt": "...", "n": 1, "response_format": "b64_json",
    "image": ["data:image/png;base64,<base64>"] }
  ```

- **响应取图**：`data[0].b64_json`；如果只有 `data[0].url`，则再 GET 该 url 下载图片字节。

### 方言 B：edits（referenceMode=edits，OpenAI gpt-image-1 风格图生图）

参考图多张、局部编辑走 multipart 到 `/images/edits`：

```bash
curl -sS "$EP/edits" \
  -H "Authorization: Bearer $KEY" \
  -F "model=gpt-image-1" -F "prompt=<提示词>" -F "n=1" \
  -F "image[]=@ref1.png" -F "image[]=@ref2.png"
```

- `image[]` 可多张；`size` 同样只在开启时才加 `-F "size=..."`。
- 响应与 generations 一致：取 `data[0].b64_json` 或 `data[0].url`。

### 方言 C：SiliconFlow（apiStyle=siliconflow）

字段名与响应结构都不同：

```bash
curl -sS "$EP/generations" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<模型>","prompt":"<提示词>"}'
```

- 尺寸字段是 **`image_size`**（不是 `size`），且仍只在开启 `size` 时发；
  如 `"image_size":"1024x1024"`。
- 参考图是**单个 string**（不认数组），取第一张拼 data URI：
  `"image":"data:image/png;base64,<base64>"`。
- **无** watermark / output_format / response_format 概念，一律不发。
- **响应取图**：`images[0].url`（无 b64_json、无 data 数组）→ GET 下载该 url 得到图片字节。

### 下载 url 型图片

若响应只给了 url：`curl -sS "<url>" -o out.bin`，把返回字节当图片内容保存
（url 一般与 baseUrl 同源，直接取即可）。

## 第五步：保存结果到项目目录

1. 把图片字节/解码后的 base64 写进**当前项目目录**：
   - 默认放 `assets/` 或 `images/`；没有就建，或按用户指定路径。
   - 文件名用简短语义名（英文、连字符），如 `hero-banner.png`、`app-icon.png`；
     重复则不覆盖，加 `-2` 后缀。
2. 图片格式（png / jpeg）以返回内容为准；base64 解码示例：

   ```bash
   # 假设 base64 已存在变量 B64 里（去掉可能的 data:...;base64, 前缀）
   printf '%s' "$B64" | base64 -d > assets/hero-banner.png
   ```

3. 完成后**告诉用户文件保存路径**，并把图片信息（尺寸、格式、路径）简述一句。

## 安全边界（必须遵守）

- **apiKey 绝不回显**：不写进对话、日志、脚本注释、文件名；打码再展示。
- 提示词是用户内容，原样传递；模型/供应商 id 按白名单取。
- 发请求用参数数组 / 双引号包裹，不要 shell 拼插不可信内容。
- 失败时把服务端返回的**错误正文**给用户看（脱敏），帮助判断是 key 错、baseUrl 错还是额度/审核拒绝。

## 常见失败与排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 401 / 403 | apiKey 错或没权限 | 让用户核对 key |
| 404 / 405 | baseUrl 拼错端点 | 按第三步规则重算 URL |
| 400 unknown field | 发了厂商不支持的字段（size/watermark/output_format） | 去掉未开启的可选字段重试 |
| 返回空、没有图片 | 方言不匹配（如把 SiliconFlow 当 OpenAI 读） | 按第四步对应方言解析响应 |
| 网络不通 | 需要代理 | 国内访问 OpenAI 官方可提示用代理（本地端口 7890） |