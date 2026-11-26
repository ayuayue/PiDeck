//go:build !js && !android && !ios

package workbench

// A searchable index of the settings rows. Each entry names the section
// it lives in and the words it should match; the settings rail turns a
// query into a list of jumps, so a growing page stays navigable.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

// settingEntry is one setting in the index.
type settingEntry struct {
	Section  string
	Label    string
	Keywords string
}

// settingsHit is one row of a search: a setting, or the section itself
// when the section has no setting of its own to name.
type settingsHit struct {
	Section string
	Label   string
	// Jump marks the section's own row: it opens the section, since there
	// is no setting under it to land on.
	Jump bool
}

// settingsHitLimit caps the rows a query lists.
const settingsHitLimit = 40

// settingsIndex lists the settings by section and search words.
var settingsIndex = []settingEntry{
	{"general", "新会话默认思考等级", "thinking reasoning effort level default pi 默认 思考 推理 等级"},
	{"general", "快捷短语与回复规则", "quick messages phrases reply actions shortcuts regex 快捷回复 正则 匹配 短语"},
	{"general", "语言", "language locale english chinese traditional korean japanese russian french 简体 繁体 韩文 日文 俄语 法语 한국어 日本語 Русский Français"},
	{"general", "内容宽度", "chat width content reading column narrow wide percentage percent 宽度 百分比"},
	{"general", "Tab 栏宽度", "tab width bar label title percentage percent 标签 宽度 百分比"},
	{"general", "项目排序", "project sort order recent created title"},
	{"general", "排序", "session sort name updated"},
	{"general", "列出 pi 本地会话", "scan pi sessions history"},
	{"general", "扫描所有项目", "scan all folders sessions"},
	{"general", "关闭窗口时留在托盘", "tray close window quit"},
	{"general", "一轮完成时通知", "notification done turn"},
	{"general", "提问或等待确认时通知", "notification waiting ask question permission 提问 确认"},
	{"general", "只在窗口隐藏时通知", "notify hidden focus"},
	{"general", "匿名使用统计", "telemetry analytics posthog usage privacy 遥测 统计"},
	{"general", "工具安全门", "security gate tool policy bash confirm deny workspace 安全 拦截 确认"},
	{"general", "测试通知", "test notification"},
	{"general", "通知历史", "notification history bell inbox"},
	{"general", "提示音", "sound alert chime bell pop buzz 声音 铃声 提示音"},
	{"general", "只在窗口隐藏时出声", "sound hidden focus alert"},
	{"general", "完成时", "sound done finished turn 提示音"},
	{"general", "出错时", "sound error failed 提示音"},
	{"general", "等待确认时", "sound waiting ask permission 提示音"},
	{"general", "音量", "sound volume 音量"},
	{"general", "自定义提示音", "sound custom import file 自定义 导入 音频"},
	{"general", "试听", "sound preview test 试听"},
	{"integrations", "语音输入", "voice speech transcription volcengine 火山 语音 识别 听写"},
	{"integrations", "本地 Whisper", "voice local whisper offline 语音 离线 转写"},
	{"data", "清理缓存", "cache cleanup clear metadata transcript logs 缓存 清理"},
	{"integrations", "火山语音", "voice speech volcengine 火山 语音"},
	{"integrations", "App ID", "voice volcengine appid 火山 应用"},
	{"integrations", "Access Token", "voice volcengine token 火山 令牌 凭据"},
	{"models", "供应商与认证", "provider model auth api key 模型与认证"},
	{"models", "添加供应商", "provider model add custom api base url"},
	{"models", "刷新模型目录", "models catalog 目录 刷新 更新"},
	{"models", "自动刷新模型目录", "auto model catalog 后台 自动"},
	{"models", "文本翻译", "translate translation language model"},
	{"models", "提示词增强模板", "prompt enhance template instruction rewrite 模板 润色 改写"},
	{"env", "检查 pi 版本", "terminal cli pi 更新 version"},
	{"env", "会话链接", "deep link session protocol url"},
	{"credentials", "pi 凭据", "auth credentials api key token 凭据 密钥"},
	{"pi", "pi 设置", "pi settings.json hide thinking retry compaction 隐藏思考 重试 压缩"},
	{"models", "TokenDance 账户", "tokendance 词元跳动 balance 余额充值 recharge payment 拉取模型"},
	{"about", "请作者喝咖啡", "watcha 爱猹收 tip 打赏 coffee 支持"},
	{"keys", "键位", "keybinding shortcut keyboard"},
	{"look", "配色", "theme appearance color"},
	{"look", "输入框底部指标", "composer footer metrics turns reply speed cache tokens context cost status 底部 指标 轮次 回复 缓存 上下文 费用"},
	{"look", "减弱动效", "accessibility reduce effects motion animation 减少动画"},
	{"look", "代码块自动换行", "code wrap markdown 自动换行"},
	{"look", "视频壁纸", "background video wallpaper engine steam"},
	{"look", "Logo 风格", "brand logo pi tui classic custom 品牌 图标 自定义"},
	{"look", "自定义 Logo", "brand image picture upload logo 品牌 图片"},
	{"look", "应用显示名称", "brand app display name title text 品牌 名称 文字"},
	{"look", "主题文件", "theme file json yaml"},
	{"look", "导出当前主题", "export theme file"},
	{"look", "导入主题", "import theme file load share 导入 主题文件"},
	{"look", "编辑器字号", "editor font size 字号"},
	{"look", "终端字号", "terminal font size 字号"},
	{"look", "聊天字号", "chat font size prose reading 字号 阅读"},
	{"look", "聊天行高", "chat line height spacing 行高 行距"},
	{"look", "输入框字号", "composer input font size 输入框 字号"},
	{"look", "界面字体", "ui font family interface 字体"},
	{"look", "等宽字体", "mono font family code editor 等宽 字体"},
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
	{"addons", "NSGo 插件预览", "nsgo plugin preview ui function 会话统计示例"},
	{"resources", "技能", "skill SKILL.md 资源"},
	{"resources", "技能商店", "skill store index install"},
	{"resources", "扩展", "extension package"},
	{"resources", "扩展商店", "extension store pi.dev install remove update pi list"},
	{"mcp", "MCP 服务器", "mcp server tools"},
	{"mcp", "添加服务器", "mcp add server url command"},
	{"mcp", "智能体记忆", "memory timeline markdown MCP session_search 导入 导出 项目 笔记"},
	{"diagnostics", "记录系统提示词", "trajectory system prompt 轨迹 检查器"},
	{"integrations", "飞书机器人", "feishu bot webhook"},
	{"integrations", "接收微信消息", "wechat ilink clawbot 微信 扫码 私聊 会话"},
	{"models", "独立余额账户", "balance accounts credit 多账号 余额 独立 额度"},
	{"integrations", "Webhook 地址", "webhook url"},
	{"integrations", "签名密钥", "feishu secret sign"},
	{"integrations", "接收群消息", "feishu inbound receive event callback"},
	{"integrations", "验证 Token", "feishu verification token inbound"},
	{"integrations", "把回答发回群", "feishu reply answer group"},
	{"integrations", "自定义预设", "acp preset custom"},
	{"integrations", "ACP 无输出超时", "acp watchdog timeout 卡住 无输出 看门狗"},
	{"integrations", "管理预设", "acp preset manage add remove"},
	{"integrations", "预设启动参数", "acp preset command args env environment 环境变量"},
	{"integrations", "旁路权限", "acp preset bypass permissions approval 权限"},
	{"integrations", "定时任务", "cron schedule automation task 定时 调度"},
	{"integrations", "智能体", "agent persona prompt 智能体"},
	{"remote", "访问令牌过期", "token expire expiry rotate refresh link 令牌 过期 轮换 刷新 安全"},
	{"integrations", "收藏夹", "favorite saved reply session 收藏"},
	{"diagnostics", "导出诊断包", "diagnostics bundle zip"},
	{"diagnostics", "复制诊断信息", "diagnostics report copy"},
	{"diagnostics", "日志", "logs search filter category level time clear 查询 筛选 分类 级别 时间 清理"},
	{"diagnostics", "打开日志目录", "logs directory"},
	{"data", "数据目录", "data directory"},
	{"data", "会话目录", "sessions directory"},
	{"data", "配置版本", "config version"},
	{"data", "导出设置包", "export settings backup zip"},
	{"data", "导入设置包", "import settings backup zip"},
	{"data", "加密同步", "encrypted sync gist drive cloud 云同步"},
	{"about", "检查更新", "update check version"},
	{"about", "版本", "version about"},
}

// searchSettings finds the settings a query names, and the sections a
// query names that have no setting to show for themselves: a section stays
// reachable by its title, as the rail's sections always are.
func searchSettings(query string) []settingsHit {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var out []settingsHit
	named := map[string]bool{}
	for _, e := range settingsIndex {
		if strings.Contains(strings.ToLower(e.Label+" "+apptext.T(e.Label)+" "+e.Keywords), q) {
			out = append(out, settingsHit{Section: e.Section, Label: e.Label})
			named[e.Section] = true
			if len(out) == settingsHitLimit {
				return out
			}
		}
	}
	for _, s := range settingsSections() {
		if named[s.ID] || len(out) == settingsHitLimit {
			continue
		}
		if strings.Contains(strings.ToLower(s.Label+" "+apptext.T(s.Label)+" "+s.Title+" "+apptext.T(s.Title)), q) {
			out = append(out, settingsHit{Section: s.ID, Label: s.Title, Jump: true})
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
