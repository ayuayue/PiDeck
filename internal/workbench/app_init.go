//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/crashlog"
	"example.com/pideck-lite/internal/sessionimport"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// newApp builds the state from the config and the session store.
func newApp(cx *core.Scope) *app {
	a := &app{
		cx:                     cx,
		byID:                   map[string]*session{},
		workspaces:             core.NewSignalFunc(cx, []*workspace{}, nil),
		activeWS:               core.NewSignal(cx, ""),
		tabs:                   core.NewSignalFunc(cx, []string{}, nil),
		activeID:               core.NewSignal(cx, ""),
		activePane:             core.NewSignal(cx, ""),
		filter:                 core.NewSignal(cx, ""),
		sidebar:                core.NewSignal(cx, true),
		drawer:                 core.NewSignal(cx, false),
		drawerTab:              core.NewSignal(cx, "overview"),
		theme:                  core.NewSignal(cx, "system"),
		uiFont:                 core.NewSignal(cx, ""),
		monoFont:               core.NewSignal(cx, ""),
		chatFont:               core.NewSignal(cx, 0.0),
		chatLine:               core.NewSignal(cx, 0.0),
		inputFont:              core.NewSignal(cx, 0.0),
		toolRev:                core.NewSignal(cx, 0),
		aiBusy:                 core.NewSignal(cx, ""),
		bgImage:                core.NewSignal(cx, ""),
		bgOpacity:              core.NewSignal(cx, 0.8),
		palette:                core.NewSignal(cx, false),
		settings:               core.NewSignal(cx, false),
		settingsTab:            core.NewSignal(cx, "env"),
		settingsRev:            core.NewSignal(cx, 0),
		brandOpen:              core.NewSignal(cx, false),
		brandRev:               core.NewSignal(cx, 0),
		brandBusy:              core.NewSignal(cx, false),
		brandError:             core.NewSignal(cx, ""),
		settingsScroll:         &core.Ref{},
		addWS:                  core.NewSignal(cx, false),
		addTarget:              core.NewSignal(cx, false),
		addKind:                core.NewSignal(cx, int(targetWSL)),
		addWhere:               core.NewSignal(cx, ""),
		addPath:                core.NewSignal(cx, ""),
		importOpen:             core.NewSignal(cx, false),
		renameOpen:             core.NewSignal(cx, false),
		renameText:             core.NewSignal(cx, ""),
		fileOpOpen:             core.NewSignal(cx, false),
		fileOpTitle:            core.NewSignal(cx, ""),
		fileOpText:             core.NewSignal(cx, ""),
		exportOpen:             core.NewSignal(cx, false),
		trustOpen:              core.NewSignal(cx, false),
		planAskOpen:            core.NewSignal(cx, false),
		forksOpen:              core.NewSignal(cx, false),
		settingsQuery:          core.NewSignal(cx, ""),
		mcpServers:             core.NewSignalFunc(cx, []mcpServer(nil), nil),
		mcpBusy:                core.NewSignal(cx, false),
		mcpErr:                 core.NewSignal(cx, ""),
		mcpAddOpen:             core.NewSignal(cx, false),
		mcpAddBusy:             core.NewSignal(cx, false),
		mcpAddErr:              core.NewSignal(cx, ""),
		mcpName:                core.NewSignal(cx, ""),
		mcpURL:                 core.NewSignal(cx, ""),
		mcpCommand:             core.NewSignal(cx, ""),
		mcpDesc:                core.NewSignal(cx, ""),
		mcpLocal:               core.NewSignal(cx, false),
		promptStoreOpen:        core.NewSignal(cx, false),
		promptStoreURL:         core.NewSignal(cx, ""),
		promptStoreBusy:        core.NewSignal(cx, false),
		promptStoreErr:         core.NewSignal(cx, ""),
		promptStoreList:        core.NewSignalFunc(cx, []promptIndexEntry(nil), nil),
		promptStoreInstalling:  core.NewSignal(cx, ""),
		skillStoreOpen:         core.NewSignal(cx, false),
		skillStoreURL:          core.NewSignal(cx, ""),
		skillStoreBusy:         core.NewSignal(cx, false),
		skillStoreErr:          core.NewSignal(cx, ""),
		skillStoreList:         core.NewSignalFunc(cx, []skillIndexEntry(nil), nil),
		skillStoreInstalling:   core.NewSignal(cx, ""),
		marketOpen:             core.NewSignal(cx, false),
		marketURL:              core.NewSignal(cx, ""),
		marketBusy:             core.NewSignal(cx, false),
		marketErr:              core.NewSignal(cx, ""),
		marketList:             core.NewSignalFunc(cx, []marketEntry(nil), nil),
		marketInstalling:       core.NewSignal(cx, ""),
		imageOpen:              core.NewSignal(cx, false),
		imagePrompt:            core.NewSignal(cx, ""),
		imageModel:             core.NewSignal(cx, ""),
		imageSize:              core.NewSignal(cx, "1024x1024"),
		imageProvider:          core.NewSignal(cx, ""),
		imageBusy:              core.NewSignal(cx, false),
		imageErr:               core.NewSignal(cx, ""),
		imageResults:           core.NewSignalFunc(cx, [][]byte(nil), nil),
		imageSelected:          core.NewSignal(cx, 0),
		imageType:              core.NewSignal(cx, ""),
		imageCount:             core.NewSignal(cx, 1),
		imageRef:               core.NewSignal(cx, ""),
		visionOpen:             core.NewSignal(cx, false),
		visionPath:             core.NewSignal(cx, ""),
		visionQuestion:         core.NewSignal(cx, ""),
		visionModel:            core.NewSignal(cx, ""),
		visionProvider:         core.NewSignal(cx, ""),
		visionBusy:             core.NewSignal(cx, false),
		visionErr:              core.NewSignal(cx, ""),
		visionText:             core.NewSignal(cx, ""),
		confirmOpen:            core.NewSignal(cx, false),
		confirmHead:            core.NewSignal(cx, ""),
		confirmBody:            core.NewSignal(cx, ""),
		confirmWhy:             core.NewSignal(cx, ""),
		askSeq:                 core.NewSignal(cx, 0),
		gitBranches:            core.NewSignal(cx, false),
		gitNewBranchOpen:       core.NewSignal(cx, false),
		gitStashOpen:           core.NewSignal(cx, false),
		gitStashList:           core.NewSignalFunc(cx, []gitStashEntry(nil), nil),
		gitStashBusy:           core.NewSignal(cx, false),
		gitStashErr:            core.NewSignal(cx, ""),
		gitMoreOpen:            core.NewSignal(cx, false),
		gitTagsOpen:            core.NewSignal(cx, false),
		gitRemotesOpen:         core.NewSignal(cx, false),
		gitConflictsOpen:       core.NewSignal(cx, false),
		gitBlameOpen:           core.NewSignal(cx, false),
		gitBlamePath:           core.NewSignal(cx, ""),
		gitBlameRev:            core.NewSignal(cx, 0),
		gitBlameErr:            core.NewSignal(cx, ""),
		gitFileHistoryOpen:     core.NewSignal(cx, false),
		gitFileHistoryPath:     core.NewSignal(cx, ""),
		gitFileHistoryRev:      core.NewSignal(cx, 0),
		gitFileHistoryErr:      core.NewSignal(cx, ""),
		gitUnpushedOpen:        core.NewSignal(cx, false),
		gitUnpushedRev:         core.NewSignal(cx, 0),
		gitUnpushedErr:         core.NewSignal(cx, ""),
		gitRemoteName:          core.NewSignal(cx, "origin"),
		gitRemoteURL:           core.NewSignal(cx, ""),
		gitTagText:             core.NewSignal(cx, ""),
		termRenameOpen:         core.NewSignal(cx, false),
		termRenameID:           core.NewSignal(cx, ""),
		termRenameText:         core.NewSignal(cx, ""),
		gotoOpen:               core.NewSignal(cx, false),
		gotoLine:               core.NewSignal(cx, ""),
		quickOpen:              core.NewSignal(cx, false),
		chatFindOpen:           core.NewSignal(cx, false),
		chatSearch:             textview.NewSearch(cx),
		forkCollapsed:          core.NewSignalFunc(cx, map[string]bool{}, nil),
		archiveRev:             core.NewSignal(cx, 0),
		archiveOpen:            core.NewSignal(cx, false),
		impOpen:                core.NewSignal(cx, false),
		impRows:                core.NewSignalFunc(cx, []sessionimport.Row(nil), nil),
		impScanning:            core.NewSignal(cx, false),
		impBusy:                core.NewSignal(cx, false),
		impDone:                core.NewSignal(cx, 0),
		impTotal:               core.NewSignal(cx, 0),
		impFailed:              core.NewSignal(cx, 0),
		impQuery:               core.NewSignal(cx, ""),
		impOnly:                core.NewSignal(cx, ""),
		impProject:             core.NewSignal(cx, ""),
		impSel:                 core.NewSignalFunc(cx, []string(nil), nil),
		railWidth:              core.NewSignal(cx, core.Points(0)),
		drawerWidth:            core.NewSignal(cx, core.Points(0)),
		outlineOpen:            core.NewSignal(cx, false),
		authEntries:            core.NewSignalFunc(cx, []authEntry(nil), nil),
		authErr:                core.NewSignal(cx, ""),
		authKeyOpen:            core.NewSignal(cx, false),
		authKeyProvider:        core.NewSignal(cx, ""),
		authKeyText:            core.NewSignal(cx, ""),
		chatFindText:           core.NewSignal(cx, ""),
		pluginNewOpen:          core.NewSignal(cx, false),
		pluginNewID:            core.NewSignal(cx, ""),
		pluginNewName:          core.NewSignal(cx, ""),
		pluginNewDesc:          core.NewSignal(cx, ""),
		fileSearchOpen:         core.NewSignal(cx, false),
		fileSearchQuery:        core.NewSignal(cx, ""),
		fileSearchBusy:         core.NewSignal(cx, false),
		fileSearchRev:          core.NewSignal(cx, 0),
		gitNewBranchName:       core.NewSignal(cx, ""),
		gitDiffOpen:            core.NewSignal(cx, false),
		gitDiffTitle:           core.NewSignal(cx, ""),
		gitDiffSub:             core.NewSignal(cx, ""),
		gitDiffPatch:           core.NewSignal(cx, ""),
		gitDiffLoading:         core.NewSignal(cx, false),
		clock:                  core.NewSignal(cx, cx.Now()),
		env:                    core.NewSignalFunc(cx, envInfo{Probing: true}, nil),
		pinned:                 core.NewSignalFunc(cx, []string(nil), nil),
		favModels:              core.NewSignalFunc(cx, []string(nil), nil),
		favOpen:                core.NewSignal(cx, false),
		favKind:                core.NewSignal(cx, ""),
		favQuery:               core.NewSignal(cx, ""),
		favRev:                 core.NewSignal(cx, 0),
		taskOpen:               core.NewSignal(cx, false),
		taskFormOpen:           core.NewSignal(cx, false),
		taskRev:                core.NewSignal(cx, 0),
		taskErr:                core.NewSignal(cx, ""),
		taskEditID:             core.NewSignal(cx, ""),
		taskName:               core.NewSignal(cx, ""),
		taskCron:               core.NewSignal(cx, ""),
		taskPrompt:             core.NewSignal(cx, ""),
		taskProject:            core.NewSignal(cx, ""),
		taskBackend:            core.NewSignal(cx, "pi"),
		taskPreset:             core.NewSignal(cx, ""),
		taskPersona:            core.NewSignal(cx, ""),
		taskEnabled:            core.NewSignal(cx, true),
		taskTimeout:            core.NewSignal(cx, "30"),
		themes:                 core.NewSignalFunc(cx, []themeSpec(nil), nil),
		plugins:                core.NewSignalFunc(cx, []plugin(nil), nil),
		providers:              core.NewSignalFunc(cx, []providerInfo(nil), nil),
		usage:                  core.NewSignalFunc(cx, usageReport{}, nil),
		usageLoading:           core.NewSignal(cx, false),
		resources:              core.NewSignalFunc(cx, resourceReport{}, nil),
		resourcesLoading:       core.NewSignal(cx, false),
		askBox:                 core.NewSignal(cx, askBox{}),
		askText:                core.NewSignal(cx, ""),
		announceRev:            core.NewSignal(cx, 0),
		announceOpen:           core.NewSignal(cx, false),
		announceBusy:           core.NewSignal(cx, false),
		announceErr:            core.NewSignal(cx, ""),
		feedbackOpen:           core.NewSignal(cx, false),
		feedbackText:           core.NewSignal(cx, ""),
		feedbackReport:         core.NewSignal(cx, ""),
		projectsRev:            core.NewSignal(cx, 0),
		filesRev:               core.NewSignal(cx, 0),
		filesQuery:             core.NewSignal(cx, ""),
		acpOpen:                core.NewSignal(cx, false),
		acpManageOpen:          core.NewSignal(cx, false),
		acpNewID:               core.NewSignal(cx, ""),
		acpNewName:             core.NewSignal(cx, ""),
		acpNewCommand:          core.NewSignal(cx, ""),
		acpNewArgs:             core.NewSignal(cx, ""),
		acpManageErr:           core.NewSignal(cx, ""),
		acpManageRev:           core.NewSignal(cx, 0),
		agentOpen:              core.NewSignal(cx, false),
		agentManageOpen:        core.NewSignal(cx, false),
		agentManageRev:         core.NewSignal(cx, 0),
		agentManageErr:         core.NewSignal(cx, ""),
		agentEditID:            core.NewSignal(cx, ""),
		agentEditKey:           core.NewSignal(cx, ""),
		agentEditName:          core.NewSignal(cx, ""),
		agentEditDesc:          core.NewSignal(cx, ""),
		agentEditPrompt:        core.NewSignal(cx, ""),
		agentBackend:           core.NewSignal(cx, "pi"),
		agentApply:             core.NewSignal(cx, false),
		projectGroupOpen:       core.NewSignal(cx, false),
		projectGroupPath:       core.NewSignal(cx, ""),
		projectGroupText:       core.NewSignal(cx, ""),
		wsRenameOpen:           core.NewSignal(cx, false),
		wsRenameKey:            core.NewSignal(cx, ""),
		wsRenameText:           core.NewSignal(cx, ""),
		shortcutsOpen:          core.NewSignal(cx, false),
		shortcutsQuery:         core.NewSignal(cx, ""),
		searchOpen:             core.NewSignal(cx, false),
		searchText:             core.NewSignal(cx, ""),
		searchScope:            core.NewSignal(cx, ""),
		searchRev:              core.NewSignal(cx, 0),
		searchHits:             core.NewSignalFunc(cx, []searchHit(nil), nil),
		searchBusy:             core.NewSignal(cx, false),
		prompts:                core.NewSignalFunc(cx, []promptItem(nil), nil),
		promptOpen:             core.NewSignal(cx, false),
		promptQuery:            core.NewSignal(cx, ""),
		promptImportOpen:       core.NewSignal(cx, false),
		promptImportURL:        core.NewSignal(cx, ""),
		promptImportBusy:       core.NewSignal(cx, false),
		promptImportErr:        core.NewSignal(cx, ""),
		promptCat:              core.NewSignal(cx, ""),
		langRev:                core.NewSignal(cx, 0),
		editorWrap:             core.NewSignal(cx, false),
		termFont:               core.NewSignal(cx, 12.5),
		editorFont:             core.NewSignal(cx, 13.0),
		chatWidthPctSig:        core.NewSignal(cx, 0),
		axisHover:              core.NewSignal(cx, -1),
		axisHintIn:             core.NewSignal(cx, false),
		providerOpen:           core.NewSignal(cx, false),
		providerID:             core.NewSignal(cx, ""),
		providerAPI:            core.NewSignal(cx, ""),
		providerBase:           core.NewSignal(cx, ""),
		providerKeySig:         core.NewSignal(cx, ""),
		providerTest:           core.NewSignal(cx, ""),
		providerBalance:        core.NewSignal(cx, ""),
		providerBalURL:         core.NewSignal(cx, ""),
		providerBalPath:        core.NewSignal(cx, ""),
		providerBalCur:         core.NewSignal(cx, ""),
		providerModelEditing:   core.NewSignal(cx, ""),
		providerModelID:        core.NewSignal(cx, ""),
		providerModelName:      core.NewSignal(cx, ""),
		providerModelContext:   core.NewSignal(cx, ""),
		providerModelMax:       core.NewSignal(cx, ""),
		providerModelReasoning: core.NewSignal(cx, false),
		providerModelImages:    core.NewSignal(cx, false),
		providerModelCostIn:    core.NewSignal(cx, ""),
		providerModelCostOut:   core.NewSignal(cx, ""),
		providerModelCostRead:  core.NewSignal(cx, ""),
		providerModelCostWrite: core.NewSignal(cx, ""),
		providerModelsRev:      core.NewSignal(cx, 0),
		modelCompatRev:         core.NewSignal(cx, 0),
		tdKeyOpen:              core.NewSignal(cx, false),
		tdKeyText:              core.NewSignal(cx, ""),
		tdKeyErr:               core.NewSignal(cx, ""),
		tdKeyBusy:              core.NewSignal(cx, false),
		tdBusy:                 core.NewSignal(cx, false),
		tdBalance:              core.NewSignal(cx, ""),
		tdBalanceErr:           core.NewSignal(cx, ""),
		tdModelBusy:            core.NewSignal(cx, false),
		tdModelMsg:             core.NewSignal(cx, ""),
		tdPayOpen:              core.NewSignal(cx, false),
		tdPayAmount:            core.NewSignal(cx, ""),
		tdPayErr:               core.NewSignal(cx, ""),
		tdPayBusy:              core.NewSignal(cx, false),
		tdPayStatus:            core.NewSignal(cx, ""),
		tdTipOpen:              core.NewSignal(cx, false),
		piSetRev:               core.NewSignal(cx, 0),
		piRetryText:            core.NewSignal(cx, ""),
		piReserveText:          core.NewSignal(cx, ""),
		piKeepText:             core.NewSignal(cx, ""),
	}
	a.toaster = ui.NewToaster(cx)
	a.files = newFileTree(cx)
	a.editor = newEditorHost(cx)
	a.editor.onResult = func(title string, err error) {
		if err != nil {
			a.toast(ui.ToastError, title, err.Error())
			return
		}
		a.toast(ui.ToastSuccess, title, "")
	}
	a.git = newGitRepo(cx)
	a.term = newTerminalHost(cx)
	a.term.height.Set(defaultTerminalHeight)
	a.git.onResult = func(label string, err error) {
		if err != nil {
			a.toast(ui.ToastError, label+"失败", err.Error())
			return
		}
		a.toast(ui.ToastSuccess, label, "")
	}

	dataDir := cx.DataDir()
	if custom := os.Getenv("PIDECK_LITE_HOME"); custom != "" {
		dataDir = custom
	}
	a.dataDir = dataDir
	crashlog.SetDataDir(dataDir)
	st, err := newStore(dataDir)
	if err != nil {
		a.toast(ui.ToastError, "无法打开数据目录", err.Error())
		return a
	}
	a.st = st
	// The ask extension travels with the app: pi loads it with -e, and its
	// questions reach the card.
	askExtensionPath = installAskExtension(st.dir)
	a.initDiag()
	a.cfg = st.config()
	a.applyBrand()
	a.uiFont.Set(strings.TrimSpace(a.cfg.UIFont))
	a.monoFont.Set(strings.TrimSpace(a.cfg.MonoFont))
	a.chatFont.Set(a.cfg.ChatFont)
	a.chatLine.Set(a.cfg.ChatLine)
	a.inputFont.Set(a.cfg.InputFont)
	a.bgImage.Set(strings.TrimSpace(a.cfg.BackgroundImage))
	a.bgOpacity.Set(a.backgroundOpacity())
	a.loadAuth()
	a.chatWidthPctSig.Set(a.cfg.ChatWidthPct)
	a.editorWrap.Set(a.cfg.EditorWrap)
	if a.cfg.TerminalFont > 0 {
		a.termFont.Set(a.cfg.TerminalFont)
	}
	if a.cfg.EditorFont > 0 {
		a.editorFont.Set(float64(a.cfg.EditorFont))
	}
	// A crash from the last run is worth one notice, with a way to look.
	if path, at, ok := crashlog.Latest(a.dataDir); ok && filepath.Base(path) != a.cfg.CrashSeen {
		name := filepath.Base(path)
		a.cfg.CrashSeen = name
		st.edit(func(c *config) { c.CrashSeen = name })
		a.cx.Post(func() {
			a.toastAction(ui.ToastWarning, "上次运行崩溃过", at.Format("2006-01-02 15:04"), "查看", func() {
				a.openEditorFile(filepath.Dir(path), path)
			})
		})
	}
	a.piSet, _ = readPiSettings()
	a.applyProxy()
	a.theme.Set(a.cfg.Theme)
	a.sidebar.Set(a.cfg.SidebarOpen)
	a.drawer.Set(a.cfg.DrawerOpen)
	if a.cfg.TerminalHeight > 0 {
		a.term.height.Set(a.cfg.TerminalHeight)
	}
	a.term.open.Set(a.cfg.TerminalOpen)
	a.defaultModel = a.cfg.Model
	a.defaultThinking = a.cfg.Thinking
	a.applyLanguage()
	a.applyTheme()

	a.pinned.Set(a.cfg.Pinned)
	a.favModels.Set(a.cfg.FavModels)
	if a.cfg.RailWidth > 0 {
		a.railWidth.Set(core.Points(a.cfg.RailWidth))
	}
	if a.cfg.DrawerWidth > 0 {
		a.drawerWidth.Set(core.Points(a.cfg.DrawerWidth))
	}
	if a.cfg.DrawerTab != "" {
		a.drawerTab.Set(a.cfg.DrawerTab)
	}
	if a.cfg.SettingsTab != "" {
		a.settingsTab.Set(a.cfg.SettingsTab)
	}
	a.impOnly.Set(a.cfg.ImportSource)
	a.favorites = a.loadFavorites()
	a.loadTasks()
	a.loadAnnouncements()

	metas := st.scanSessions(a.cfg.Titles)
	byKey := map[string][]sessionMeta{}
	for _, m := range metas {
		key := parseTarget(m.Target).key() + "|" + pathKey(m.Cwd)
		byKey[key] = append(byKey[key], m)
	}
	var list []*workspace
	for _, wc := range a.cfg.Workspaces {
		wc.Path = cleanTargetPath(parseTarget(wc.Target), wc.Path)
		ws := &workspace{Path: wc.Path, Name: wc.Name, Group: wc.Group, Pinned: wc.Pinned, Added: wc.Added,
			Chat:      wc.Chat,
			Target:    parseTarget(wc.Target),
			Expanded:  core.NewSignal(cx, wc.Expanded || len(byKey[parseTarget(wc.Target).key()+"|"+pathKey(wc.Path)]) > 0),
			Sessions:  core.NewSignalFunc(cx, []*session{}, nil),
			Pi:        core.NewSignalFunc(cx, []*session(nil), nil),
			PiOpen:    core.NewSignal(cx, false),
			PiLoading: core.NewSignal(cx, false),
			Visible:   core.NewSignal(cx, 0)}
		for _, m := range byKey[parseTarget(wc.Target).key()+"|"+pathKey(wc.Path)] {
			sess := a.makeSession(m, ws.Target)
			ws.Sessions.Update(func(ss []*session) []*session { return append(ss, sess) })
		}
		list = append(list, ws)
	}
	a.workspaces.Set(list)
	// The file drawer can open before any session does: give it the first
	// local project to show.
	for _, ws := range list {
		if !ws.Target.remote() {
			a.files.watch(ws.Path)
			break
		}
	}

	a.loadACPArchives()

	// pi's own sessions are read in the background, with the rest of the
	// environment probe.
	a.reloadFrameworks()

	// Restore tabs and the active session, falling back to the newest one.
	var tabs []string
	for _, id := range a.cfg.Tabs {
		if a.byID[id] != nil {
			tabs = append(tabs, id)
		}
	}
	if len(tabs) == 0 && a.cfg.LastSession != "" && a.byID[a.cfg.LastSession] != nil {
		tabs = []string{a.cfg.LastSession}
	}
	if len(tabs) == 0 {
		if newest := a.newestSession(); newest != nil {
			tabs = []string{newest.ID}
		}
	}
	a.tabs.Set(tabs)
	active := ""
	for _, id := range tabs {
		if id == a.cfg.LastSession {
			active = id
		}
	}
	if active == "" && len(tabs) > 0 {
		active = tabs[0]
	}
	a.activeID.Set(active)
	if sess := a.byID[active]; sess != nil {
		a.activeWS.Set(sess.WS)
		a.openSessionEager(sess)
	}
	a.pick = newPicker(cx)

	a.ensureAddonDirs()
	a.ensurePromptLibrary()
	a.on(eventTurnDone, a.onPlanTurn)
	a.on(eventTurnDone, a.onGoalTurn)
	a.on(eventTurnDone, a.onQueuedTurn)
	a.on(eventTurnDone, a.onFeishuTurn)
	a.remote = newRemoteHost(a)
	a.remote.init()
	a.qrOpen = core.NewSignal(cx, false)
	a.qrLink = core.NewSignal(cx, "")
	a.bindKeys()
	a.bindPaneEscape()
	a.tick()
	// A terminal panel left open comes back with a tab to show.
	if a.term.open.GetUntracked() && len(a.term.tabs.GetUntracked()) == 0 {
		a.newTerminalTab()
	}
	a.setupDesktop()
	a.startTaskScheduler()
	a.startAnnouncements()
	a.startTelemetry()
	return a
}
