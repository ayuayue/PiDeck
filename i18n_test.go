package main

// Checks for the language choice, the lookup and the catalogs the
// settings and command palette rely on.

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestResolveLanguage checks the user's choice and the system's.
func TestResolveLanguage(t *testing.T) {
	cases := []struct{ setting, system, want string }{
		{"", "zh-Hans", langZhCN},
		{"", "zh-CN", langZhCN},
		{"", "zh-TW", langZhTW},
		{"", "zh-Hant-HK", langZhTW},
		{"", "en-US", langEnUS},
		{"", "de-DE", langZhCN},
		{"en-US", "zh-CN", langEnUS},
		{"zh-TW", "en-US", langZhTW},
		{"bogus", "en-GB", langEnUS},
		{"", "zh_TW.UTF-8", langZhTW},
		{"", "zh-HK", langZhTW},
		{"", "zh-MO", langZhTW},
		{"", "zh-Hans-HK", langZhCN},
		{"", "zh-Hant-CN", langZhTW},
		{"", "ko-KR", langKoKR},
		{"", "ko", langKoKR},
		{"", "ja_JP.UTF-8", langJaJP},
		{"", "ru_RU.UTF-8", langRuRU},
		{"", " FR-ca ", langFrFR},
		{"", "fr_FR@euro", langFrFR},
		{"", "english", langZhCN},
	}
	for _, lang := range supportedLanguages {
		cases = append(cases, struct{ setting, system, want string }{lang, "de-DE", lang})
	}
	for _, c := range cases {
		if got := resolveLanguage(c.setting, c.system); got != c.want {
			t.Errorf("resolveLanguage(%q, %q) = %q, want %q", c.setting, c.system, got, c.want)
		}
	}
}

// TestT checks translation, fallback and formatting.
func TestT(t *testing.T) {
	defer setUILanguage(langZhCN)
	setUILanguage(langZhCN)
	if got := T("新建会话"); got != "新建会话" {
		t.Errorf("source = %q", got)
	}
	setUILanguage(langEnUS)
	if got := T("新建会话"); got != "New session" {
		t.Errorf("English = %q", got)
	}
	if got := T("没有这条翻译"); got != "没有这条翻译" {
		t.Errorf("fallback = %q", got)
	}
	if got := T("运行中 · %s", "测试"); got != "Running · 测试" {
		t.Errorf("format = %q", got)
	}
	staticPercent := "0% 完全遮住图片，100% 完全显示；面板会一起变透明。"
	if got := T(staticPercent, "ignored"); strings.Contains(got, "%!") {
		t.Errorf("literal percent = %q", got)
	}
	setUILanguage(langZhTW)
	if got := T("新建会话"); got != "新增工作階段" {
		t.Errorf("Traditional = %q", got)
	}
}

// TestCommandTranslations checks every command and group the palette
// shows has a translation in every supported language.
func TestCommandTranslations(t *testing.T) {
	check := func(kind, text string) {
		for lang := range messages {
			if strings.TrimSpace(messages[lang][text]) == "" {
				t.Errorf("%s %q has no %s translation", kind, text, lang)
			}
		}
	}
	for _, c := range builtinCommands() {
		check("command", c.Label)
		check("group", c.Group)
	}
	for _, s := range settingsSections() {
		check("section", s.Label)
		check("title", s.Title)
		check("summary", s.Summary)
	}
}

// TestLanguageSettingPersists checks the choice reaches config.json.
func TestLanguageSettingPersists(t *testing.T) {
	for _, lang := range supportedLanguages {
		t.Run(lang, func(t *testing.T) {
			dir := t.TempDir()
			st, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			st.edit(func(c *config) { c.Language = lang })
			st2, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			if got := st2.config().Language; got != lang {
				t.Fatalf("language = %q, want %q", got, lang)
			}
		})
	}
}

// TestLanguageSwitch checks the settings page changes language at once.
func TestLanguageSwitch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(func() { setUILanguage(langZhCN) })
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.WaitFor("id:settings-tab-general", 5*time.Second)
	for _, code := range supportedLanguages {
		app.WaitFor("text:"+languageName(code), 5*time.Second)
	}
	app.Press("text:English")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Interface")) > 0 })
	if len(app.Query("text:通用")) != 0 {
		t.Fatal("the Chinese section label is still there after switching to English")
	}
	app.Press("text:简体中文")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:界面")) > 0 })
	for _, code := range []string{langKoKR, langJaJP, langRuRU, langFrFR} {
		app.Press("text:" + languageName(code))
		app.WaitUntil(5*time.Second, func() bool { return currentUILanguage() == code })
		app.WaitFor("id:settings-tab-general", 5*time.Second)
	}
	app.Press("text:简体中文")
}

