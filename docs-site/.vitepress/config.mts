import { defineConfig } from "vitepress";
import { sharedGuideDocsPlugin } from "./sharedGuideDocs";
import { sharedReadmeImagesPlugin } from "./sharedReadmeImages";

// 自定义域名部署在站点根路径；本地/兼容旧 github.io 子路径时可用 VITEPRESS_BASE=/PiDeck/
const base = process.env.VITEPRESS_BASE ?? "/";
// 官网正式入口：自定义域名（GitHub Pages Settings + public/CNAME）
const siteOrigin = process.env.DOCS_SITE_ORIGIN ?? "https://pideck.caoayu.top";

export default defineConfig({
  base,
  cleanUrls: true,
  lastUpdated: true,
  // 页面已在 frontmatter title 里带品牌与关键词（如「PiDeck - pi desktop 桌面工作台」），
  // 关闭默认的「| siteTitle」后缀拼接，避免 title 重复啰嗦、稀释搜索关键词权重。
  // 注意：titleTemplate 是 defineConfig 顶层字段，且关闭值是 false（VitePress 未处理 null）。
  titleTemplate: false,

  // README 与官网共用的图片（如微信群二维码）以 docs/images 为唯一数据源，
  // dev / build 启动时由插件同步进 public/images，避免同一张图两边各存一份。
  // 插件开发指南同理：docs/host-plugin-dev-guide.md 同步为 /guide/host-plugins 页面。
  vite: {
    plugins: [sharedReadmeImagesPlugin(), sharedGuideDocsPlugin()],
  },

  // ===== 多语言：key 必须用 root / en（不是 / 和 /en/）=====
  locales: {
    root: {
      label: "中文",
      lang: "zh-CN",
      title: "PiDeck - pi Agent 桌面工作台",
      description:
        "PiDeck 是一款开源桌面工作台，用于在本地项目文件夹中管理多个 pi AI 编码助手。支持会话历史、Git 集成、内置终端和可视化配置管理。",
      themeConfig: {
        nav: [
          { text: "首页", link: "/" },
          {
            text: "指南",
            items: [
              { text: "全景指南", link: "/guide/ultimate-guide" },
              { text: "快速开始", link: "/guide/getting-started" },
              { text: "功能手册", link: "/guide/feature-reference" },
              { text: "原理解析", link: "/guide/architecture-deep-dive" },
            ],
          },
          {
            text: "帮助",
            items: [
              { text: "FAQ", link: "/guide/faq" },
              { text: "问题排查", link: "/guide/troubleshooting" },
              { text: "产品对比", link: "/guide/comparison" },
            ],
          },
          { text: "更新日志", link: "/changelog" },
          { text: "下载", link: "https://github.com/ayuayue/PiDeck/releases" },
          {
            text: "源码",
            items: [
              { text: "GitHub 仓库（海外）", link: "https://github.com/ayuayue/PiDeck" },
              { text: "AtomGit 仓库（国内镜像）", link: "https://atomgit.com/ayuayue/PiDeck" },
            ],
          },
        ],
        sidebar: {
          "/guide/": [
            {
              text: "指南",
              items: [
                { text: "从零到精通终极全景指南", link: "/guide/ultimate-guide" },
                { text: "核心原理解析与深度指南", link: "/guide/architecture-deep-dive" },
                { text: "完整使用指南（新手向）", link: "/guide/usage-guide" },
                { text: "快速开始", link: "/guide/getting-started" },
                { text: "功能介绍", link: "/guide/features" },
                { text: "功能操作手册", link: "/guide/feature-reference" },
                { text: "配置与 Skills", link: "/guide/settings" },
                { text: "宿主插件开发指南", link: "/guide/host-plugins" },
                { text: "常见问题", link: "/guide/faq" },
                { text: "问题排查指南", link: "/guide/troubleshooting" },
                { text: "产品对比", link: "/guide/comparison" },
                { text: "开发与打包", link: "/guide/development" },
                { text: "贡献者", link: "/guide/contributors" },
              ],
            },
          ],
        },
        outline: { label: "本页目录", level: [2, 3] },
        docFooter: { prev: "上一页", next: "下一页" },
        lastUpdated: {
          text: "最近更新",
          formatOptions: { dateStyle: "medium", timeStyle: "short" },
        },
        editLink: {
          pattern: "https://github.com/ayuayue/PiDeck/edit/main/docs-site/:path",
          text: "在 GitHub 上编辑此页",
        },
        footer: {
          message: "基于 MIT 许可协议发布。",
          copyright: "Copyright © 2026 ayuayue",
        },
      },
    },
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      title: "PiDeck - pi Agent Desktop Workbench",
      description:
        "PiDeck is an open-source desktop workbench for managing multiple pi AI coding agents across local project folders. Features session history, Git integration, built-in terminal, and visual config management.",
      themeConfig: {
        nav: [
          { text: "Home", link: "/en/" },
          {
            text: "Guide",
            items: [
              { text: "Ultimate Guide", link: "/guide/ultimate-guide" },
              { text: "Quick Start", link: "/en/guide/getting-started" },
              { text: "Feature Reference", link: "/en/guide/feature-reference" },
              { text: "Deep Dive", link: "/guide/architecture-deep-dive" },
            ],
          },
          {
            text: "Help",
            items: [
              { text: "FAQ", link: "/en/guide/faq" },
              { text: "Troubleshooting", link: "/en/guide/troubleshooting" },
              { text: "Comparison", link: "/en/guide/comparison" },
            ],
          },
          { text: "Changelog", link: "/en/changelog" },
          { text: "Download", link: "https://github.com/ayuayue/PiDeck/releases" },
          {
            text: "Source",
            items: [
              { text: "GitHub (Global)", link: "https://github.com/ayuayue/PiDeck" },
              { text: "AtomGit (China mirror)", link: "https://atomgit.com/ayuayue/PiDeck" },
            ],
          },
        ],
        sidebar: {
          "/en/guide/": [
            {
              text: "Guide",
              items: [
                { text: "Ultimate Guide (Zero to Hero)", link: "/guide/ultimate-guide" },
                { text: "Architecture Deep Dive", link: "/guide/architecture-deep-dive" },
                { text: "Usage Guide", link: "/en/guide/usage-guide" },
                { text: "Quick Start", link: "/en/guide/getting-started" },
                { text: "Features", link: "/en/guide/features" },
                { text: "Feature Reference", link: "/en/guide/feature-reference" },
                { text: "Settings & Skills", link: "/en/guide/settings" },
                { text: "FAQ", link: "/en/guide/faq" },
                { text: "Troubleshooting", link: "/en/guide/troubleshooting" },
                { text: "Comparison", link: "/en/guide/comparison" },
                { text: "Development", link: "/en/guide/development" },
                { text: "Contributors", link: "/en/guide/contributors" },
              ],
            },
          ],
        },
        outline: { label: "On This Page", level: [2, 3] },
        docFooter: { prev: "Previous", next: "Next" },
        lastUpdated: {
          text: "Updated at",
          formatOptions: { dateStyle: "medium", timeStyle: "short" },
        },
        editLink: {
          pattern: "https://github.com/ayuayue/PiDeck/edit/main/docs-site/:path",
          text: "Edit this page on GitHub",
        },
        footer: {
          message: "Released under the MIT License.",
          copyright: "Copyright © 2026 ayuayue",
        },
      },
    },
  },

  // ===== 共享主题配置 =====
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "PiDeck",
    // 只保留内置图标（github）；AtomGit 无内置图标，作为「源码」下拉项出现在导航中，
    // 避免 socialLinks 里出现 no-icon 空白图标位。
    socialLinks: [
      { icon: "github", link: "https://github.com/ayuayue/PiDeck", ariaLabel: "GitHub 仓库" },
    ],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索", buttonAriaLabel: "搜索文档" },
              modal: {
                noResultsText: "无法找到相关结果",
                resetButtonTitle: "清除查询条件",
                footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
              },
            },
          },
          en: {
            translations: {
              button: { buttonText: "Search", buttonAriaLabel: "Search docs" },
              modal: {
                noResultsText: "No results found",
                resetButtonTitle: "Clear query",
                footer: { selectText: "to select", navigateText: "to navigate", closeText: "to close" },
              },
            },
          },
        },
      },
    },
  },

  // ===== 全局 head =====
  head: [
    ["link", { rel: "icon", href: `${base}icon.svg` }],
    ["link", { rel: "canonical", href: `${siteOrigin}/` }],
    ["meta", { name: "keywords", content: "PiDeck, pi, pi-agent, ai-coding-agent, desktop, electron, rpc, local-ai, developer-tools, coding-assistant, workspace, session-management, git, terminal, windows, macos, linux, open-source" }],
    ["meta", { name: "author", content: "ayuayue" }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { property: "og:site_name", content: "PiDeck" }],
    ["meta", { property: "og:title", content: "PiDeck - pi Agent Desktop Workbench" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: `${siteOrigin}/` }],
    ["meta", { property: "og:image", content: `${siteOrigin}/og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "PiDeck - pi Agent Desktop Workbench" }],
    ["meta", { name: "twitter:description", content: "Manage multiple pi AI coding agents in local workspaces. Open-source desktop app with sessions, Git, terminal, and extensions." }],
    ["meta", { name: "twitter:image", content: `${siteOrigin}/og-image.png` }],
    // 搜索引擎站长平台验证位：GSC/Bing 验证码通过 CI 环境变量注入（pages.yml 的 env），
    // 不用为了验证改代码。变量为空时不注入该 meta（head 数组类型要求二元素元组）。
    ...(process.env.GSC_VERIFICATION
      ? [
          [
            "meta",
            { name: "google-site-verification", content: process.env.GSC_VERIFICATION },
          ] as [string, Record<string, string>],
        ]
      : []),
    ...(process.env.BING_VERIFICATION
      ? [
          [
            "meta",
            { name: "msvalidate.01", content: process.env.BING_VERIFICATION },
          ] as [string, Record<string, string>],
        ]
      : []),
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "PiDeck",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "Windows, macOS, Linux",
        "description": "Open-source desktop workbench for managing multiple pi AI coding agents across local project folders.",
        "url": siteOrigin,
        "downloadUrl": "https://github.com/ayuayue/PiDeck/releases",
        "sourceCodeRepository": "https://github.com/ayuayue/PiDeck",
        "sameAs": [
          "https://github.com/ayuayue/PiDeck",
          "https://atomgit.com/ayuayue/PiDeck"
        ],
        "license": "https://opensource.org/licenses/MIT",
        "author": {
          "@type": "Organization",
          "name": "ayuayue",
          "url": "https://github.com/ayuayue"
        },
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD"
        }
      })
    ]
  ],
});
