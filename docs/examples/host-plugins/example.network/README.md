# 受控网络 API 示例

可直接导入的静态宿主插件：同一面板分别演示 **HTTPS API** 和 **已经运行的本地服务**。没有 `sessions.read` 权限，不读取会话；加载面板只渲染文案，点击按钮才请求。PiDeck 不执行 BAT、不启动服务。

## 安装前先改清单

1. 把 `pideck-plugin.json` 的 `network.httpsOrigins` 中 `https://api.example.com` 换成你实际使用的公网 HTTPS API origin（协议 + 域名 + 可选端口，不带路径、查询或通配符）。
2. 把 `app.html` 的 HTTPS 输入框初始 URL 换成该 origin 下的接口路径。占位地址不是可用的测试服务。
3. 如果有本地服务：自行启动可信服务；将 `network.localPorts` 中的 `4187` 改成实际端口，并同步本地输入框 URL。只允许 `http://127.0.0.1:<明确端口>`；`/api/health` 只是示例路径，并不保证你的服务提供它。
4. 不需要某一类网络时，同时删除对应的权限与 `network` 字段；也可直接使用设置页「新建插件…」只勾所需权限，脚手架会裁剪对应示例。
5. 设置 → PiDeck 插件 → **从文件夹安装…**，选择包含 `pideck-plugin.json` 的这一层目录。
6. 核对授权弹窗的 HTTPS origins / 本地端口 → **授权并启用** → 打开面板。修改已安装包后需要重新扫描 + 重新授权；修改外部开发目录则需要重新安装。

## 请求与响应

`app.js` 中的 `request(kind)` 是两个按钮共用的最小例子：

```js
const response = await window.pideck.network.request({
	url: "https://api.example.com/v1/items", // 先修改 manifest 并授权，不能超出声明 origin
	method: "GET",
	headers: { Accept: "application/json" },
});
if (response.ok) {
	const data = JSON.parse(response.body); // body 是文本，不是自动解析的 JSON
}
```

POST JSON：

```js
const response = await window.pideck.network.request({
	url: "https://api.example.com/v1/items",
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ example: true }),
	timeoutMs: 15000,
});
```

如果接口要求认证，插件可自行提供 `Authorization` 请求头（凭据由作者/用户在插件中管理）；PiDeck 不借出自己的 Cookie、pi 登录凭据或模型 API key。**不要把真实密钥提交进包，也不要认为 `storage` 是加密保险箱。**

## 边界与验证

- 页面 `fetch` / XHR / WebSocket 仍然禁用，只有 `window.pideck.network.request()` 经宿主受控请求。
- JSON / UTF-8 text 响应上限 1 MiB，POST 正文上限 256 KiB，默认超时 15 秒、最多 30 秒；4xx/5xx 返回 `{ status, ok: false, body }`，策略/超时失败才抛稳定错误码。
- 面板只用 `textContent` 展示返回内容，不执行返回的 HTML/JS。请求不会自动发送会话数据。
- 安装/运行不需要 Node；此目录不包含服务端。打包分发时才需要 Node 20+：`node scripts/pack-host-plugin.mjs docs/examples/host-plugins/example.network example.network.pideck-plugin`。
- 仓库回归：`node --test tests/hostPluginNetworkDemo.test.mjs`，使用假 `window.pideck` 测首次加载零请求、两类按钮、错误恢复；**不启动服务、不连接真实外部接口**。网络策略与传输测试分别在 `tests/hostPluginNetwork.test.mjs` / `tests/hostPluginNetworkTransport.test.mjs`。
- 完整字段、错误码和安全约束见 `docs/host-plugin-dev-guide.md`。