// TestMainUILabels checks the rail, welcome and composer strings have
// translations in all supported languages.
func TestMainUILabels(t *testing.T) {
	labels := []string{
		"项目", "本机 pi 工作台", "搜索会话", "置顶", "还没有会话", "更多", "收起",
		"概览", "文件", "没有打开的会话", "刷新文件", "显示隐藏文件",
		"先打开一个工作区", "目录为空", "模型", "思考", "会话 ID", "上下文",
		"输入", "输出", "缓存读", "费用", "工具调用", "导出 HTML", "终端",
		"先添加一个项目文件夹，再开会话。", "打开一个会话，或者新建一个。",
		"添加工作区", "导入会话", "运行中：回车插入引导，或点停止",
		"正在启动 pi…", "给 pi 发消息…", "看看这个项目", "跑一遍测试",
		"解释一处代码", "修一个小问题", "Enter 发送 · Shift+Enter 换行 · ⌘K 命令面板",
		"收藏", "取消收藏", "复制会话", "删除会话", "在此新建会话", "移除项目",
		"选择模型", "用量", "会话面板", "按最近活动排序", "按名称排序",
		"搜索命令、会话或工作区…", "没有匹配的命令", "选择这个文件夹", "系统选择器",
		"添加并开会话", "重命名会话", "拒绝", "允许", "确定", "读取中…", "关", "极高",
		"分支", "切换分支", "新建分支", "已暂存", "更改", "提交", "历史",
		"正在读取仓库…", "初始化 Git 仓库", "创建并切换", "工作区干净", "复制补丁",
		"搜索终端", "清屏", "重启终端", "隐藏终端", "无结果", "在终端里搜索",
		"还没有终端", "正在启动终端…", "终端启动失败", "粘贴", "全选",
	}
	for _, text := range labels {
		for lang := range messages {
			if strings.TrimSpace(messages[lang][text]) == "" {
				t.Errorf("%q has no %s translation", text, lang)
			}
		}
	}
}

// TestMainLanguageSwitch checks the rail and welcome change language too.
func TestMainLanguageSwitch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Cleanup(func() { setUILanguage(langZhCN) })
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.Press("text:English")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Interface")) > 0 })
	app.Key("escape")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Projects")) > 0 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Add workspace")) > 0 })
}

// TestLanguageCatalogCoverage checks every catalog has the same source
// messages, without empty values or broken formatting placeholders.
func TestLanguageCatalogCoverage(t *testing.T) {
	format := regexp.MustCompile(`%(?:\[[0-9]+\])?[-+#0]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?(?:\[[0-9]+\])?[bcdeEfFgGopqstTUVwxX%]`)
	for _, lang := range supportedLanguages {
		if lang == langZhCN {
			continue
		}
		t.Run(lang, func(t *testing.T) {
			catalog, ok := messages[lang]
			if !ok {
				t.Fatal("no message catalog")
			}
			for _, other := range messages {
				var missing []string
				for key := range other {
					if strings.TrimSpace(catalog[key]) == "" {
						missing = append(missing, key)
					}
				}
				sort.Strings(missing)
				if len(missing) > 0 {
					t.Fatalf("%d missing entries: %q", len(missing), missing[:min(len(missing), 12)])
				}
			}
			for key, text := range catalog {
				want := format.FindAllString(key, -1)
				if got := format.FindAllString(text, -1); !reflect.DeepEqual(got, want) {
					t.Errorf("%q placeholders = %v, want %v", key, got, want)
				}
			}
		})
	}
}

func TestNewLanguageTranslations(t *testing.T) {
	t.Cleanup(func() { setUILanguage(langZhCN) })
	for _, c := range []struct{ code, session, running string }{
		{langKoKR, "새 세션", "실행 중 · pi"},
		{langJaJP, "新しいセッション", "実行中 · pi"},
		{langRuRU, "Новая сессия", "Выполняется · pi"},
		{langFrFR, "Nouvelle session", "En cours · pi"},
	} {
		setUILanguage(c.code)
		if got := T("新建会话"); got != c.session {
			t.Errorf("%s new session = %q", c.code, got)
		}
		if got := T("运行中 · %s", "pi"); got != c.running {
			t.Errorf("%s formatted = %q", c.code, got)
		}
		if got := T("0% 完全遮住图片，100% 完全显示；面板会一起变透明。", 0); strings.Contains(got, "%!") {
			t.Errorf("%s formatted literal percent = %q", c.code, got)
		}
	}
}

func TestLocalizedSettingsSearch(t *testing.T) {
	t.Cleanup(func() { setUILanguage(langZhCN) })
	for _, lang := range []string{langKoKR, langJaJP, langRuRU, langFrFR} {
		setUILanguage(lang)
		matches := searchSettings(T("语言"))
		if len(matches) == 0 || matches[0].Label != "语言" {
			t.Errorf("%s language setting not found: %v", lang, matches)
		}
	}
}
