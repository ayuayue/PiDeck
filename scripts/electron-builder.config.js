/**
 * electron-builder `--config` 入口（stable 通道）。只导出配置对象本身——electron-builder 会对
 * 根配置做 schema 校验，任何多余导出都会被当作未知属性拒绝，辅助函数一律放
 * ./electronBuilderConfig.js。
 *
 * 用法：npx electron-builder --mac dmg zip --config scripts/electron-builder.config.js
 * 为什么 mac 打包必须带它：package.json 写死的 `build.mac.identity: "-"` 只是无证书兜底，
 * 有 CSC_LINK/CSC_NAME 时要靠本入口删掉它才会用 Developer ID 签名（见 electronBuilderConfig.js）。
 */
const { createElectronBuilderConfig } = require("./electronBuilderConfig.js");

module.exports = createElectronBuilderConfig();
