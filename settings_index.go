package main

// A searchable index of the settings rows. Each entry names the section
// it lives in and the words it should match; the settings rail turns a
// query into a list of jumps, so a growing page stays navigable.

import "strings"

// settingEntry is one setting in the index.
type settingEntry struct {
	Section  string
	Label    string
	Keywords string
}

// settingsIndex lists the settings by section and search words.
var settingsIndex = []settingEntry{
	{"general", "语言", "language locale english chinese"},
	{"general", "内容宽度", "chat width content reading column narrow wide 宽度"},
	{"general", "项目排序", "project sort order recent created title"},
	{"general", "排序", "session sort name updated"},
	{"general", "列出 pi 本地会话", "scan pi sessions history"},
	{"general", "扫描所有项目", "scan all folders sessions"},
	{"general", "关闭窗口时留在托盘", "tray close window quit"},
	{"general", "一轮完成时通知", "notification done turn"},
	{"general", "只在窗口隐藏时通知", "notify hidden focus"},
	{"general", "桌面宠物", "pet window"},
	{"general", "测试通知", "test notification"},
	{"models", "供应商与认证", "provider model auth api key"},
	{"models", "pi 凭据", "auth credentials api key token 凭据 密钥"},
	{"keys", "键位", "keybinding shortcut keyboard"},
	{"look", "配色", "theme appearance color"},
	{"look", "主题文件", "theme file json yaml"},
	{"look", "导出当前主题", "export theme file"},
	{"look", "编辑器字号", "editor font size 字号"},
	{"look", "终端字号", "terminal font size 字号"},
	{"env", "pi 可执行文件", "pi path binary"},
	{"env", "pi 会话目录", "pi sessions directory"},
	{"env", "pi 配置目录", "pi config directory"},
	{"env", "外部编辑器", "editor command vscode cursor"},
	{"env", "应用请求代理", "proxy http https app"},
	{"env", "Agent 代理", "proxy agent pi acp"},
	{"env", "直连名单", "no_proxy bypass"},
	{"addons", "插件", "plugin extension"},
	{"addons", "插件市场", "plugin market registry"},
	{"addons", "插件设置", "plugin settings"},
	{"resources", "技能", "skill SKILL.md"},
	{"resources", "技能商店", "skill store index install"},
	{"resources", "扩展", "extension package"},
	{"mcp", "MCP 服务器", "mcp server tools"},
	{"mcp", "添加服务器", "mcp add server url command"},
	{"integrations", "飞书机器人", "feishu bot webhook"},
	{"integrations", "Webhook 地址", "webhook url"},
	{"integrations", "签名密钥", "feishu secret sign"},
	{"integrations", "接收群消息", "feishu inbound receive event callback"},
	{"integrations", "验证 Token", "feishu verification token inbound"},
	{"integrations", "把回答发回群", "feishu reply answer group"},
	{"integrations", "自定义预设", "acp preset custom"},
	{"integrations", "管理预设", "acp preset manage add remove"},
	{"diagnostics", "导出诊断包", "diagnostics bundle zip"},
	{"diagnostics", "复制诊断信息", "diagnostics report copy"},
	{"diagnostics", "打开日志目录", "logs directory"},
	{"data", "数据目录", "data directory"},
	{"data", "会话目录", "sessions directory"},
	{"data", "配置版本", "config version"},
	{"data", "导出设置包", "export settings backup zip"},
	{"data", "导入设置包", "import settings backup zip"},
	{"about", "检查更新", "update check version"},
	{"about", "版本", "version about"},
}

// searchSettings finds the settings a query names.
func searchSettings(query string) []settingEntry {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var out []settingEntry
	for _, e := range settingsIndex {
		if strings.Contains(strings.ToLower(e.Label+" "+e.Keywords), q) {
			out = append(out, e)
			if len(out) >= 40 {
				break
			}
		}
	}
	return out
}

// settingsSectionTitle names a section by id.
func settingsSectionTitle(id string) string {
	for _, s := range settingsSections() {
		if s.ID == id {
			return s.Title
		}
	}
	return id
}
