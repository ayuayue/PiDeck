import { defineConfig } from "vitepress";

// 自定义域名部署在站点根路径；本地/兼容旧 github.io 子路径时可用 VITEPRESS_BASE=/PiDeck/
const base = process.env.VITEPRESS_BASE ?? "/";
// 官网正式入口：自定义域名（GitHub Pages Settings + public/CNAME）
const siteOrigin = process.env.DOCS_SITE_ORIGIN ?? "https://pideck.caoayu.top";

export default defineConfig({
  title: "PiDeck - pi Agent Desktop Workbench",
  description: "PiDeck is an open-source desktop workbench for managing multiple pi AI coding agents across local project folders. Features session history, Git integration, built-in terminal, and visual config management.",
  lang: "zh-CN",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}icon.svg` }],
    ["link", { rel: "canonical", href: `${siteOrigin}/` }],
    ["meta", { name: "keywords", content: "PiDeck, pi, pi-agent, ai-coding-agent, desktop, electron, rpc, local-ai, developer-tools, coding-assistant, workspace, session-management, git, terminal, windows, macos, linux, open-source" }],
    ["meta", { name: "author", content: "ayuayue" }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { property: "og:site_name", content: "PiDeck" }],
    ["meta", { property: "og:title", content: "PiDeck - pi Agent Desktop Workbench" }],
    ["meta", { property: "og:description", content: "Open-source desktop workbench to manage pi AI coding agents across local project folders. Features session history, Git integration, terminal, and plugin management." }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: `${siteOrigin}/` }],
    ["meta", { property: "og:image", content: `${siteOrigin}/og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "PiDeck - pi Agent Desktop Workbench" }],
    ["meta", { name: "twitter:description", content: "Manage multiple pi AI coding agents in local workspaces. Open-source desktop app with sessions, Git, terminal, and extensions." }],
    ["meta", { name: "twitter:image", content: `${siteOrigin}/og-image.png` }],
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
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "PiDeck",
    nav: [
      { text: "首页", link: "/" },
      { text: "English", link: "/en" },
      { text: "使用指南", link: "/guide/usage-guide" },
      { text: "功能", link: "/guide/features" },
      { text: "FAQ", link: "/guide/faq" },
      { text: "对比", link: "/guide/comparison" },
      { text: "更新日志", link: "/changelog" },
      {
        text: "下载",
        link: "https://github.com/ayuayue/PiDeck/releases",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "使用指南",
          items: [
            { text: "完整使用指南（新手向）", link: "/guide/usage-guide" },
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "功能介绍", link: "/guide/features" },
            { text: "配置与 Skills", link: "/guide/settings" },
            { text: "常见问题", link: "/guide/faq" },
            { text: "产品对比", link: "/guide/comparison" },
            { text: "开发与打包", link: "/guide/development" },
            { text: "贡献者", link: "/guide/contributors" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/ayuayue/PiDeck" },
    ],
    search: {
      provider: "local",
    },
    outline: {
      label: "本页目录",
      level: [2, 3],
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最近更新",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
    editLink: {
      pattern: "https://github.com/ayuayue/PiDeck/edit/main/docs-site/:path",
      text: "在 GitHub 上编辑此页",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 ayuayue",
    },
  },
});
