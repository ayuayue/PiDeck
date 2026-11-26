//go:build !js && !android && !ios

package workbench

// Checks for the language choice, the lookup and the catalogs the
// settings and command palette rely on.

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestCommandTranslations checks every command and group the palette
// shows has a translation in every supported language.
func TestCommandTranslations(t *testing.T) {
	check := func(kind, text string) {
		for lang := range apptext.Catalogs {
			if strings.TrimSpace(apptext.Catalogs[lang][text]) == "" {
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
	for _, lang := range apptext.SupportedLanguages {
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
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.WaitFor("id:settings-tab-general", 5*time.Second)
	app.WaitFor("id:language-select", 5*time.Second)
	app.Press("id:language-select")
	app.WaitFor("id:language-select-2", 5*time.Second)
	app.Press("id:language-select-2")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Interface")) > 0 })
	if len(app.Query("text:通用")) != 0 {
		t.Fatal("the Chinese section label is still there after switching to English")
	}
	app.Press("id:language-select")
	app.WaitFor("id:language-select-1", 5*time.Second)
	app.Press("id:language-select-1")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:界面")) > 0 })
	for _, code := range []string{apptext.LangKoKR, apptext.LangJaJP, apptext.LangRuRU, apptext.LangFrFR} {
		index := 0
		for i, option := range languageOptions() {
			if option.Value == code {
				index = i
				break
			}
		}
		app.Press("id:language-select")
		app.WaitFor(fmt.Sprintf("id:language-select-%d", index), 5*time.Second)
		app.Press(fmt.Sprintf("id:language-select-%d", index))
		app.WaitUntil(5*time.Second, func() bool { return apptext.CurrentLanguage() == code })
		app.WaitFor("id:settings-tab-general", 5*time.Second)
	}
	app.Press("id:language-select")
	app.Press("id:language-select-1")
}

// TestLanguageForcesTheScopeLocale checks the packages NSGo draws itself —
// menus, dialogs, the updater — follow the app's language: they read the
// scope's locale, which apptext's language alone does not set.
func TestLanguageForcesTheScopeLocale(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { a = newApp(cx); return a.view() }, nsgotest.Size(1000, 700))
	t.Cleanup(func() { a.cx.SetLocale("") })
	screen.Settle()
	a.setLanguage(apptext.LangFrFR)
	if got := a.cx.Env().Locale(); got != apptext.LangFrFR {
		t.Fatalf("locale after choosing French = %q, want %q", got, apptext.LangFrFR)
	}
	// Following the system again must clear the forced locale, or the
	// system's language can never be read back.
	a.setLanguage("")
	if got := a.cx.Env().Locale(); got == apptext.LangFrFR {
		t.Fatalf("locale still forced to %q after following the system", got)
	}
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
		"解释一处代码", "修一个小问题", "在 %s 里做点什么", "开始新的会话",
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
		for lang := range apptext.Catalogs {
			if strings.TrimSpace(apptext.Catalogs[lang][text]) == "" {
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
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-general")
	app.Press("id:language-select")
	app.Press("text:English")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Interface")) > 0 })
	app.Key("escape")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Projects")) > 0 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:Add workspace")) > 0 })
}

func TestLocalizedSettingsSearch(t *testing.T) {
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	for _, lang := range []string{apptext.LangKoKR, apptext.LangJaJP, apptext.LangRuRU, apptext.LangFrFR} {
		apptext.SetLanguage(lang)
		matches := searchSettings(apptext.T("语言"))
		if len(matches) == 0 || matches[0].Label != "语言" {
			t.Errorf("%s language setting not found: %v", lang, matches)
		}
	}
}
