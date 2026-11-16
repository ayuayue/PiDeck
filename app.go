//go:build !js && !android && !ios

package main

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// workspace is a project folder and its sessions.
type workspace struct {
	Path      string
	Name      string
	Group     string
	Pinned    bool
	Added     time.Time
	ACPPreset string
	// Chat marks the built-in chat folder under the app's data.
	Chat     bool
	Target   target
	Expanded *core.Signal[bool]
	Sessions *core.Signal[[]*session]
	// Pi are pi's own sessions in this folder, and PiOpen whether the
	// group shows.
	Pi     *core.Signal[[]*session]
	PiOpen *core.Signal[bool]
	// PiLoading says pi's history for the folder is being read, and
	// Visible how many of the project's sessions the rail shows, 0 for
	// the first page.
	PiLoading *core.Signal[bool]
	Visible   *core.Signal[int]
	// piLoaded says this folder's own pi sessions have been read, so a
	// project is scanned when it is opened rather than every project at
	// startup.
	piLoaded bool
}

// Project sessions show a page at a time: the first page, then another
// step with each "more".
const (
	projectSessionPage = 10
	projectSessionStep = 40
)

// key identifies a workspace across machines.
func (w *workspace) key() string { return w.Target.key() + "|" + w.Path }

// label is the folder's name, or its last path element.
func (w *workspace) label() string {
	if w.Name != "" {
		return w.Name
	}
	base := filepath.Base(filepath.Clean(w.Path))
	if base == "." || base == string(filepath.Separator) || base == "" {
		return w.Path
	}
	return base
}

// session is one pi conversation. Its signals outlive its engine: closing a
// tab keeps the transcript and the draft, reopening it reattaches to the
// session file.
type session struct {
	ID       string
	WS       string
	File     string
	Target   target
	External bool // a session in pi's own store, opened in place

	title      *core.Signal[string]
	status     *core.Signal[sessionStatus]
	turns      *core.Signal[[]turn]
	draft      *core.Signal[string]
	images     *core.Signal[[]promptImage]
	model      *core.Signal[modelInfo]
	models     *core.Signal[[]modelInfo]
	modelsBusy *core.Signal[bool]
	thinking   *core.Signal[string]
	levels     *core.Signal[[]string]
	usage      *core.Signal[usageInfo]
	stats      *core.Signal[sessionStats]
	updated    *core.Signal[time.Time]
	loaded     *core.Signal[bool]
	// histFile is how many messages the transcript was painted from the
	// session file, so pi is not asked for a copy already on screen.
	histFile int
	notice   *core.Signal[string]
	queued   *core.Signal[int]
	ask      *core.Signal[*extensionAsk]
	window   *core.Signal[int]
	// todos is the agent's task list, and todoOpen whether the bar above
	// the composer shows all of it.
	todos    *core.Signal[[]todoItem]
	todoOpen *core.Signal[bool]
	// runningSig is whether a turn is in flight. It changes twice a turn,
	// so the composer's controls are not rebuilt by every streamed delta.
	runningSig *core.Signal[bool]
	// planMode asks the next prompt for a plan instead of edits.
	planMode *core.Signal[bool]
	// Step-by-step plan execution.
	planSteps  []string
	planIndex  int
	planActive bool
	// readySig is whether pi answered for this session.
	readySig *core.Signal[bool]

	modelOpen    *core.Signal[bool]
	modelQuery   *core.Signal[string]
	thinkingOpen *core.Signal[bool]
	usageOpen    *core.Signal[bool]
	projectOpen  *core.Signal[bool]

	streamText     *core.Signal[string]
	streamThinking *core.Signal[string]
	liveTools      *core.Signal[[]toolRun]

	conversation *chat.ConversationState
	// tops is where each rendered turn sits in the transcript, for the
	// scroll ruler's tooltips. Only the interface thread touches it.
	tops map[int]float64

	engine *piClient
	// personaID binds the session to a built-in or custom agent.
	personaID string
	// ACP sessions run an external agent CLI instead of pi.
	backend     string
	acpPreset   string
	acp         *acpClient
	acpSID      string
	acpTurnID   string
	acpText     strings.Builder
	acpThink    strings.Builder
	acpFlushDue bool
	acpReply    func(string)
	acpCommands *core.Signal[[]acpCommand]
	acpCmdOpen  *core.Signal[bool]
	acpMode     *core.Signal[string]
	acpModes    *core.Signal[[]acpMode]
	acpModeOpen *core.Signal[bool]
	// acpPerm remembers allow-always and reject-always by tool title.
	acpPerm   map[string]string
	acpPermMu sync.Mutex
	starting  bool
	// restarting makes the exit handler start pi again instead of
	// reporting the process as gone.
	restarting bool
	waiters    []func()

	mu         sync.Mutex
	liveText   strings.Builder // deltas not yet published
	liveThink  strings.Builder
	shownText  strings.Builder // everything published so far
	shownThink strings.Builder
	flushDue   bool

	live      bool
	extStatus map[string]string

	// openTools and openThink remember which rows the user opened or
	// closed, by key; uiSeq changes so the rows redraw.
	openTools map[string]bool
	openThink map[string]bool
	uiSeq     *core.Signal[int]
}

// app is everything the window shows.
type app struct {
	cx      *core.Scope
	st      *store
	cfg     config
	dataDir string
	// crashShown is the panic the crash screen last logged, so it does
	// not write a file on every render; crashPath is where it wrote.
	crashShown string
	crashPath  string
	// feishuPending marks sessions a Feishu message started, so their
	// answer goes back to the group.
	feishuMu      sync.Mutex
	feishuPending map[string]bool

	env       *core.Signal[envInfo]
	pinned    *core.Signal[[]string]
	favModels *core.Signal[[]string]
	// Favorites are local snapshots of answers and references to sessions;
	// favMu guards the list the dialog reads.
	favOpen   *core.Signal[bool]
	favKind   *core.Signal[string]
	favQuery  *core.Signal[string]
	favRev    *core.Signal[int]
	favMu     sync.Mutex
	favorites []favoriteEntry

	// Scheduled tasks: the list, run history and the editor's fields.
	// taskMu guards the list the ticker and the UI both touch.
	taskMu       sync.Mutex
	tasks        []*scheduledTask
	taskRuns     []taskRun
	taskRunning  map[string]bool
	taskOpen     *core.Signal[bool]
	taskFormOpen *core.Signal[bool]
	taskRev      *core.Signal[int]
	taskErr      *core.Signal[string]
	taskEditID   *core.Signal[string]
	taskName     *core.Signal[string]
	taskCron     *core.Signal[string]
	taskPrompt   *core.Signal[string]
	taskProject  *core.Signal[string]
	taskBackend  *core.Signal[string]
	taskPreset   *core.Signal[string]
	taskPersona  *core.Signal[string]
	taskEnabled  *core.Signal[bool]
	taskTimeout  *core.Signal[string]
	themes       *core.Signal[[]themeSpec]
	plugins      *core.Signal[[]plugin]
	providers    *core.Signal[[]providerInfo]
	// usage is the local statistics report, read from the session files
	// the first time the usage page opens.
	usage        *core.Signal[usageReport]
	usageLoading *core.Signal[bool]
	usageLoaded  bool
	// resources are pi's skills and extensions, read when the page opens.
	resources        *core.Signal[resourceReport]
	resourcesLoading *core.Signal[bool]
	resourcesLoaded  bool
	// Parallel inquiry: the question, its answer and the session it ran in.
	askBox  *core.Signal[askBox]
	askText *core.Signal[string]

	// Diagnostics: the in-memory log, its file, and when the app started.
	diagMu     sync.Mutex
	diagEvents []diagEvent
	diagFile   *os.File
	diagPath   string
	diagSize   int
	startedAt  time.Time

	// projectsRev changes when a project is pinned, grouped or moved.
	projectsRev      *core.Signal[int]
	projectGroupOpen *core.Signal[bool]
	projectGroupPath *core.Signal[string]
	projectGroupText *core.Signal[string]
	wsRenameOpen     *core.Signal[bool]
	wsRenameKey      *core.Signal[string]
	wsRenameText     *core.Signal[string]

	// The ACP preset picker.
	acpOpen *core.Signal[bool]
	// The ACP preset manager.
	acpManageOpen *core.Signal[bool]
	acpNewID      *core.Signal[string]
	acpNewName    *core.Signal[string]
	acpNewCommand *core.Signal[string]
	acpNewArgs    *core.Signal[string]
	acpManageErr  *core.Signal[string]
	acpManageRev  *core.Signal[int]
	agentOpen     *core.Signal[bool]
	// The agent manager: the list, the edit form and which agent is being
	// edited. agentBackend picks what a new agent session runs on, and
	// agentApply binds the picked agent to the active session instead of
	// starting a new one.
	agentManageOpen *core.Signal[bool]
	agentManageRev  *core.Signal[int]
	agentManageErr  *core.Signal[string]
	agentEditID     *core.Signal[string]
	agentEditKey    *core.Signal[string]
	agentEditName   *core.Signal[string]
	agentEditDesc   *core.Signal[string]
	agentEditPrompt *core.Signal[string]
	agentBackend    *core.Signal[string]
	agentApply      *core.Signal[bool]

	// Announcements: the feed the maintainer publishes, the entries the
	// user has read, and when the feed was last read. announceMu guards
	// the list the fetch and the UI both touch.
	announceMu      sync.Mutex
	announceItems   []announceItem
	announceRead    map[string]bool
	announceFetched time.Time
	announceRev     *core.Signal[int]
	announceOpen    *core.Signal[bool]
	announceBusy    *core.Signal[bool]
	announceErr     *core.Signal[string]

	// The feedback dialog: what the user wrote and the report beside it.
	feedbackOpen   *core.Signal[bool]
	feedbackText   *core.Signal[string]
	feedbackReport *core.Signal[string]

	// The keyboard cheat sheet.
	shortcutsOpen  *core.Signal[bool]
	shortcutsQuery *core.Signal[string]

	// Global session search: its index, query and results.
	searchOpen     *core.Signal[bool]
	searchText     *core.Signal[string]
	searchScope    *core.Signal[string]
	searchRev      *core.Signal[int]
	searchHits     *core.Signal[[]searchHit]
	searchBusy     *core.Signal[bool]
	searchDocs     []searchDoc
	searchIndexed  bool
	searchBuilding bool
	searchGen      int

	// The prompt library: its packs, the dialog's query and category.
	prompts          *core.Signal[[]promptItem]
	promptOpen       *core.Signal[bool]
	promptQuery      *core.Signal[string]
	promptImportOpen *core.Signal[bool]
	promptImportURL  *core.Signal[string]
	promptImportBusy *core.Signal[bool]
	promptImportErr  *core.Signal[string]
	promptCat        *core.Signal[string]

	// The provider editor: which provider, its fields, and the result of
	// a connection test.
	providerOpen    *core.Signal[bool]
	providerID      *core.Signal[string]
	providerAPI     *core.Signal[string]
	providerBase    *core.Signal[string]
	providerKeySig  *core.Signal[string]
	providerTest    *core.Signal[string]
	providerBalance *core.Signal[string]
	providerBalURL  *core.Signal[string]
	providerBalPath *core.Signal[string]
	providerBalCur  *core.Signal[string]
	// The model editor in the provider dialog.
	providerModelEditing   *core.Signal[string]
	providerModelID        *core.Signal[string]
	providerModelName      *core.Signal[string]
	providerModelContext   *core.Signal[string]
	providerModelMax       *core.Signal[string]
	providerModelReasoning *core.Signal[bool]
	providerModelsRev      *core.Signal[int]
	// pi settings.json, as the settings page shows it.
	piSet    piSettings
	piSetErr string
	piSetRev *core.Signal[int]
	// The number fields text, so typing survives a redraw.
	piRetryText    *core.Signal[string]
	piReserveText  *core.Signal[string]
	piKeepText     *core.Signal[string]
	providerModels []modelConfig

	// langRev changes when the interface language does, so pages that
	// hold static text rebuild.
	langRev    *core.Signal[int]
	editorWrap *core.Signal[bool]
	termFont   *core.Signal[float64]
	editorFont *core.Signal[float64]
	// chatWidth is the transcript's reading width, so a slider drag
	// rebuilds the chat without touching the stored config.
	chatWidth *core.Signal[int]
	// axisHover is the ruler tick the pointer rests on, -1 for none, and
	// axisHintIn whether its summary has had its first frame to ease in.
	axisHover  *core.Signal[int]
	axisHintIn *core.Signal[bool]
	// events carries app events to subscribers and plugin hooks; inHook
	// stops a hook's own action from triggering hooks again.
	events eventBus
	inHook bool

	workspaces *core.Signal[[]*workspace]
	activeWS   *core.Signal[string]
	tabs       *core.Signal[[]string]
	activeID   *core.Signal[string]
	filter     *core.Signal[string]
	sidebar    *core.Signal[bool]
	drawer     *core.Signal[bool]
	drawerTab  *core.Signal[string]
	theme      *core.Signal[string]
	uiFont     *core.Signal[string]
	monoFont   *core.Signal[string]
	toolRev    *core.Signal[int]
	aiBusy     *core.Signal[string]
	bgImage    *core.Signal[string]
	bgOpacity  *core.Signal[float64]
	llmFn      func(tool, system, prompt string, maxTokens int) (string, error)

	byID map[string]*session
	all  []*session

	palette  *core.Signal[bool]
	settings *core.Signal[bool]
	// settingsRev changes after a setting is switched, so the page shows
	// the value it now holds.
	settingsRev *core.Signal[int]
	// settingsScroll and settingsOffset remember where a settings page was
	// scrolled, so redrawing it after a switch keeps the reader's place.
	settingsScroll *core.Ref
	settingsOffset core.Point
	settingsTab    *core.Signal[string]
	addWS          *core.Signal[bool]
	addTarget      *core.Signal[bool]
	addKind        *core.Signal[int]
	addWhere       *core.Signal[string]
	addPath        *core.Signal[string]
	importOpen     *core.Signal[bool]
	renameOpen     *core.Signal[bool]
	renameText     *core.Signal[string]
	renameID       string
	// The file name dialog: new file, new folder or rename.
	fileOpOpen   *core.Signal[bool]
	fileOpTitle  *core.Signal[string]
	fileOpText   *core.Signal[string]
	fileOpAction func(string)
	// The export dialog and the session it writes.
	exportOpen *core.Signal[bool]
	exportID   string
	// The trust dialog and what waits for the answer.
	trustOpen *core.Signal[bool]
	trustWS   *workspace
	trustThen func()
	// The step-by-step plan dialog.
	planAskOpen    *core.Signal[bool]
	planAskSession *session
	// The fork tree dialog.
	forksOpen *core.Signal[bool]
	// The settings search query.
	settingsQuery *core.Signal[string]
	// MCP servers, read through pi's CLI.
	mcpServers *core.Signal[[]mcpServer]
	mcpBusy    *core.Signal[bool]
	mcpErr     *core.Signal[string]
	mcpLoaded  bool
	mcpAddOpen *core.Signal[bool]
	mcpAddBusy *core.Signal[bool]
	mcpAddErr  *core.Signal[string]
	mcpName    *core.Signal[string]
	mcpURL     *core.Signal[string]
	mcpCommand *core.Signal[string]
	mcpDesc    *core.Signal[string]
	mcpLocal   *core.Signal[bool]
	// The prompt store.
	promptStoreOpen       *core.Signal[bool]
	promptStoreURL        *core.Signal[string]
	promptStoreBusy       *core.Signal[bool]
	promptStoreErr        *core.Signal[string]
	promptStoreList       *core.Signal[[]promptIndexEntry]
	promptStoreInstalling *core.Signal[string]
	promptStoreDone       map[string]bool
	// The skill store.
	skillStoreOpen       *core.Signal[bool]
	skillStoreURL        *core.Signal[string]
	skillStoreBusy       *core.Signal[bool]
	skillStoreErr        *core.Signal[string]
	skillStoreList       *core.Signal[[]skillIndexEntry]
	skillStoreInstalling *core.Signal[string]
	skillStoreDone       map[string]bool
	// The plugin market.
	marketOpen       *core.Signal[bool]
	marketURL        *core.Signal[string]
	marketBusy       *core.Signal[bool]
	marketErr        *core.Signal[string]
	marketList       *core.Signal[[]marketEntry]
	marketInstalling *core.Signal[string]
	// Image generation.
	imageOpen     *core.Signal[bool]
	imagePrompt   *core.Signal[string]
	imageModel    *core.Signal[string]
	imageSize     *core.Signal[string]
	imageProvider *core.Signal[string]
	imageBusy     *core.Signal[bool]
	imageErr      *core.Signal[string]
	imageResults  *core.Signal[[][]byte]
	imageSelected *core.Signal[int]
	imageType     *core.Signal[string]
	imageCount    *core.Signal[int]
	imageRef      *core.Signal[string]
	// The vision bridge.
	visionOpen     *core.Signal[bool]
	visionPath     *core.Signal[string]
	visionQuestion *core.Signal[string]
	visionModel    *core.Signal[string]
	visionProvider *core.Signal[string]
	visionBusy     *core.Signal[bool]
	visionErr      *core.Signal[string]
	visionText     *core.Signal[string]
	confirmOpen    *core.Signal[bool]
	confirmHead    *core.Signal[string]
	confirmBody    *core.Signal[string]
	confirmWhy     *core.Signal[string]
	confirmFn      func()

	pick *pickerState

	askEdit *core.Signal[string]
	askSeq  *core.Signal[int]

	files      *fileTree
	filesRev   *core.Signal[int]
	filesQuery *core.Signal[string]
	fileIdx    fileIndexCache
	editor     *editorHost
	git        *gitRepo
	term       *terminalHost
	remote     *remoteHost

	// The QR dialog shows a connection link the phone can scan.
	qrOpen *core.Signal[bool]
	qrLink *core.Signal[string]
	qrPNG  []byte

	// Git dialogs: the branch menu and new-branch dialog, and the diff or
	// commit patch in front.
	gitBranches      *core.Signal[bool]
	gitNewBranchOpen *core.Signal[bool]
	// The stash list.
	gitStashOpen   *core.Signal[bool]
	gitStashList   *core.Signal[[]gitStashEntry]
	gitStashBusy   *core.Signal[bool]
	gitStashErr    *core.Signal[string]
	gitMoreOpen    *core.Signal[bool]
	gitTagsOpen    *core.Signal[bool]
	gitRemotesOpen *core.Signal[bool]
	// gitConflictsOpen shows the dialog that resolves a merge's conflicts.
	gitConflictsOpen *core.Signal[bool]
	// gitBlameOpen shows who last touched each run of lines.
	gitBlameOpen *core.Signal[bool]
	gitBlamePath *core.Signal[string]
	gitBlameRev  *core.Signal[int]
	gitBlameErr  *core.Signal[string]
	gitBlame     []blameRange
	// gitFileHistoryOpen shows the commits that touched one path.
	gitFileHistoryOpen *core.Signal[bool]
	gitFileHistoryPath *core.Signal[string]
	gitFileHistoryRev  *core.Signal[int]
	gitFileHistoryErr  *core.Signal[string]
	gitFileHistory     []gitCommit
	// gitUnpushedOpen shows the commits the upstream does not have.
	gitUnpushedOpen *core.Signal[bool]
	gitUnpushedRev  *core.Signal[int]
	gitUnpushedErr  *core.Signal[string]
	gitUnpushed     []gitCommit
	gitRemoteName   *core.Signal[string]
	gitRemoteURL    *core.Signal[string]
	gitTagText      *core.Signal[string]
	termRenameOpen  *core.Signal[bool]
	termRenameID    *core.Signal[string]
	termRenameText  *core.Signal[string]
	gotoOpen        *core.Signal[bool]
	gotoLine        *core.Signal[string]
	quickOpen       *core.Signal[bool]
	chatFindOpen    *core.Signal[bool]
	chatSearch      *textview.Search
	keepAwake       func()
	forkCollapsed   *core.Signal[map[string]bool]
	archiveRev      *core.Signal[int]
	archiveOpen     *core.Signal[bool]
	outlineOpen     *core.Signal[bool]
	authEntries     *core.Signal[[]authEntry]
	authErr         *core.Signal[string]
	authKeyOpen     *core.Signal[bool]
	authKeyProvider *core.Signal[string]
	authKeyText     *core.Signal[string]
	chatFindText    *core.Signal[string]
	pluginNewOpen   *core.Signal[bool]
	pluginNewID     *core.Signal[string]
	pluginNewName   *core.Signal[string]
	pluginNewDesc   *core.Signal[string]
	fileSearchOpen  *core.Signal[bool]
	// fileSearchQuery, fileSearchBusy and fileSearchRev drive the content
	// search; its hits and sequence live beside them.
	fileSearchQuery *core.Signal[string]
	fileSearchBusy  *core.Signal[bool]
	fileSearchRev   *core.Signal[int]
	fileSearchMu    sync.Mutex
	fileSearchHits  []fileHit
	fileSearchSeq   int
	// gitDiffHash is the commit the diff dialog shows, empty for a file.
	gitDiffHash string
	// closedTabs are the sessions whose tabs were closed, newest last.
	closedTabs []string
	// addonsGen drops a stale plugin reload that finished after a newer one.
	addonsGen        int
	gitNewBranchName *core.Signal[string]
	gitDiffOpen      *core.Signal[bool]
	gitDiffTitle     *core.Signal[string]
	gitDiffSub       *core.Signal[string]
	gitDiffPatch     *core.Signal[string]
	gitDiffLoading   *core.Signal[bool]

	toaster *ui.Toaster
	clock   *core.Signal[time.Time]

	defaultModel    modelChoice
	defaultThinking string
	notes           int

	// keymap is key → command at this moment; boundKeys are the keys the
	// platform already knows about, so a rebuild only binds new ones.
	keymap       map[string]string
	boundKeys    map[string]bool
	keybindings  []keyBinding
	keyConflicts []string

	// Desktop: the main window, the tray icon and whether the app is
	// really quitting rather than hiding.
	mainWin    *core.Window
	petWin     *core.Window
	tray       *core.Tray
	quitting   bool
	trayHinted bool
	mainHooked bool
	mainTries  int
	lastTray   time.Time
}

// newApp builds the state from the config and the session store.
func newApp(cx *core.Scope) *app {
	a := &app{
		cx:                     cx,
		byID:                   map[string]*session{},
		workspaces:             core.NewSignalFunc(cx, []*workspace{}, nil),
		activeWS:               core.NewSignal(cx, ""),
		tabs:                   core.NewSignalFunc(cx, []string{}, nil),
		activeID:               core.NewSignal(cx, ""),
		filter:                 core.NewSignal(cx, ""),
		sidebar:                core.NewSignal(cx, true),
		drawer:                 core.NewSignal(cx, false),
		drawerTab:              core.NewSignal(cx, "overview"),
		theme:                  core.NewSignal(cx, "system"),
		uiFont:                 core.NewSignal(cx, ""),
		monoFont:               core.NewSignal(cx, ""),
		toolRev:                core.NewSignal(cx, 0),
		aiBusy:                 core.NewSignal(cx, ""),
		bgImage:                core.NewSignal(cx, ""),
		bgOpacity:              core.NewSignal(cx, 0.8),
		palette:                core.NewSignal(cx, false),
		settings:               core.NewSignal(cx, false),
		settingsTab:            core.NewSignal(cx, "env"),
		settingsRev:            core.NewSignal(cx, 0),
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
		askEdit:                core.NewSignal(cx, ""),
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
		chatWidth:              core.NewSignal(cx, 0),
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
		providerModelsRev:      core.NewSignal(cx, 0),
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
	setCrashDataDir(dataDir)
	st, err := newStore(dataDir)
	if err != nil {
		a.toast(ui.ToastError, "无法打开数据目录", err.Error())
		return a
	}
	a.st = st
	a.initDiag()
	a.cfg = st.config()
	a.uiFont.Set(strings.TrimSpace(a.cfg.UIFont))
	a.monoFont.Set(strings.TrimSpace(a.cfg.MonoFont))
	a.bgImage.Set(strings.TrimSpace(a.cfg.BackgroundImage))
	a.bgOpacity.Set(a.backgroundOpacity())
	a.loadAuth()
	a.chatWidth.Set(a.cfg.ChatWidth)
	a.editorWrap.Set(a.cfg.EditorWrap)
	if a.cfg.TerminalFont > 0 {
		a.termFont.Set(a.cfg.TerminalFont)
	}
	if a.cfg.EditorFont > 0 {
		a.editorFont.Set(float64(a.cfg.EditorFont))
	}
	// A crash from the last run is worth one notice, with a way to look.
	if path, at, ok := latestCrash(a.dataDir); ok && filepath.Base(path) != a.cfg.CrashSeen {
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
	a.favorites = a.loadFavorites()
	a.loadTasks()
	a.loadAnnouncements()

	metas := st.scanSessions(a.cfg.Titles)
	byKey := map[string][]sessionMeta{}
	for _, m := range metas {
		key := parseTarget(m.Target).key() + "|" + filepath.Clean(m.Cwd)
		byKey[key] = append(byKey[key], m)
	}
	var list []*workspace
	for _, wc := range a.cfg.Workspaces {
		wc.Path = cleanTargetPath(parseTarget(wc.Target), wc.Path)
		ws := &workspace{Path: wc.Path, Name: wc.Name, Group: wc.Group, Pinned: wc.Pinned, Added: wc.Added,
			Chat:      wc.Chat,
			Target:    parseTarget(wc.Target),
			Expanded:  core.NewSignal(cx, wc.Expanded || len(byKey[parseTarget(wc.Target).key()+"|"+wc.Path]) > 0),
			Sessions:  core.NewSignalFunc(cx, []*session{}, nil),
			Pi:        core.NewSignalFunc(cx, []*session(nil), nil),
			PiOpen:    core.NewSignal(cx, false),
			PiLoading: core.NewSignal(cx, false),
			Visible:   core.NewSignal(cx, 0)}
		for _, m := range byKey[parseTarget(wc.Target).key()+"|"+wc.Path] {
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
	a.on(eventTurnDone, a.onFeishuTurn)
	a.remote = newRemoteHost(a)
	a.remote.init()
	a.qrOpen = core.NewSignal(cx, false)
	a.qrLink = core.NewSignal(cx, "")
	a.bindKeys()
	a.tick()
	// A terminal panel left open comes back with a tab to show.
	if a.term.open.GetUntracked() && len(a.term.tabs.GetUntracked()) == 0 {
		a.newTerminalTab()
	}
	a.setupDesktop()
	a.startTaskScheduler()
	a.startAnnouncements()
	return a
}

// makeSession builds the signals of one stored session.
func (a *app) makeSession(m sessionMeta, t target) *session {
	if existing := a.byID[m.ID]; existing != nil {
		return existing
	}
	s := &session{
		ID:             m.ID,
		WS:             m.Cwd,
		File:           m.File,
		Target:         t,
		External:       m.External,
		title:          core.NewSignal(a.cx, m.Title),
		status:         core.NewSignal(a.cx, statusIdle),
		turns:          core.NewSignalFunc(a.cx, []turn{}, nil),
		draft:          core.NewSignal(a.cx, ""),
		images:         core.NewSignalFunc(a.cx, []promptImage(nil), nil),
		model:          core.NewSignal(a.cx, modelInfo{}),
		models:         core.NewSignalFunc(a.cx, []modelInfo(nil), nil),
		modelsBusy:     core.NewSignal(a.cx, false),
		thinking:       core.NewSignal(a.cx, ""),
		levels:         core.NewSignalFunc(a.cx, []string(nil), nil),
		usage:          core.NewSignal(a.cx, usageInfo{}),
		stats:          core.NewSignal(a.cx, sessionStats{}),
		updated:        core.NewSignal(a.cx, m.Updated),
		loaded:         core.NewSignal(a.cx, false),
		notice:         core.NewSignal(a.cx, ""),
		queued:         core.NewSignal(a.cx, 0),
		ask:            core.NewSignalFunc(a.cx, (*extensionAsk)(nil), nil),
		window:         core.NewSignal(a.cx, 24),
		todos:          core.NewSignalFunc(a.cx, []todoItem(nil), nil),
		todoOpen:       core.NewSignal(a.cx, false),
		runningSig:     core.NewSignal(a.cx, false),
		planMode:       core.NewSignal(a.cx, false),
		readySig:       core.NewSignal(a.cx, false),
		modelOpen:      core.NewSignal(a.cx, false),
		modelQuery:     core.NewSignal(a.cx, ""),
		thinkingOpen:   core.NewSignal(a.cx, false),
		usageOpen:      core.NewSignal(a.cx, false),
		projectOpen:    core.NewSignal(a.cx, false),
		streamText:     core.NewSignal(a.cx, ""),
		streamThinking: core.NewSignal(a.cx, ""),
		liveTools:      core.NewSignalFunc(a.cx, []toolRun(nil), nil),
		extStatus:      map[string]string{},
		openTools:      map[string]bool{},
		uiSeq:          core.NewSignal(a.cx, 0),
		acpCommands:    core.NewSignalFunc(a.cx, []acpCommand(nil), nil),
		acpCmdOpen:     core.NewSignal(a.cx, false),
		acpMode:        core.NewSignal(a.cx, ""),
		acpModes:       core.NewSignalFunc(a.cx, []acpMode(nil), nil),
		acpModeOpen:    core.NewSignal(a.cx, false),
	}
	if id := a.cfg.SessionPersonas[m.ID]; id != "" {
		s.personaID = id
	}
	s.conversation = chat.NewConversationState(a.cx)
	a.byID[s.ID] = s
	a.all = append(a.all, s)
	return s
}

// newestSession is the most recently touched session.
func (a *app) newestSession() *session {
	var newest *session
	for _, s := range a.all {
		if newest == nil || s.updated.GetUntracked().After(newest.updated.GetUntracked()) {
			newest = s
		}
	}
	return newest
}

// sessionOf finds an open session by id.
func (a *app) sessionOf(id string) *session { return a.byID[id] }

// toolOpen reports the user's choice for a tool row; auto is the default
// while they have not chosen, open for a call that is still running.
func (s *session) toolOpen(key string, auto bool) bool {
	if v, ok := s.openTools[key]; ok {
		return v
	}
	return auto
}

// toggleOpen opens or closes a row, remembering the user's choice.
func (s *session) toggleOpen(key string) {
	if s.openTools == nil {
		s.openTools = map[string]bool{}
	}
	s.openTools[key] = !s.openTools[key]
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// thinkingRowOpen reports the user's choice for a thinking row; auto is the
// default while the user has not chosen.
func (s *session) thinkingRowOpen(key string, auto bool) bool {
	if v, ok := s.openThink[key]; ok {
		return v
	}
	return auto
}

// toggleThink opens or closes a thinking row.
func (s *session) toggleThink(key string, auto bool) {
	if s.openThink == nil {
		s.openThink = map[string]bool{}
	}
	s.openThink[key] = !s.thinkingRowOpen(key, auto)
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// pinnedSessions are the sessions the user keeps at the top, in their
// order.
func (a *app) pinnedSessions() []*session {
	var out []*session
	for _, id := range a.pinned.Get() {
		if s := a.byID[id]; s != nil {
			out = append(out, s)
		}
	}
	return out
}

// isPinned reports whether a session is kept at the top.
func (a *app) isPinned(id string) bool {
	for _, p := range a.pinned.Get() {
		if p == id {
			return true
		}
	}
	return false
}

// settingsTick subscribes the caller to settings changes; pages call it so a
// switch redraws with the value it now holds.
func (a *app) settingsTick() {
	if a.settingsRev != nil {
		a.settingsRev.Get()
	}
}

// bumpSettings redraws the settings page after a value changed, and puts
// the reader back where they were: the redraw makes a new scroll view.
func (a *app) bumpSettings() {
	if a.settingsRev == nil {
		return
	}
	a.settingsRev.Update(func(n int) int { return n + 1 })
	a.restoreSettingsScroll()
}

// settingsScrolled remembers the settings page's offset.
func (a *app) settingsScrolled(e core.ScrollEvent) {
	if e.Offset.Y >= 0 {
		a.settingsOffset = e.Offset
	}
}

// restoreSettingsScroll scrolls a redrawn page back to where it was.
func (a *app) restoreSettingsScroll() {
	if a.settingsOffset.Y <= 0 || a.settingsScroll == nil {
		return
	}
	at := a.settingsOffset
	a.cx.Post(func() {
		a.settingsScroll.ScrollTo(at, false)
		a.cx.Post(func() { a.settingsScroll.ScrollTo(at, false) })
	})
}

// toggleSessionSort flips a project's session order.
func (a *app) toggleSessionSort() {
	next := "name"
	if a.cfg.SessionSort == "name" {
		next = "updated"
	}
	a.cfg.SessionSort = next
	a.st.edit(func(c *config) { c.SessionSort = next })
	a.toast(ui.ToastInfo, "会话排序", map[string]string{"name": "按名称", "updated": "按最近活动"}[next])
}

// togglePin keeps a session at the top, or lets it go.
func (a *app) togglePin(s *session) {
	if s == nil {
		return
	}
	ids := a.pinned.GetUntracked()
	if a.isPinned(s.ID) {
		out := ids[:0]
		for _, id := range ids {
			if id != s.ID {
				out = append(out, id)
			}
		}
		a.pinned.Set(out)
	} else {
		a.pinned.Set(append(append([]string(nil), ids...), s.ID))
	}
	a.st.edit(func(c *config) { c.Pinned = append([]string(nil), a.pinned.GetUntracked()...) })
}

// toggleFavModel stars a model, or unstars it.
func (a *app) toggleFavModel(m modelInfo) {
	if m.ID == "" {
		return
	}
	key := m.Provider + "/" + m.ID
	list := a.favModels.GetUntracked()
	out := make([]string, 0, len(list)+1)
	found := false
	for _, k := range list {
		if k == key {
			found = true
			continue
		}
		out = append(out, k)
	}
	if !found {
		out = append(out, key)
	}
	a.favModels.Set(out)
	a.st.edit(func(c *config) { c.FavModels = append([]string(nil), out...) })
}

// providerOrder is the provider list in the user's order, with any the
// config does not name appended alphabetically.
func (a *app) providerOrder() []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range a.cfg.ProviderOrder {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	var rest []string
	for _, p := range a.providers.GetUntracked() {
		if !seen[p.ID] {
			rest = append(rest, p.ID)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// moveProvider moves a provider up or down in the order.
func (a *app) moveProvider(id string, delta int) {
	order := a.providerOrder()
	ix := -1
	for i, p := range order {
		if p == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	j := ix + delta
	if j < 0 || j >= len(order) {
		return
	}
	order[ix], order[j] = order[j], order[ix]
	a.cfg.ProviderOrder = order
	a.st.edit(func(c *config) { c.ProviderOrder = append([]string(nil), order...) })
}

// pinProvider puts a provider first in the order.
func (a *app) pinProvider(id string) {
	order := a.providerOrder()
	out := []string{id}
	for _, p := range order {
		if p != id {
			out = append(out, p)
		}
	}
	a.cfg.ProviderOrder = out
	a.st.edit(func(c *config) { c.ProviderOrder = append([]string(nil), out...) })
}

// moveFavourite moves a starred model up or down among the favourites.
func (a *app) moveFavourite(key string, delta int) {
	list := append([]string(nil), a.favModels.GetUntracked()...)
	ix := -1
	for i, k := range list {
		if k == key {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	j := ix + delta
	if j < 0 || j >= len(list) {
		return
	}
	list[ix], list[j] = list[j], list[ix]
	a.favModels.Set(list)
	a.st.edit(func(c *config) { c.FavModels = append([]string(nil), list...) })
}

// isFavModel reports whether a model is starred.
func (a *app) isFavModel(m modelInfo) bool {
	key := m.Provider + "/" + m.ID
	for _, k := range a.favModels.Get() {
		if k == key {
			return true
		}
	}
	return false
}

// projectSessions is a project's sessions: the app's own and pi's in the
// same folder, pinned first, then by the chosen order. Pinned ones are
// shown under their own heading.
// sessionArchived reports whether the rail hides a session.
func (a *app) sessionArchived(id string) bool {
	for _, x := range a.cfg.Archived {
		if x == id {
			return true
		}
	}
	return false
}

// toggleArchive hides a session from the rail, or shows it again.
func (a *app) toggleArchive(s *session) {
	if s == nil {
		return
	}
	next := append([]string(nil), a.cfg.Archived...)
	found := -1
	for i, id := range next {
		if id == s.ID {
			found = i
			break
		}
	}
	if found >= 0 {
		next = append(next[:found], next[found+1:]...)
	} else {
		next = append([]string{s.ID}, next...)
	}
	a.cfg.Archived = next
	if a.st != nil {
		a.st.edit(func(c *config) { c.Archived = append([]string(nil), next...) })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
	if found >= 0 {
		a.toast(ui.ToastSuccess, T("已取消归档"), s.title.GetUntracked())
	} else {
		a.toast(ui.ToastSuccess, T("已归档"), s.title.GetUntracked())
	}
}

// loadAuth reads pi's credentials file into the settings page.
func (a *app) loadAuth() {
	go func() {
		entries, err := readAuthEntries()
		a.cx.Post(func() {
			if err != nil {
				a.authErr.Set(err.Error())
				return
			}
			a.authErr.Set("")
			a.authEntries.Set(entries)
		})
	}()
}

// openAuthKey asks for one provider's api key.
func (a *app) openAuthKey(provider string) {
	a.authKeyProvider.Set(provider)
	a.authKeyText.Set("")
	a.authKeyOpen.Set(true)
}

// saveAuthKey writes the key that was typed and reloads the list.
func (a *app) saveAuthKey() {
	provider := a.authKeyProvider.GetUntracked()
	key := strings.TrimSpace(a.authKeyText.GetUntracked())
	if key == "" {
		a.toast(ui.ToastWarning, "还没有填密钥", "粘贴 API key 再保存。")
		return
	}
	if err := replaceAuthKey(provider, key); err != nil {
		a.toast(ui.ToastError, "写不了 auth.json", err.Error())
		return
	}
	a.authKeyOpen.Set(false)
	a.authKeyText.Set("")
	a.toast(ui.ToastSuccess, "密钥已更新", provider)
	a.loadAuth()
}

// dropAuthEntry removes a provider after asking.
func (a *app) dropAuthEntry(provider string) {
	if strings.TrimSpace(provider) == "" {
		return
	}
	a.askConfirm("删除凭据", "从 auth.json 里删掉「"+provider+"」的凭据？", "删除", func() {
		if err := removeAuthEntry(provider); err != nil {
			a.toast(ui.ToastError, "写不了 auth.json", err.Error())
			return
		}
		a.toast(ui.ToastSuccess, "已删除凭据", provider)
		a.loadAuth()
	})
}

// findSession is a session by id, loaded or only listed in its project.
func (a *app) findSession(id string) *session {
	if s := a.byID[id]; s != nil {
		return s
	}
	for _, ws := range a.workspaces.GetUntracked() {
		for _, s := range ws.Sessions.GetUntracked() {
			if s != nil && s.ID == id {
				return s
			}
		}
		for _, s := range ws.Pi.GetUntracked() {
			if s != nil && s.ID == id {
				return s
			}
		}
	}
	return nil
}

// toggleShowArchived flips whether archived sessions show in the rail.
func (a *app) toggleShowArchived() {
	on := !a.cfg.ShowArchived
	a.cfg.ShowArchived = on
	if a.st != nil {
		a.st.edit(func(c *config) { c.ShowArchived = on })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
}

func (a *app) projectSessions(ws *workspace) (pinned, rest []*session) {
	all := append(append([]*session{}, ws.Sessions.Get()...), ws.Pi.Get()...)
	seen := map[string]bool{}
	var list []*session
	for _, s := range all {
		if s == nil || seen[s.ID] {
			continue
		}
		seen[s.ID] = true
		list = append(list, s)
	}
	if !a.cfg.ShowArchived {
		kept := list[:0]
		for _, s := range list {
			if !a.sessionArchived(s.ID) {
				kept = append(kept, s)
			}
		}
		list = kept
	}
	sort.SliceStable(list, func(i, j int) bool {
		pi, pj := a.pinIndex(list[i].ID), a.pinIndex(list[j].ID)
		if (pi >= 0) != (pj >= 0) {
			return pi >= 0
		}
		if pi >= 0 && pj >= 0 && pi != pj {
			return pi < pj
		}
		if a.cfg.SessionSort == "name" {
			return strings.ToLower(list[i].title.GetUntracked()) < strings.ToLower(list[j].title.GetUntracked())
		}
		return list[i].updated.GetUntracked().After(list[j].updated.GetUntracked())
	})
	for _, s := range list {
		if a.pinIndex(s.ID) >= 0 {
			pinned = append(pinned, s)
		} else {
			rest = append(rest, s)
		}
	}
	return pinned, rest
}

// pinIndex is a pinned session's place, -1 when it is not pinned.
func (a *app) pinIndex(id string) int {
	for i, p := range a.pinned.Get() {
		if p == id {
			return i
		}
	}
	return -1
}

// sessionGroup is a heading and the sessions under it.
type sessionGroup struct {
	Label string
	Rows  []*session
}

// sessionBuckets groups sessions by when they last changed.
func sessionBuckets(list []*session, now time.Time) []sessionGroup {
	type bucket struct {
		label string
		rows  []*session
	}
	var out []bucket
	label := func(t time.Time) string {
		d := now.Sub(t)
		switch {
		case sameDay(t, now):
			return "今天"
		case sameDay(t, now.Add(-24*time.Hour)):
			return "昨天"
		case d < 7*24*time.Hour:
			return "本周"
		}
		return "更早"
	}
	for _, s := range list {
		l := label(s.updated.GetUntracked())
		if len(out) == 0 || out[len(out)-1].label != l {
			out = append(out, bucket{label: l})
		}
		out[len(out)-1].rows = append(out[len(out)-1].rows, s)
	}
	res := make([]sessionGroup, 0, len(out))
	for _, b := range out {
		res = append(res, sessionGroup{Label: b.label, Rows: b.rows})
	}
	return res
}

// sameDay reports whether two times fall on the same calendar day here.
func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// activeWorkspace is the workspace the active session belongs to, or the
// last one chosen in the rail.
func (a *app) activeWorkspace() *workspace {
	if s := a.active(); s != nil {
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
			return ws
		}
	}
	if ws := a.workspaceOf(a.activeWS.Get()); ws != nil {
		return ws
	}
	if list := a.workspaces.Get(); len(list) > 0 {
		return list[0]
	}
	return nil
}

// busy reports whether a turn is in flight, including a prompt that was
// accepted but has not started streaming yet.
func (s *session) busy() bool { return s.runningSig.Get() }

// busyNow is busy without subscribing the caller.
func (s *session) busyNow() bool { return s.runningSig.GetUntracked() }

// active returns the session in front, or nil.
func (a *app) active() *session { return a.byID[a.activeID.Get()] }

// workspaceFor finds a workspace of a target by path.
func (a *app) workspaceFor(t target, path string) *workspace {
	path = cleanTargetPath(t, path)
	for _, ws := range a.workspaces.Get() {
		if ws.Path == path && ws.Target.key() == t.key() {
			return ws
		}
	}
	return nil
}

// workspaceOf finds a local workspace by path.
func (a *app) workspaceOf(path string) *workspace { return a.workspaceFor(localTarget, path) }

// cleanTargetPath normalises a workspace path for its target: cleaned for
// this machine, kept as typed elsewhere.
func cleanTargetPath(t target, path string) string {
	path = strings.TrimSpace(path)
	if t.remote() {
		return strings.TrimRight(path, "/")
	}
	if path == "" {
		return ""
	}
	return filepath.Clean(path)
}

// allSessions lists sessions in sidebar order.
func (a *app) allSessions() []*session {
	var out []*session
	for _, ws := range a.workspaces.Get() {
		out = append(out, ws.Sessions.Get()...)
	}
	return out
}

// tick keeps a clock for elapsed labels, and rereads an open Git panel
// every few seconds.
func (a *app) tick() {
	beats := 0
	var loop func()
	loop = func() {
		beats++
		now := a.cx.Now()
		a.clock.Set(now)
		if beats%4 == 0 && a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
			a.git.poll()
		}
		if now.Sub(a.lastTray) >= trayIdle {
			a.lastTray = now
			a.updateTray()
		}
		a.cx.AfterFunc(time.Second, loop)
	}
	a.cx.Post(loop)
}

// animateNextLayout eases the next batch's moves, inserts and deletes,
// unless the user asked for less motion.
func (a *app) animateNextLayout() {
	if ui.ReduceMotion(a.cx) {
		return
	}
	a.cx.AnimateLayout(core.LayoutEaseInEaseOutPreset)
}

// toast shows one briefly.
func (a *app) toast(kind ui.ToastType, title, detail string) {
	switch kind {
	case ui.ToastError:
		a.diagf("error", "%s：%s", title, detail)
	case ui.ToastWarning:
		a.diagf("warn", "%s：%s", title, detail)
	}
	a.toaster.Show(ui.ToastContent{Type: kind, Title: title, Description: detail, Duration: 4 * time.Second})
}

// toastAction shows one with a button.
func (a *app) toastAction(kind ui.ToastType, title, detail, action string, fn func()) {
	a.toaster.Show(ui.ToastContent{Type: kind, Title: title, Description: detail, Action: action, OnAction: fn, Duration: 6 * time.Second})
}

// cycleTheme moves system → light → dark → system.
func (a *app) cycleTheme() {
	next := map[string]string{"": "light", "system": "light", "light": "dark", "dark": "system"}[a.theme.GetUntracked()]
	a.theme.Set(next)
	a.applyTheme()
	a.st.edit(func(c *config) { c.Theme = next })
	a.toast(ui.ToastInfo, "外观", map[string]string{"light": "浅色", "dark": "深色", "system": "跟随系统"}[next])
}

// remember writes what reopens next time.
func (a *app) remember() {
	if a.st == nil {
		return
	}
	tabs := a.tabs.GetUntracked()
	last := a.activeID.GetUntracked()
	open := a.sidebar.GetUntracked()
	drawer := a.drawer.GetUntracked()
	theme := a.theme.GetUntracked()
	model, thinking := a.defaultModel, a.defaultThinking
	termOpen := a.term.open.GetUntracked()
	termHeight := a.term.height.GetUntracked()
	a.st.edit(func(c *config) {
		c.Tabs = append([]string(nil), tabs...)
		c.LastSession = last
		c.SidebarOpen = open
		c.DrawerOpen = drawer
		c.Theme = theme
		c.Model = model
		c.Thinking = thinking
		c.TerminalOpen = termOpen
		c.TerminalHeight = termHeight
	})
}

// selectSession brings a session to the front, opening its tab.
func (a *app) selectSession(s *session) {
	if s == nil {
		return
	}
	if a.editor != nil {
		a.editor.open.Set(false)
	}
	a.activeID.Set(s.ID)
	a.activeWS.Set(s.WS)
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil && !ws.Expanded.GetUntracked() {
		ws.Expanded.Set(true)
	}
	a.addTab(s.ID)
	a.openSessionEager(s)
	if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
		a.git.attach(a.workspaceFor(s.Target, s.WS))
	}
	a.remember()
	a.emit(eventSessionOpened, appEvent{Session: s})
}

// openWorkspaceKey opens the project a palette row names: it expands the
// folder and shows its newest session.
func (a *app) openWorkspaceKey(key string) {
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Target.key()+"|"+ws.Path != key {
			continue
		}
		ws.Expanded.Set(true)
		a.activeWS.Set(ws.Path)
		if list := ws.Sessions.GetUntracked(); len(list) > 0 {
			a.selectSession(list[0])
		}
		return
	}
}

// addTab appends a tab once.
func (a *app) addTab(id string) {
	found := false
	for _, t := range a.tabs.GetUntracked() {
		if t == id {
			found = true
			break
		}
	}
	if !found {
		a.tabs.Update(func(ts []string) []string { return append(ts, id) })
	}
}

// closeTab closes a tab, keeping the session and its engine running.
func (a *app) closeTab(id string) {
	tabs := a.tabs.GetUntracked()
	ix := -1
	for i, t := range tabs {
		if t == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	next := append(append([]string(nil), tabs[:ix]...), tabs[ix+1:]...)
	a.tabs.Set(next)
	if a.byID[id] != nil {
		a.closedTabs = append(a.closedTabs, id)
		if len(a.closedTabs) > 10 {
			a.closedTabs = a.closedTabs[len(a.closedTabs)-10:]
		}
	}
	if a.activeID.GetUntracked() == id {
		if len(next) > 0 {
			n := next[min(ix, len(next)-1)]
			if s := a.byID[n]; s != nil {
				a.selectSession(s)
			}
		} else {
			a.activeID.Set("")
			a.activeWS.Set("")
		}
	}
	a.remember()
}

// reopenTab brings back the last closed session's tab.
func (a *app) reopenTab() {
	for len(a.closedTabs) > 0 {
		id := a.closedTabs[len(a.closedTabs)-1]
		a.closedTabs = a.closedTabs[:len(a.closedTabs)-1]
		s := a.byID[id]
		if s == nil {
			continue
		}
		for _, t := range a.tabs.GetUntracked() {
			if t == id {
				a.selectSession(s)
				return
			}
		}
		a.addTab(id)
		a.selectSession(s)
		return
	}
	a.toast(ui.ToastInfo, "没有可恢复的标签", "关掉的会话标签会记在这里。")
}

// closeOtherTabs closes every tab but one.
func (a *app) closeOtherTabs(id string) {
	for _, t := range append([]string(nil), a.tabs.GetUntracked()...) {
		if t != id {
			a.closeTab(t)
		}
	}
}

// closeTabsRight closes the tabs after one.
func (a *app) closeTabsRight(id string) {
	tabs := append([]string(nil), a.tabs.GetUntracked()...)
	ix := -1
	for i, t := range tabs {
		if t == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	for _, t := range tabs[ix+1:] {
		a.closeTab(t)
	}
}

// closeAllTabs closes every open tab.
func (a *app) closeAllTabs() {
	for _, t := range append([]string(nil), a.tabs.GetUntracked()...) {
		a.closeTab(t)
	}
}

// cycleTab moves between tabs like a browser.
func (a *app) cycleTab(delta int) {
	tabs := a.tabs.GetUntracked()
	if len(tabs) < 2 {
		return
	}
	ix := 0
	for i, id := range tabs {
		if id == a.activeID.GetUntracked() {
			ix = i
		}
	}
	ix = (ix + delta + len(tabs)) % len(tabs)
	if s := a.byID[tabs[ix]]; s != nil {
		a.selectSession(s)
	}
}

// blankSession builds a session's signals and registers it.
func (a *app) blankSession(id string, ws *workspace, title string) *session {
	s := &session{
		ID:             id,
		WS:             ws.Path,
		Target:         ws.Target,
		title:          core.NewSignal(a.cx, title),
		status:         core.NewSignal(a.cx, statusIdle),
		turns:          core.NewSignalFunc(a.cx, []turn{}, nil),
		draft:          core.NewSignal(a.cx, ""),
		images:         core.NewSignalFunc(a.cx, []promptImage(nil), nil),
		model:          core.NewSignal(a.cx, modelInfo{}),
		models:         core.NewSignalFunc(a.cx, []modelInfo(nil), nil),
		modelsBusy:     core.NewSignal(a.cx, false),
		thinking:       core.NewSignal(a.cx, ""),
		levels:         core.NewSignalFunc(a.cx, []string(nil), nil),
		usage:          core.NewSignal(a.cx, usageInfo{}),
		stats:          core.NewSignal(a.cx, sessionStats{}),
		updated:        core.NewSignal(a.cx, a.cx.Now()),
		loaded:         core.NewSignal(a.cx, false),
		notice:         core.NewSignal(a.cx, ""),
		queued:         core.NewSignal(a.cx, 0),
		ask:            core.NewSignalFunc(a.cx, (*extensionAsk)(nil), nil),
		window:         core.NewSignal(a.cx, 24),
		todos:          core.NewSignalFunc(a.cx, []todoItem(nil), nil),
		todoOpen:       core.NewSignal(a.cx, false),
		runningSig:     core.NewSignal(a.cx, false),
		planMode:       core.NewSignal(a.cx, false),
		readySig:       core.NewSignal(a.cx, false),
		modelOpen:      core.NewSignal(a.cx, false),
		modelQuery:     core.NewSignal(a.cx, ""),
		thinkingOpen:   core.NewSignal(a.cx, false),
		usageOpen:      core.NewSignal(a.cx, false),
		projectOpen:    core.NewSignal(a.cx, false),
		streamText:     core.NewSignal(a.cx, ""),
		streamThinking: core.NewSignal(a.cx, ""),
		liveTools:      core.NewSignalFunc(a.cx, []toolRun(nil), nil),
		extStatus:      map[string]string{},
		openTools:      map[string]bool{},
		uiSeq:          core.NewSignal(a.cx, 0),
		acpCommands:    core.NewSignalFunc(a.cx, []acpCommand(nil), nil),
		acpCmdOpen:     core.NewSignal(a.cx, false),
		acpMode:        core.NewSignal(a.cx, ""),
		acpModes:       core.NewSignalFunc(a.cx, []acpMode(nil), nil),
		acpModeOpen:    core.NewSignal(a.cx, false),
	}
	s.conversation = chat.NewConversationState(a.cx)
	a.byID[s.ID] = s
	a.all = append(a.all, s)
	return s
}

// newSession starts an empty conversation in the active workspace, or in
// the one at path.
func (a *app) newSession(path string) *session {
	ws := a.activeWorkspace()
	if path != "" {
		for _, w := range a.workspaces.Get() {
			if w.Path == path {
				ws = w
				break
			}
		}
	}
	if ws == nil {
		// No project yet: the folder picker is the next step, not an error.
		a.toast(ui.ToastInfo, "先选一个项目", "选好文件夹就开始第一次对话。")
		a.pickNative("workspace")
		return nil
	}
	title := "新会话"
	if ws.Chat {
		title = T("对话")
	}
	s := a.blankSession(newSessionID(), ws, title)
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	origin := "project"
	if ws.Chat {
		origin = "chat"
	}
	a.sessionCreated(s, origin)
	return s
}

// openPicker shows the app's own folder browser for a workspace or a
// session file.
func (a *app) openPicker(mode string) {
	a.pick.show(mode)
}

// pickNative shows the system's own picker: a folder for a workspace, or a
// session file to import. It is the quick path; the app's browser stays for
// typing a path or seeing what a folder holds.
func (a *app) pickNative(mode string) {
	switch mode {
	case "image":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择图片失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.visionPath.Set(files[0].Path)
			}
		})
	case "image-ref":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择图片失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.imageRef.Set(files[0].Path)
			}
		})
	case "import":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".jsonl"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择文件失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.importSession(files[0].Path)
			}
		})
	default:
		a.cx.PickDirectories(core.PickDirectoriesOptions{}, func(dirs []core.Directory, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择文件夹失败", err.Error())
			case len(dirs) == 0:
				// Cancelled.
			case dirs[0].Path == "":
				a.toast(ui.ToastWarning, "这个文件夹没有路径", "换一个本机的文件夹试试。")
			default:
				a.addWorkspace(dirs[0].Path)
			}
		})
	}
}

// pickerChosen handles the browser's choice.
func (a *app) pickerChosen(path string) {
	mode := a.pick.mode.GetUntracked()
	a.pick.open.Set(false)
	switch mode {
	case "workspace":
		a.addWorkspace(path)
	case "import":
		a.importSession(path)
	}
}

// addWorkspace adds a folder on this machine to the rail.
func (a *app) addWorkspace(path string) { a.addWorkspaceFor(localTarget, path, "") }

// addWorkspaceFor adds a folder on a target to the rail.
func (a *app) addWorkspaceFor(t target, path, name string) {
	path = cleanTargetPath(t, path)
	if path == "" {
		return
	}
	if ws := a.workspaceFor(t, path); ws != nil {
		ws.Expanded.Set(true)
		a.activeWS.Set(path)
		if !t.remote() {
			a.files.watch(path)
		}
		if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
			a.git.attach(ws)
		}
		return
	}
	ws := &workspace{Path: path, Name: name, Target: t, Added: a.cx.Now(), Expanded: core.NewSignal(a.cx, true),
		Sessions:  core.NewSignalFunc(a.cx, []*session{}, nil),
		Pi:        core.NewSignalFunc(a.cx, []*session(nil), nil),
		PiOpen:    core.NewSignal(a.cx, true),
		PiLoading: core.NewSignal(a.cx, false),
		Visible:   core.NewSignal(a.cx, 0)}
	a.workspaces.Update(func(list []*workspace) []*workspace { return append(list, ws) })
	a.activeWS.Set(path)
	if !t.remote() {
		a.files.watch(path)
	}
	a.st.edit(func(c *config) {
		for _, w := range c.Workspaces {
			if w.Path == path && w.Target == t.key() {
				return
			}
		}
		c.Workspaces = append(c.Workspaces, workspaceCfg{Path: path, Name: name, Target: t.key(), Expanded: true, Added: ws.Added})
	})
	if !t.remote() {
		a.files.watch(path)
	}
	if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
		a.git.attach(ws)
	}
	a.toast(ui.ToastSuccess, "已添加工作区", t.label()+" · "+path)
	a.rescanPi()
	// A remote target gets a session at once: there are no stored sessions
	// to show, and an empty project is a dead end.
	if t.remote() {
		a.newSession(path)
	}
}

// addRemoteWorkspace adds the folder the remote dialog names.
func (a *app) addRemoteWorkspace() {
	kind := targetKind(a.addKind.GetUntracked())
	where := strings.TrimSpace(a.addWhere.GetUntracked())
	path := strings.TrimSpace(a.addPath.GetUntracked())
	if where == "" || path == "" {
		a.toast(ui.ToastWarning, "还差一点", "选一个目标，再填它的目录。")
		return
	}
	t := target{Kind: targetWSL, Distro: where}
	if kind == targetSSH {
		t = target{Kind: targetSSH, Host: where}
	}
	a.addTarget.Set(false)
	a.addWorkspaceFor(t, path, "")
}

// removeWorkspace takes a folder out of the rail; its sessions stay on disk.
func (a *app) removeWorkspace(ws *workspace) {
	if ws == nil {
		return
	}
	a.askConfirm("移除工作区", fmt.Sprintf("从侧栏移除「%s」？会话文件仍保留在磁盘上。", ws.label()), "移除", func() {
		a.removeWorkspaceNow(ws)
	})
}

// removeWorkspaceNow takes a folder off the rail, without asking: the
// phone's removal comes in already confirmed.
func (a *app) removeWorkspaceNow(ws *workspace) {
	if ws == nil {
		return
	}
	{
		for _, s := range ws.Sessions.GetUntracked() {
			a.closeTab(s.ID)
			delete(a.byID, s.ID)
			for i, x := range a.all {
				if x == s {
					a.all = append(a.all[:i], a.all[i+1:]...)
					break
				}
			}
			if s.engine != nil {
				s.engine.stop()
				s.engine = nil
			}
		}
		a.workspaces.Update(func(list []*workspace) []*workspace {
			out := list[:0]
			for _, w := range list {
				if w.Path != ws.Path {
					out = append(out, w)
				}
			}
			return out
		})
		a.st.edit(func(c *config) {
			out := c.Workspaces[:0]
			for _, w := range c.Workspaces {
				if w.Path != ws.Path {
					out = append(out, w)
				}
			}
			c.Workspaces = out
		})
		if a.activeWS.GetUntracked() == ws.Path {
			a.activeWS.Set("")
			a.activeID.Set("")
		}
		if a.gitPath() == ws.Path {
			a.git.attach(nil)
		}
		a.remember()
	}
}

// importSession copies a session file into the app's store and opens it.
func (a *app) importSession(path string) {
	if a.st == nil {
		return
	}
	meta, err := a.st.importAnySession(path)
	if err != nil {
		a.toast(ui.ToastError, "导入失败", err.Error())
		return
	}
	ws := a.workspaceOf(meta.Cwd)
	if ws == nil {
		a.addWorkspace(meta.Cwd)
		ws = a.workspaceOf(meta.Cwd)
	}
	if ws == nil {
		a.toast(ui.ToastError, "导入失败", "会话的工作目录不可用")
		return
	}
	s := a.makeSession(meta, localTarget)
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	a.toast(ui.ToastSuccess, "已导入会话", meta.Title)
}

// deleteSession moves a session out of the store.
// duplicateSession copies a session's file under a new id and opens the
// copy, so an experiment does not touch the original's history.
func (a *app) duplicateSession(s *session) {
	if s == nil || a.st == nil {
		return
	}
	if s.File == "" {
		a.toast(ui.ToastInfo, "这个会话还没有文件", "发一条消息后就能复制。")
		return
	}
	id := newSessionID()
	title := s.title.GetUntracked() + " 副本"
	src, st := s.File, a.st
	go func() {
		meta, err := st.duplicateSession(src, id, title)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "复制会话失败", err.Error())
				return
			}
			ns := a.makeSession(meta, s.Target)
			if ws := a.workspaceOf(meta.Cwd); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
			}
			a.selectSession(ns)
			a.toast(ui.ToastSuccess, "已复制会话", title)
		})
	}()
}

// forkSession copies a session up to one turn into a new session and
// puts that turn's prompt back in the composer: the way to try another
// answer without losing the original history.
func (a *app) forkSession(s *session, turnID string) {
	if s == nil || a.st == nil {
		return
	}
	if s.Target.remote() {
		a.toast(ui.ToastInfo, "远程会话暂不支持分叉", "现在只分叉本机会话。")
		return
	}
	if s.File == "" {
		a.toast(ui.ToastInfo, "这个会话还没有文件", "发一条消息后再分叉。")
		return
	}
	turns := s.turns.GetUntracked()
	idx := -1
	for i, t := range turns {
		if t.ID == turnID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	id := newSessionID()
	title := s.title.GetUntracked() + " 分叉"
	src, st := s.File, a.st
	go func() {
		meta, prompt, err := st.forkSession(src, id, idx, title)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "分叉会话失败", err.Error())
				return
			}
			ns := a.makeSession(meta, s.Target)
			if ws := a.workspaceOf(meta.Cwd); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
			}
			a.selectSession(ns)
			if prompt == "" {
				prompt = turns[idx].Prompt
			}
			ns.draft.Set(prompt)
			st.edit(func(c *config) {
				if c.ForkParents == nil {
					c.ForkParents = map[string]string{}
				}
				c.ForkParents[ns.ID] = s.ID
			})
			a.cfg = st.config()
			a.sessionCreated(ns, "fork")
			a.toast(ui.ToastSuccess, "已分叉会话", "原提问已放回输入框，改完可以直接发。")
		})
	}()
}

// lastAnswer is the newest final text in a session.
func lastAnswer(s *session) string {
	if s == nil {
		return ""
	}
	ts := s.turns.GetUntracked()
	for i := len(ts) - 1; i >= 0; i-- {
		if ts[i].Final != "" {
			return ts[i].Final
		}
	}
	return ""
}

// togglePlanMode flips the next turn between planning and doing.
func (a *app) togglePlanMode(s *session) {
	if s == nil {
		return
	}
	on := !s.planMode.GetUntracked()
	s.planMode.Set(on)
	if on {
		a.toast(ui.ToastInfo, "计划模式已开启", "下一轮会先给计划，确认后再执行。")
	}
}

// executePlan asks pi to carry out the plan it just gave.
func (a *app) executePlan(s *session, t turn) {
	if s == nil || t.running() {
		return
	}
	a.submitTurn(s, T("按上面的计划执行。每完成一步，用一句话说明改了什么、怎么验证的。"), nil, false)
}

// editPlan puts a plan back in the composer for changes.
func (a *app) editPlan(s *session, t turn) {
	if s == nil {
		return
	}
	text := t.Final
	if text == "" {
		return
	}
	s.planMode.Set(false)
	s.draft.Set(text)
	a.toast(ui.ToastInfo, "计划已放回输入框", "改完可以直接发。")
}

// forkLastTurn forks at the newest user prompt.
func (a *app) forkLastTurn() {
	s := a.active()
	if s == nil {
		return
	}
	turns := s.turns.GetUntracked()
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Prompt != "" {
			a.forkSession(s, turns[i].ID)
			return
		}
	}
	a.toast(ui.ToastInfo, "没有可分叉的提问", "")
}

func (a *app) deleteSession(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.askConfirm("删除会话", "「"+s.title.GetUntracked()+"」会从侧栏消失，ACP 归档也会删除。", "删除", func() {
			a.deleteACPArchive(s.ID)
			a.forgetFork(s.ID)
			a.closeTab(s.ID)
			delete(a.byID, s.ID)
			for i, x := range a.all {
				if x == s {
					a.all = append(a.all[:i], a.all[i+1:]...)
					break
				}
			}
			if ws := a.workspaceOf(s.WS); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session {
					out := ss[:0]
					for _, x := range ss {
						if x != s {
							out = append(out, x)
						}
					}
					return out
				})
			}
			a.remember()
			a.emit(eventSessionDeleted, appEvent{Session: s, Data: map[string]string{"backend": s.backend}})
		})
		return
	}
	if s.External {
		a.toast(ui.ToastInfo, "这是 pi 自己的会话", "它的文件在 pi 的目录里，应用不删它；可以在文件管理器里处理。")
		a.revealSession(s)
		return
	}
	body := fmt.Sprintf("「%s」会从侧栏消失，文件移到数据目录的 trash 里，需要时可以手动找回。", s.title.GetUntracked())
	a.askConfirm("删除会话", body, "删除", func() { a.removeSession(s) })
}

// forgetFork drops a deleted session's fork links, its own and its
// children's.
func (a *app) forgetFork(id string) {
	if a.st == nil || id == "" {
		return
	}
	a.st.edit(func(c *config) {
		delete(c.ForkParents, id)
		for child, parent := range c.ForkParents {
			if parent == id {
				delete(c.ForkParents, child)
			}
		}
	})
	a.cfg = a.st.config()
}

// removeSession deletes a session's file and every trace of it, without
// asking: the phone's delete comes in already confirmed.
func (a *app) removeSession(s *session) {
	if s == nil || s.External {
		return
	}
	// The process holds the session file on Windows: close it, and let
	// it go before moving the file.
	if s.engine != nil {
		s.engine.stop()
		s.engine = nil
	}
	if a.st != nil {
		if err := a.st.deleteSession(s.File, s.ID); err != nil {
			a.toast(ui.ToastError, "删除失败", err.Error())
			return
		}
		a.st.edit(func(c *config) {
			delete(c.Titles, s.ID)
			delete(c.ForkParents, s.ID)
			for child, parent := range c.ForkParents {
				if parent == s.ID {
					delete(c.ForkParents, child)
				}
			}
		})
		a.cfg = a.st.config()
	}
	a.closeTab(s.ID)
	delete(a.byID, s.ID)
	for i, x := range a.all {
		if x == s {
			a.all = append(a.all[:i], a.all[i+1:]...)
			break
		}
	}
	if ws := a.workspaceOf(s.WS); ws != nil {
		ws.Sessions.Update(func(ss []*session) []*session {
			out := ss[:0]
			for _, x := range ss {
				if x != s {
					out = append(out, x)
				}
			}
			return out
		})
	}
	a.toast(ui.ToastSuccess, "已删除会话", "文件在数据目录的 trash 下")
	a.remember()
	a.emit(eventSessionDeleted, appEvent{Session: s, Data: map[string]string{"backend": s.backend}})
}

// askRename opens the rename dialog for a session.
func (a *app) askRename(s *session) {
	if s == nil {
		return
	}
	a.renameID = s.ID
	a.renameText.Set(s.title.GetUntracked())
	a.renameOpen.Set(true)
}

// rename applies the dialog's name.
func (a *app) rename() {
	s := a.byID[a.renameID]
	name := strings.TrimSpace(a.renameText.GetUntracked())
	if s == nil || name == "" {
		a.renameOpen.Set(false)
		return
	}
	s.title.Set(name)
	if a.st != nil {
		a.st.edit(func(c *config) { c.Titles[s.ID] = name })
	}
	if s.engine != nil {
		go func(c *piClient, name string) {
			_ = c.call(map[string]any{"type": "set_session_name", "name": name}, nil, 10*time.Second)
		}(s.engine, name)
	}
	a.renameOpen.Set(false)
}

// askConfirm opens a confirmation with an action.
func (a *app) askConfirm(title, body, action string, fn func()) {
	a.confirmHead.Set(title)
	a.confirmBody.Set(body)
	a.confirmWhy.Set(action)
	a.confirmFn = fn
	a.confirmOpen.Set(true)
}

// confirm runs the pending action.
func (a *app) confirm() {
	a.confirmOpen.Set(false)
	if a.confirmFn != nil {
		fn := a.confirmFn
		a.confirmFn = nil
		fn()
	}
}

// ensureEngine starts pi for a session once, running then on the UI thread.
func (a *app) ensureEngine(s *session, then func()) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			if then != nil {
				then()
			}
			return
		}
		if then != nil {
			s.waiters = append(s.waiters, then)
		}
		a.ensureACPSession(s)
		return
	}
	if s.engine != nil {
		if then != nil {
			then()
		}
		return
	}
	if then != nil {
		s.waiters = append(s.waiters, then)
	}
	if s.starting {
		return
	}
	if info := a.env.GetUntracked(); info.Probed && info.PiError != "" && !s.Target.remote() {
		a.failSession(s, "找不到 pi 命令："+info.PiError)
		return
	}
	s.starting = true
	s.status.Set(statusStarting)
	go a.startEngine(s)
}

// restartAgent stops a session's pi and starts it again: the way to pick
// up a changed model list or a stuck process without losing the tab.
func (a *app) restartAgent(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			s.acp.stop()
			s.acp = nil
			s.acpSID = ""
		}
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		a.ensureACPSession(s)
		return
	}
	if s.engine == nil {
		a.ensureEngine(s, nil)
		return
	}
	s.restarting = true
	s.engine.stop()
}

// closeAgent stops a session's pi and keeps the transcript and tab; the
// next message starts it again.
func (a *app) closeAgent(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			s.acp.stop()
			s.acp = nil
			s.acpSID = ""
		}
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		return
	}
	if s.engine == nil {
		return
	}
	s.engine.stop()
}

// startEngine spawns pi and reads its state, off the UI thread.
func (a *app) startEngine(s *session) {
	sessionFile := ""
	if s.External {
		sessionFile = s.File
	}
	c, err := startPi(s.Target, a.piPath(), s.WS, a.st.sessions, s.ID, sessionFile,
		func(ev piEvent) { a.onPiEvent(s, ev) },
		func(req uiRequest) { a.onPiUI(s, req) },
		func(err error) { a.onPiExit(s, err) })
	if err != nil {
		a.cx.Post(func() { a.failSession(s, err.Error()) })
		return
	}
	var state struct {
		Model         *modelInfo `json:"model"`
		ThinkingLevel string     `json:"thinkingLevel"`
		SessionFile   string     `json:"sessionFile"`
		SessionName   string     `json:"sessionName"`
		MessageCount  int        `json:"messageCount"`
		IsStreaming   bool       `json:"isStreaming"`
	}
	if err := c.call(map[string]any{"type": "get_state"}, &state, 40*time.Second); err != nil {
		c.stop()
		a.cx.Post(func() { a.failSession(s, "无法读取会话状态："+err.Error()) })
		return
	}
	a.cx.Post(func() {
		a.engineReady(s, c, state.Model, state.ThinkingLevel, state.SessionFile, state.MessageCount, state.IsStreaming)
	})
	if state.MessageCount == 0 {
		a.cx.Post(func() { a.historyReady(s) })
	} else {
		// A session file already on screen is not fetched again: pi counts
		// the same messages, so the tab is showing what get_messages would
		// send. A mismatch (a compacted session, a file lagging behind a
		// running turn) falls back to pi's copy.
		a.cx.Post(func() {
			if s.histFile == state.MessageCount {
				a.historyReady(s)
				return
			}
			go a.fetchHistory(s, c)
		})
	}
	var models struct {
		Models []modelInfo `json:"models"`
	}
	if err := c.call(map[string]any{"type": "get_available_models"}, &models, 40*time.Second); err == nil {
		a.cx.Post(func() { s.models.Set(models.Models) })
	}
	var levels struct {
		Levels []string `json:"levels"`
	}
	if err := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 40*time.Second); err == nil {
		a.cx.Post(func() { s.levels.Set(levels.Levels) })
	}
}

// engineReady records the process and applies defaults once the history is in.
func (a *app) engineReady(s *session, c *piClient, model *modelInfo, thinking, file string, count int, streaming bool) {
	s.engine = c
	s.starting = false
	s.readySig.Set(true)
	s.File = file
	if model != nil {
		s.model.Set(*model)
	}
	if thinking != "" {
		s.thinking.Set(thinking)
	}
	if streaming {
		s.status.Set(statusRunning)
		s.live = true
	} else {
		s.status.Set(statusIdle)
	}
	// The user's remembered model and thinking level win for a fresh session.
	if count == 0 {
		if a.defaultModel.ID != "" && (model == nil || model.ID != a.defaultModel.ID) {
			go a.applyModel(s, a.defaultModel.Provider, a.defaultModel.ID, false)
		}
		if a.defaultThinking != "" && thinking != a.defaultThinking {
			go a.applyThinking(s, a.defaultThinking, false)
		}
	}
	a.startStats(s)
}

// historyReady lets a session's queued actions run, now that its transcript
// can be seen. The messages came from the file or from get_messages.
func (a *app) historyReady(s *session) {
	if !s.loaded.GetUntracked() && a.activeID.GetUntracked() == s.ID {
		a.animateNextLayout()
	}
	s.loaded.Set(true)
	waiters := s.waiters
	s.waiters = nil
	for _, fn := range waiters {
		fn()
	}
	if a.activeID.GetUntracked() == s.ID {
		s.conversation.JumpToLatest()
	}
}

// historyFromPi replaces the transcript with pi's copy, which is what a
// compacted session (whose file holds more than its context) needs.
func (a *app) historyFromPi(s *session, msgs []piMessage) {
	if len(msgs) > 0 {
		a.fillHistory(s, msgs, true)
		s.histFile = 0 // the screen is pi's copy now, not the file's
	}
	a.historyReady(s)
}

// fetchHistory asks pi for a transcript the file could not stand in for.
func (a *app) fetchHistory(s *session, c *piClient) {
	var msgs struct {
		Messages []piMessage `json:"messages"`
	}
	if err := c.call(map[string]any{"type": "get_messages"}, &msgs, 40*time.Second); err == nil {
		a.cx.Post(func() { a.historyFromPi(s, msgs.Messages) })
		return
	}
	a.cx.Post(func() { a.historyReady(s) })
}

// fillHistory shows a session's messages, keeping anything that arrived
// while they were loading.
func (a *app) fillHistory(s *session, msgs []piMessage, replace bool) {
	history := turnsFromMessages(msgs)
	if !replace {
		// A message can arrive from the phone before the history is in; it
		// stays after what the session already had.
		if pending := s.turns.GetUntracked(); len(pending) > 0 {
			history = append(history, pending...)
		}
	}
	s.turns.Set(history)
	if items := todosFromMessages(msgs); len(items) > 0 {
		s.todos.Set(items)
	}
}

// loadHistoryFromFile paints a session's transcript from its file, so a tab
// shows its history while pi is still starting.
func (a *app) loadHistoryFromFile(s *session) {
	if s == nil || s.File == "" || s.backend == "acp" || s.Target.remote() || s.loaded.GetUntracked() {
		return
	}
	file := s.File
	go func() {
		msgs, err := sessionFileMessages(file)
		if err != nil || len(msgs) == 0 {
			return
		}
		a.cx.Post(func() {
			if s.loaded.GetUntracked() || s.File != file {
				return // pi answered first, or the tab moved on
			}
			if a.activeID.GetUntracked() == s.ID {
				a.animateNextLayout()
			}
			a.fillHistory(s, msgs, false)
			s.histFile = len(msgs)
			a.historyReady(s)
		})
	}()
}

// failSession ends a session that could not start.
func (a *app) failSession(s *session, why string) {
	s.starting = false
	s.readySig.Set(false)
	s.runningSig.Set(false)
	s.status.Set(statusFailed)
	s.notice.Set(why)
	s.waiters = nil
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Status = chat.Failed
				ts[i].Err = why
				ts[i].End = a.cx.Now()
				break
			}
		}
		return ts
	})
	a.toast(ui.ToastError, "pi 启动失败", why)
}

// onPiExit handles a process that ended; nil means it was asked to stop.
func (a *app) onPiExit(s *session, err error) {
	a.cx.Post(func() {
		if s.restarting {
			s.restarting = false
			s.engine = nil
			s.starting = false
			s.readySig.Set(false)
			s.waiters = nil
			s.status.Set(statusIdle)
			a.ensureEngine(s, nil)
			return
		}
		if s.engine == nil {
			return
		}
		s.engine = nil
		s.starting = false
		s.readySig.Set(false)
		s.waiters = nil
		if err == nil {
			s.status.Set(statusIdle)
			return
		}
		why := err.Error()
		s.status.Set(statusFailed)
		s.notice.Set("pi 进程退出了：" + why)
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if ts[i].running() {
					ts[i].Status = chat.Failed
					ts[i].Err = "pi 进程退出：" + why
					ts[i].End = a.cx.Now()
					break
				}
			}
			return ts
		})
		a.toast(ui.ToastError, "pi 进程退出", why)
	})
}

// startStats asks pi for the session's totals, when the engine is ready.
func (a *app) startStats(s *session) {
	if s != nil && s.backend == "acp" {
		return
	}
	c := s.engine
	if c == nil {
		return
	}
	var stats struct {
		UserMessages      int `json:"userMessages"`
		AssistantMessages int `json:"assistantMessages"`
		ToolCalls         int `json:"toolCalls"`
		Tokens            struct {
			Input      int `json:"input"`
			Output     int `json:"output"`
			CacheRead  int `json:"cacheRead"`
			CacheWrite int `json:"cacheWrite"`
			Total      int `json:"total"`
		} `json:"tokens"`
		Cost         float64 `json:"cost"`
		ContextUsage *struct {
			Tokens        int     `json:"tokens"`
			ContextWindow int     `json:"contextWindow"`
			Percent       float64 `json:"percent"`
		} `json:"contextUsage"`
	}
	go func() {
		if err := c.call(map[string]any{"type": "get_session_stats"}, &stats, 30*time.Second); err != nil {
			return
		}
		out := sessionStats{
			UserMessages: stats.UserMessages, AssistantMessages: stats.AssistantMessages, ToolCalls: stats.ToolCalls,
			Tokens: usageInfo{Input: stats.Tokens.Input, Output: stats.Tokens.Output, CacheRead: stats.Tokens.CacheRead,
				CacheWrite: stats.Tokens.CacheWrite, Total: stats.Tokens.Total, Cost: stats.Cost},
			Known: true,
		}
		if stats.ContextUsage != nil {
			out.ContextTokens = stats.ContextUsage.Tokens
			out.ContextWindow = stats.ContextUsage.ContextWindow
			out.ContextPercent = stats.ContextUsage.Percent
		}
		a.cx.Post(func() { s.stats.Set(out) })
	}()
}

// send submits the draft: a prompt when idle, a steer when busy.
func (a *app) send() {
	s := a.active()
	if s == nil {
		return
	}
	text := strings.TrimSpace(s.draft.GetUntracked())
	images := s.images.GetUntracked()
	if text == "" && len(images) == 0 {
		return
	}
	if ws := a.workspaceOf(s.WS); ws != nil && !a.projectTrusted(ws) {
		a.askTrust(ws, func() {
			s.draft.Set(text)
			s.images.Set(images)
			a.send()
		})
		return
	}
	if s.busyNow() && s.engine != nil {
		s.draft.Set("")
		s.images.Set(nil)
		a.steer(s, text, images)
		return
	}
	s.draft.Set("")
	s.images.Set(nil)
	a.submit(s, text, images)
}

// submit starts a turn and asks pi to answer it, as plan mode says.
func (a *app) submit(s *session, text string, images []promptImage) {
	a.submitTurn(s, text, images, s.planMode.GetUntracked())
}

// planPrompt wraps a request so pi plans before it edits.
func planPrompt(text string) string {
	return T("请先不要改任何文件。先给出一个可执行的计划：") + "\n" +
		T("1. 分步骤说明要改什么、改哪些文件；") + "\n" +
		T("2. 每步的验证方式；") + "\n" +
		T("3. 可能的风险与回滚。") + "\n" +
		T("等我确认后再执行。") + "\n" + "\n" + text
}

// submitTurn starts a turn, asking for a plan when plan is true.
func (a *app) submitTurn(s *session, text string, images []promptImage, plan bool) {
	if ws := a.workspaceOf(s.WS); ws != nil && !a.projectTrusted(ws) {
		a.askTrust(ws, func() { a.submitTurn(s, text, images, plan) })
		return
	}
	original := text
	if p := a.agentByID(s.personaID); p != nil {
		text = personaPrompt(p.Prompt, text)
	}
	if plan {
		text = planPrompt(text)
	}
	a.cx.Batch(func() {
		if s.title.GetUntracked() == "新会话" || s.title.GetUntracked() == "" || s.title.GetUntracked() == "未命名会话" {
			name := firstLine(text, 28)
			if name == "" {
				name = "图片消息"
			}
			s.title.Set(name)
			if a.st != nil {
				a.st.edit(func(c *config) { c.Titles[s.ID] = name })
			}
		}
		turnID := fmt.Sprintf("t%d", a.cx.Now().UnixNano())
		s.turns.Update(func(ts []turn) []turn {
			return append(ts, turn{ID: turnID, Prompt: original, Images: images, Status: chat.Running, Start: a.cx.Now(), Plan: plan})
		})
		s.status.Set(statusStarting)
		s.runningSig.Set(true)
		s.notice.Set("")
		s.conversation.JumpToLatest()
		a.touch(s)
		if s.backend == "acp" {
			a.ensureEngine(s, func() { a.acpPrompt(s, turnID, text) })
		} else {
			a.ensureEngine(s, func() { a.prompt(s, turnID, text, images) })
		}
	})
	a.emit(eventTurnStart, appEvent{Session: s, Data: map[string]string{
		"plan": fmt.Sprintf("%t", plan), "backend": s.backend, "prompt": firstLine(original, 200),
	}})
}

// steer sends a message into the running turn, waiting for pi if it is
// still starting.
func (a *app) steer(s *session, text string, images []promptImage) {
	if s.engine == nil {
		a.ensureEngine(s, func() { a.steer(s, text, images) })
		return
	}
	a.cx.Batch(func() {
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if ts[i].running() {
					ts[i].Steps = append(ts[i].Steps, turnStep{ID: "steer-" + fmt.Sprint(len(ts[i].Steps)),
						Note: "发送引导：" + firstLine(text, 80)})
					break
				}
			}
			return ts
		})
	})
	go func(c *piClient, text string, images []promptImage) {
		cmd := map[string]any{"type": "steer", "message": text}
		if imgs := encodeImages(images); imgs != nil {
			cmd["images"] = imgs
		}
		if err := c.call(cmd, nil, 30*time.Second); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "引导发送失败", err.Error()) })
		}
	}(s.engine, text, images)
}

// prompt sends a prompt command for a turn.
func (a *app) prompt(s *session, turnID, text string, images []promptImage) {
	c := s.engine
	if c == nil {
		a.failTurn(s, turnID, "pi 没有就绪")
		return
	}
	cmd := map[string]any{"type": "prompt", "message": text}
	if imgs := encodeImages(images); imgs != nil {
		cmd["images"] = imgs
	}
	var resp struct {
		Disposition string `json:"disposition"`
	}
	go func() {
		err := c.call(cmd, &resp, 60*time.Second)
		a.cx.Post(func() {
			switch {
			case err != nil:
				a.failTurn(s, turnID, err.Error())
			case resp.Disposition == "handled":
				a.finishTurn(s, turnID, chat.Completed, "")
			default:
				s.status.Set(statusRunning)
			}
		})
	}()
}

// encodeImages is a prompt's image blocks.
func encodeImages(images []promptImage) []map[string]any {
	if len(images) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(images))
	for _, img := range images {
		mime := img.MimeType
		if mime == "" {
			mime = "image/png"
		}
		out = append(out, map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(img.Data), "mimeType": mime})
	}
	return out
}

// failTurn ends a turn with an error.
func (a *app) failTurn(s *session, turnID, why string) {
	a.cx.Batch(func() {
		s.status.Set(statusFailed)
		s.runningSig.Set(false)
		s.turns.Update(func(ts []turn) []turn {
			for i := range ts {
				if ts[i].ID == turnID {
					ts[i].Status = chat.Failed
					ts[i].Err = why
					ts[i].End = a.cx.Now()
				}
			}
			return ts
		})
	})
}

// finishTurn marks one turn done if it is still open.
func (a *app) finishTurn(s *session, turnID string, status chat.Status, errText string) {
	s.runningSig.Set(false)
	s.turns.Update(func(ts []turn) []turn {
		for i := range ts {
			if ts[i].ID == turnID && ts[i].running() {
				ts[i].Status = status
				ts[i].End = a.cx.Now()
				if errText != "" {
					ts[i].Err = errText
				}
			}
		}
		return ts
	})
	s.status.Set(statusIdle)
}

// stop aborts the run and clears anything queued behind it.
func (a *app) stop(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if !s.busyNow() {
			return
		}
		if s.acp != nil && s.acpSID != "" {
			s.acp.cancel(s.acpSID)
		}
		s.status.Set(statusWaiting)
		return
	}
	if s.engine == nil {
		return
	}
	if !s.busyNow() {
		println("DEBUG stop: not busy")
		return
	}
	c := s.engine
	go func() {
		if err := c.call(map[string]any{"type": "clear_queue"}, nil, 10*time.Second); err != nil {
			// A session with nothing queued may refuse; abort still stands.
			_ = err
		}
		if err := c.call(map[string]any{"type": "abort"}, nil, 60*time.Second); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "停止失败", err.Error()) })
		}
	}()
	s.status.Set(statusWaiting)
}

// compact asks pi to summarize the conversation.
func (a *app) compact(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.toast(ui.ToastInfo, "ACP 会话不支持压缩", "请在该 CLI 自己的界面里处理上下文。")
		return
	}
	a.ensureEngine(s, func() {
		if s.status.GetUntracked() == statusRunning {
			a.toast(ui.ToastWarning, "先等这一轮结束", "运行中不能压缩上下文。")
			return
		}
		c := s.engine
		s.status.Set(statusWaiting)
		s.notice.Set("正在压缩上下文…")
		go func() {
			var res struct {
				TokensBefore   int `json:"tokensBefore"`
				EstimatedAfter int `json:"estimatedTokensAfter"`
			}
			err := c.call(map[string]any{"type": "compact"}, &res, 180*time.Second)
			a.cx.Post(func() {
				s.notice.Set("")
				if s.status.GetUntracked() == statusWaiting {
					s.status.Set(statusIdle)
				}
				if err != nil {
					a.toast(ui.ToastError, "压缩失败", err.Error())
					return
				}
				a.toast(ui.ToastSuccess, "上下文已压缩", fmt.Sprintf("%s → %s tokens", tokens(res.TokensBefore), tokens(res.EstimatedAfter)))
				a.startStats(s)
			})
		}()
	})
}

// exportHTML writes the session to an HTML file and offers to open it.
func (a *app) exportHTML(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.exportSession(s)
		return
	}
	a.ensureEngine(s, func() {
		c := s.engine
		go func() {
			var res struct {
				Path string `json:"path"`
			}
			err := c.call(map[string]any{"type": "export_html"}, &res, 60*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "导出失败", err.Error())
					return
				}
				a.toastAction(ui.ToastSuccess, "已导出会话", res.Path, "打开", func() {
					a.cx.OpenURL(fileURL(res.Path), nil)
				})
			})
		}()
	})
}

// fileURL makes a file path an openable URL.
func fileURL(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return "file://" + p
}

// applyModel switches the session's model.
func (a *app) applyModel(s *session, provider, id string, remember bool) {
	if s == nil || id == "" {
		return
	}
	if remember {
		a.defaultModel = modelChoice{Provider: provider, ID: id}
		a.st.edit(func(c *config) { c.Model = a.defaultModel })
	}
	a.ensureEngine(s, func() {
		c := s.engine
		if c == nil {
			return
		}
		go func() {
			var m modelInfo
			err := c.call(map[string]any{"type": "set_model", "provider": provider, "modelId": id}, &m, 30*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "切换模型失败", err.Error())
					return
				}
				s.model.Set(m)
				a.startStats(s)
				a.refreshModelState(s)
			})
		}()
	})
}

// refreshModels asks pi for its model list again, after models.json or
// auth changed outside the session.
func (a *app) refreshModels(s *session) {
	if s == nil || s.backend == "acp" || s.modelsBusy.GetUntracked() {
		return
	}
	c := s.engine
	if c == nil {
		a.toast(ui.ToastInfo, "会话还没就绪", "等 Agent 启动后再刷新。")
		return
	}
	s.modelsBusy.Set(true)
	go func() {
		var models struct {
			Models []modelInfo `json:"models"`
		}
		err := c.call(map[string]any{"type": "get_available_models"}, &models, 40*time.Second)
		var levels struct {
			Levels []string `json:"levels"`
		}
		levelsErr := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 20*time.Second)
		a.cx.Post(func() {
			s.modelsBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "刷新模型失败", err.Error())
				return
			}
			s.models.Set(models.Models)
			if levelsErr == nil && len(levels.Levels) > 0 {
				s.levels.Set(levels.Levels)
			}
			a.toast(ui.ToastSuccess, "模型列表已刷新", fmt.Sprintf("共 %d 个模型。", len(models.Models)))
		})
	}()
}

// refreshModelState reads what the current model accepts again: its
// levels and its resolved name. Every model has its own levels, so the
// picker is rebuilt from this.
func (a *app) refreshModelState(s *session) {
	c := s.engine
	if c == nil {
		return
	}
	go func() {
		var levels struct {
			Levels []string `json:"levels"`
		}
		var state struct {
			Model         *modelInfo `json:"model"`
			ThinkingLevel string     `json:"thinkingLevel"`
		}
		levelsErr := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 20*time.Second)
		stateErr := c.call(map[string]any{"type": "get_state"}, &state, 20*time.Second)
		a.cx.Post(func() {
			if levelsErr == nil && len(levels.Levels) > 0 {
				s.levels.Set(levels.Levels)
			}
			if stateErr == nil {
				if state.Model != nil {
					s.model.Set(*state.Model)
				}
				if state.ThinkingLevel != "" {
					s.thinking.Set(state.ThinkingLevel)
				}
			}
		})
	}()
}

// applyThinking sets the reasoning level.
func (a *app) applyThinking(s *session, level string, remember bool) {
	if s == nil || level == "" {
		return
	}
	if remember {
		a.defaultThinking = level
		a.st.edit(func(c *config) { c.Thinking = level })
	}
	a.ensureEngine(s, func() {
		c := s.engine
		if c == nil {
			return
		}
		go func() {
			err := c.call(map[string]any{"type": "set_thinking_level", "level": level}, nil, 20*time.Second)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "切换思考等级失败", err.Error())
					return
				}
				s.thinking.Set(level)
			})
		}()
	})
}

// retry re-sends a failed turn's prompt as a new turn.
func (a *app) retry(s *session, t turn) {
	if s == nil {
		return
	}
	a.submit(s, t.Prompt, t.Images)
}

// resendTurn sends a turn's prompt again as a new turn.
func (a *app) resendTurn(s *session, t turn) {
	if s == nil || strings.TrimSpace(t.Prompt) == "" {
		return
	}
	if s.busyNow() {
		a.toast(ui.ToastInfo, "还在运行", "等这一轮结束再重发。")
		return
	}
	a.submitTurn(s, t.Prompt, append([]promptImage(nil), t.Images...), t.Plan)
}

// addImage attaches a pasted or dropped image.
func (a *app) addImage(s *session, img promptImage) {
	if s == nil {
		return
	}
	s.images.Update(func(list []promptImage) []promptImage { return append(list, img) })
}

// copyText puts text on the clipboard.
func (a *app) copyText(text, what string) {
	a.cx.SetClipboard(text)
	a.toast(ui.ToastSuccess, "已复制"+what, firstLine(text, 60))
}

// touch moves a session to the top of its folder and notes the time.
func (a *app) touch(s *session) {
	s.updated.Set(a.cx.Now())
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil {
		return
	}
	ws.Sessions.Update(func(ss []*session) []*session {
		out := []*session{s}
		for _, x := range ss {
			if x != s {
				out = append(out, x)
			}
		}
		return out
	})
}

// openSessionEager starts a session's engine when its tab opens, and paints
// its transcript from the file in the meantime.
func (a *app) openSessionEager(s *session) {
	if s == nil {
		return
	}
	if !s.Target.remote() {
		a.files.watch(s.WS)
	}
	a.loadHistoryFromFile(s)
	a.ensureEngine(s, nil)
}

// --- pi events -----------------------------------------------------------

// onPiEvent folds one stdout record; deltas coalesce, everything else posts.
func (a *app) onPiEvent(s *session, ev piEvent) {
	if ev.Type == "message_update" {
		a.onDelta(s, ev)
		return
	}
	a.cx.Post(func() { a.applyEvent(s, ev) })
}

// onDelta buffers streaming text so the UI redraws at most ~25 times a
// second, however fast the provider talks.
func (a *app) onDelta(s *session, ev piEvent) {
	e := ev.AssistantMessageEvent
	if e == nil {
		return
	}
	switch e.Type {
	case "text_delta", "thinking_delta":
		if e.Delta == "" {
			return
		}
		s.mu.Lock()
		if e.Type == "text_delta" {
			s.liveText.WriteString(e.Delta)
		} else {
			s.liveThink.WriteString(e.Delta)
		}
		due := !s.flushDue
		s.flushDue = true
		s.mu.Unlock()
		if due {
			a.cx.Post(func() { a.scheduleFlush(s) })
		}
	case "text_end", "thinking_end":
		s.mu.Lock()
		s.liveText.Reset()
		s.liveThink.Reset()
		if e.Type == "text_end" {
			s.shownText.Reset()
			s.shownText.WriteString(e.Content)
		} else {
			s.shownThink.Reset()
			s.shownThink.WriteString(e.Content)
		}
		s.mu.Unlock()
		a.cx.Post(func() { a.flushStream(s) })
	}
}

func (a *app) scheduleFlush(s *session) {
	a.cx.AfterFunc(40*time.Millisecond, func() { a.flushStream(s) })
}

// showReset clears what the stream showed; the caller holds s.mu.
func (s *session) showReset() {
	s.shownText.Reset()
	s.shownThink.Reset()
}

// flushStream publishes the buffered stream to its signals: deltas are
// appended to the shown text and the buffers taken, so a long answer stays
// linear in its size.
func (a *app) flushStream(s *session) {
	s.mu.Lock()
	s.shownText.WriteString(s.liveText.String())
	s.shownThink.WriteString(s.liveThink.String())
	s.liveText.Reset()
	s.liveThink.Reset()
	text, think := s.shownText.String(), s.shownThink.String()
	s.flushDue = false
	s.mu.Unlock()
	if text != "" || s.streamText.GetUntracked() != "" {
		s.streamText.Set(text)
	}
	if think != "" || s.streamThinking.GetUntracked() != "" {
		s.streamThinking.Set(think)
	}
}

// applyEvent hands one non-delta record to the state.
func (a *app) applyEvent(s *session, ev piEvent) {
	switch ev.Type {
	case "agent_start":
		s.status.Set(statusRunning)
		s.live = true
	case "message_start":
		var msg piMessage
		if len(ev.Message) > 0 && json.Unmarshal(ev.Message, &msg) == nil && msg.Role == "assistant" {
			s.live = true
			s.mu.Lock()
			s.liveText.Reset()
			s.liveThink.Reset()
			s.showReset()
			s.flushDue = false
			s.mu.Unlock()
			a.cx.Batch(func() {
				s.streamText.Set("")
				s.streamThinking.Set("")
				s.liveTools.Set(nil)
			})
			a.ensureTurn(s)
		}
	case "message_end":
		a.messageEnded(s, ev)
	case "tool_execution_start":
		a.toolStarted(s, ev)
	case "tool_execution_update":
		a.toolUpdated(s, ev)
	case "tool_execution_end":
		a.toolEnded(s, ev)
	case "agent_end":
		if ev.WillRetry {
			s.status.Set(statusWaiting)
		}
	case "agent_settled":
		a.settled(s, ev)
	case "auto_retry_start":
		s.status.Set(statusWaiting)
		s.notice.Set(fmt.Sprintf("连接中断，%d 秒后重试（%d/%d）", max(1, ev.DelayMs/1000), ev.Attempt, ev.MaxAttempts))
		a.setTurnNotice(s, s.notice.GetUntracked())
	case "auto_retry_end":
		if ev.ErrorMessage != "" {
			s.notice.Set("")
			a.setTurnError(s, ev.ErrorMessage)
		} else {
			s.notice.Set("")
			a.setTurnNotice(s, "")
		}
	case "compaction_start":
		s.status.Set(statusWaiting)
		s.notice.Set("正在压缩上下文…")
		a.addNote(s, "compaction", "压缩上下文", "正在压缩上下文…", chat.Waiting)
	case "compaction_end":
		if ev.ErrorMessage != "" {
			a.addNote(s, "compaction", "压缩失败", ev.ErrorMessage, chat.Failed)
			s.notice.Set("")
			s.status.Set(statusIdle)
			a.toast(ui.ToastError, "压缩失败", ev.ErrorMessage)
			return
		}
		if ev.Aborted {
			a.addNote(s, "compaction", "压缩已取消", "", chat.Cancelled)
			s.status.Set(statusIdle)
			s.notice.Set("")
			return
		}
		title := "上下文已压缩"
		body := ""
		var summary piCompaction
		if len(ev.Result) > 0 && json.Unmarshal(ev.Result, &summary) == nil {
			if summary.TokensBefore > 0 {
				title = fmt.Sprintf("上下文已压缩 · %s → %s", tokens(summary.TokensBefore), tokens(summary.EstimatedAfter))
			}
			body = summary.Summary
		}
		a.addNote(s, "compaction", title, body, chat.Completed)
		s.notice.Set("")
		if s.status.GetUntracked() == statusWaiting {
			s.status.Set(statusIdle)
		}
		a.startStats(s)
	case "queue_update":
		s.queued.Set(len(ev.Steering) + len(ev.FollowUp))
	case "session_info_changed":
		if ev.Name != "" {
			s.title.Set(ev.Name)
			if a.st != nil {
				a.st.edit(func(c *config) { c.Titles[s.ID] = ev.Name })
			}
		}
	case "thinking_level_changed":
		if ev.Level != "" {
			s.thinking.Set(ev.Level)
		}
	case "extension_error":
		a.toast(ui.ToastError, "扩展出错", ev.ErrorMessage)
	}
}

// ensureTurn makes sure a running turn exists for a run that pi started.
func (a *app) ensureTurn(s *session) {
	ts := s.turns.GetUntracked()
	if len(ts) > 0 && ts[len(ts)-1].running() {
		return
	}
	s.turns.Update(func(ts []turn) []turn {
		return append(ts, turn{ID: fmt.Sprintf("t%d", a.cx.Now().UnixNano()), Status: chat.Running, Start: a.cx.Now()})
	})
}

// messageEnded commits an assistant message once it is authoritative.
func (a *app) messageEnded(s *session, ev piEvent) {
	var msg piMessage
	if len(ev.Message) == 0 || json.Unmarshal(ev.Message, &msg) != nil {
		return
	}
	switch msg.Role {
	case "assistant":
		a.commitAssistant(s, msg)
	case "toolResult":
		run := toolRun{CallID: msg.ToolCallID, Name: msg.ToolName, Output: strings.TrimSpace(msg.text()), IsError: msg.IsError}
		a.updateTool(s, run)
	}
}

// commitAssistant turns a finished message into steps, tools and usage.
func (a *app) commitAssistant(s *session, msg piMessage) {
	blocks := msg.blocks()
	var thinking, prose strings.Builder
	var calls []piContent
	for _, b := range blocks {
		switch b.Type {
		case "thinking":
			thinking.WriteString(b.Thinking)
		case "text":
			prose.WriteString(b.Text)
		case "toolCall":
			calls = append(calls, b)
		}
	}
	s.mu.Lock()
	s.shownText.WriteString(s.liveText.String())
	s.shownThink.WriteString(s.liveThink.String())
	liveText, liveThink := s.shownText.String(), s.shownThink.String()
	s.liveText.Reset()
	s.liveThink.Reset()
	s.showReset()
	s.flushDue = false
	s.mu.Unlock()
	if thinking.Len() == 0 && strings.TrimSpace(liveThink) != "" && len(calls) > 0 {
		// Some providers stream reasoning without a thinking block.
		thinking.WriteString(liveThink)
	}
	text := prose.String()
	if text == "" && len(calls) == 0 {
		text = liveText
	}

	// Tools known so far: the message's calls, updated with results.
	tools := s.liveTools.GetUntracked()
	byID := map[string]toolRun{}
	for _, t := range tools {
		byID[t.CallID] = t
	}
	var runs []toolRun
	for _, c := range calls {
		run, ok := byID[c.ID]
		if !ok {
			action, detail := toolSummary(c.Name, c.Arguments)
			run = toolRun{CallID: c.ID, Name: c.Name, Action: action, Detail: detail, Status: chat.Running}
		}
		runs = append(runs, run)
	}

	usage := usageInfo{}
	if msg.Usage != nil {
		usage = usageInfo{Input: msg.Usage.Input, Output: msg.Usage.Output, CacheRead: msg.Usage.CacheRead,
			CacheWrite: msg.Usage.CacheWrite, Total: msg.Usage.Total, Cost: msg.Usage.Cost.Total}
	}

	s.turns.Update(func(ts []turn) []turn {
		if len(ts) == 0 {
			return ts
		}
		i := len(ts) - 1
		t := &ts[i]
		step := turnStep{ID: stepID(t, t.Msgs), Start: a.cx.Now()}
		t.Msgs++
		if strings.TrimSpace(thinking.String()) != "" {
			step.Thinking = thinking.String()
		}
		if text != "" && len(runs) > 0 {
			step.Text = text
		}
		step.Tools = runs
		if step.Text != "" || step.Thinking != "" || len(step.Tools) > 0 {
			t.Steps = append(t.Steps, step)
		}
		if len(runs) == 0 && strings.TrimSpace(text) != "" {
			t.Final = text
		}
		t.Tools += len(runs)
		t.Usage = t.Usage.add(usage)
		if msg.StopReason == "error" && msg.ErrorMsg != "" {
			t.Err = msg.ErrorMsg
			t.Status = chat.Failed
		}
		return ts
	})
	if usage.Total > 0 || usage.Cost > 0 {
		s.usage.Update(func(u usageInfo) usageInfo { return u.add(usage) })
	}
	if msg.StopReason == "error" && msg.ErrorMsg != "" {
		s.status.Set(statusFailed)
	}
	a.cx.Batch(func() {
		s.streamText.Set("")
		s.streamThinking.Set("")
		s.liveTools.Set(nil)
		s.notice.Set("")
	})
}

// updateTodos takes the task list a todo tool call carries.
func (a *app) updateTodos(s *session, toolName string, args json.RawMessage) {
	if s == nil || !isTodoTool(toolName) {
		return
	}
	if items, ok := parseTodoArgs(args); ok {
		s.todos.Set(items)
	}
}

// toolStarted records a tool the moment it runs.
func (a *app) toolStarted(s *session, ev piEvent) {
	a.updateTodos(s, ev.ToolName, ev.Args)
	action, detail := toolSummary(ev.ToolName, ev.Args)
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Action: action, Detail: detail, Status: chat.Running, Start: a.cx.Now()}
	if !a.updateTool(s, run) {
		s.liveTools.Update(func(list []toolRun) []toolRun { return append(list, run) })
	}
}

// toolUpdated publishes a tool's partial output.
func (a *app) toolUpdated(s *session, ev piEvent) {
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Output: resultText(ev.PartialResult), Status: chat.Running}
	a.updateTool(s, run)
}

// toolEnded records how a tool finished.
func (a *app) toolEnded(s *session, ev piEvent) {
	var res piToolResult
	_ = json.Unmarshal(ev.Result, &res)
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Output: resultText(&res),
		Status: chat.Completed, IsError: ev.IsError, DurationMs: ev.DurationMs}
	run.withDetails(res.Details)
	if ev.IsError {
		run.Status = chat.Failed
	}
	a.updateTool(s, run)
}

// updateTool merges a run into the live list or a committed step.
func (a *app) updateTool(s *session, run toolRun) bool {
	live := s.liveTools.GetUntracked()
	for i, t := range live {
		if t.CallID == run.CallID {
			live[i] = mergeRun(t, run)
			s.liveTools.Set(live)
			return true
		}
	}
	found := false
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0 && !found; i-- {
			for j := len(ts[i].Steps) - 1; j >= 0; j-- {
				for k := range ts[i].Steps[j].Tools {
					if ts[i].Steps[j].Tools[k].CallID == run.CallID {
						ts[i].Steps[j].Tools[k] = mergeRun(ts[i].Steps[j].Tools[k], run)
						found = true
						return ts
					}
				}
			}
		}
		return ts
	})
	return found
}

// mergeRun keeps what is known and takes what the update brings.
func mergeRun(old, next toolRun) toolRun {
	if next.Name != "" {
		old.Name = next.Name
	}
	if next.Action != "" {
		old.Action = next.Action
	}
	if next.Detail != "" {
		old.Detail = next.Detail
	}
	if next.Output != "" {
		old.Output = next.Output
	}
	if next.Diff != "" {
		old.Diff, old.Added, old.Removed = next.Diff, next.Added, next.Removed
	}
	if len(next.Nested) > 0 {
		old.Nested = next.Nested
	}
	if !next.Start.IsZero() {
		old.Start = next.Start
	}
	if next.Status != chat.Running || old.Status == chat.Running {
		old.Status = next.Status
	}
	if next.IsError {
		old.IsError = true
		old.Status = chat.Failed
	}
	if next.DurationMs > 0 {
		old.DurationMs = next.DurationMs
	}
	return old
}

// settled ends the run and tidies the session.
func (a *app) settled(s *session, ev piEvent) {
	now := a.cx.Now()
	s.mu.Lock()
	s.liveText.Reset()
	s.liveThink.Reset()
	s.showReset()
	s.flushDue = false
	s.mu.Unlock()
	a.cx.Batch(func() {
		s.runningSig.Set(false)
		s.streamText.Set("")
		s.streamThinking.Set("")
		s.liveTools.Set(nil)
		s.notice.Set("")
		s.queued.Set(0)
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if !ts[i].running() && !(ts[i].Status == chat.Failed && ts[i].End.IsZero()) {
					continue
				}
				if ts[i].Status == chat.Waiting {
					ts[i].Status = chat.Completed
				}
				if ev.Aborted {
					ts[i].Status = chat.Cancelled
				} else if ts[i].Err != "" || ts[i].Status == chat.Failed {
					ts[i].Status = chat.Failed
				} else {
					ts[i].Status = chat.Completed
				}
				ts[i].End = now
				break
			}
			return ts
		})
	})
	if !ev.Aborted && s.status.GetUntracked() != statusFailed {
		s.status.Set(statusIdle)
	} else if ev.Aborted {
		s.status.Set(statusIdle)
	}
	s.live = false
	a.touch(s)
	a.startStats(s)
	switch {
	case ev.Aborted:
		a.notifyFeishu(s, "已停止", "")
	case s.status.GetUntracked() == statusFailed:
		a.notifyFeishu(s, "失败", s.notice.GetUntracked())
	default:
		a.notifyTurnDone(s)
		a.notifyFeishu(s, "完成", lastAnswer(s))
	}
	status := "completed"
	switch {
	case ev.Aborted:
		status = "cancelled"
	case s.status.GetUntracked() == statusFailed:
		status = "failed"
	}
	a.emit(eventTurnDone, appEvent{Session: s, Data: map[string]string{
		"status": status, "answer": lastAnswer(s), "error": s.notice.GetUntracked(),
	}})
	if a.activeID.GetUntracked() == s.ID && s.conversation.AtLatest() {
		s.conversation.JumpToLatest()
	}
}

// setTurnNotice writes a live note onto the running turn.
func (a *app) setTurnNotice(s *session, note string) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Noticed = note
				break
			}
		}
		return ts
	})
}

// setTurnError records an error on the running turn.
func (a *app) setTurnError(s *session, errText string) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Err = errText
				break
			}
		}
		return ts
	})
}

// addNote adds or updates a system note in the transcript.
func (a *app) addNote(s *session, kind, title, body string, status chat.Status) {
	id := "note-" + kind
	s.turns.Update(func(ts []turn) []turn {
		for i := range ts {
			if ts[i].ID == id {
				ts[i].Status = status
				ts[i].Noticed = title
				ts[i].Steps = []turnStep{{ID: id + "-step", Note: title, Text: body}}
				if status != chat.Waiting {
					ts[i].End = a.cx.Now()
				}
				return ts
			}
		}
		t := turn{ID: id, Status: status, Start: a.cx.Now(), Noticed: title,
			Steps: []turnStep{{ID: id + "-step", Note: title, Text: body}}}
		if status != chat.Waiting {
			t.End = a.cx.Now()
		}
		return append(ts, t)
	})
}

// onPiUI handles an extension's request for attention.
func (a *app) onPiUI(s *session, req uiRequest) {
	switch req.Method {
	case "notify":
		kind := ui.ToastInfo
		if req.NotifyType == "warning" {
			kind = ui.ToastWarning
		} else if req.NotifyType == "error" {
			kind = ui.ToastError
		}
		a.cx.Post(func() { a.toast(kind, "pi 扩展", firstLine(req.Message, 120)) })
	case "setStatus":
		a.cx.Post(func() {
			if req.StatusText == nil || *req.StatusText == "" {
				delete(s.extStatus, req.StatusKey)
			} else {
				s.extStatus[req.StatusKey] = *req.StatusText
			}
			a.refreshExtStatus(s)
		})
	case "set_editor_text":
		a.cx.Post(func() { s.draft.Set(req.Text) })
	case "setTitle", "setWidget":
		// The window has its own title, and widgets have no place here.
	case "select", "confirm", "input", "editor":
		a.cx.Post(func() {
			ask := &extensionAsk{ID: req.ID, Method: req.Method, Title: req.Title, Message: req.Message,
				Options: req.Options, Default: req.Prefill, Timeout: time.Duration(req.Timeout) * time.Millisecond}
			s.ask.Set(ask)
			a.askEdit.Set(req.Prefill)
			a.askSeq.Update(func(n int) int { return n + 1 })
			if ask.Timeout > 0 {
				a.cx.AfterFunc(ask.Timeout+500*time.Millisecond, func() {
					if cur := s.ask.GetUntracked(); cur != nil && cur.ID == ask.ID {
						s.ask.Set(nil)
						a.askSeq.Update(func(n int) int { return n + 1 })
					}
				})
			}
		})
	}
}

// refreshExtStatus joins the extension statuses into the notice line.
func (a *app) refreshExtStatus(s *session) {
	if len(s.extStatus) == 0 {
		s.notice.Set("")
		return
	}
	var parts []string
	keys := make([]string, 0, len(s.extStatus))
	for k := range s.extStatus {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, s.extStatus[k])
	}
	s.notice.Set(strings.Join(parts, " · "))
}

// answerAsk replies to the extension dialog in front.
func (a *app) answerAsk(s *session, value map[string]any) {
	if s == nil {
		return
	}
	ask := s.ask.GetUntracked()
	if ask == nil {
		return
	}
	if s.acpReply != nil {
		name, _ := value["value"].(string)
		if cancelled, _ := value["cancelled"].(bool); cancelled {
			name = ""
		}
		reply := s.acpReply
		s.acpReply = nil
		s.ask.Set(nil)
		a.askSeq.Update(func(n int) int { return n + 1 })
		reply(name)
		return
	}
	if s.engine == nil {
		return
	}
	s.engine.uiResponse(ask.ID, value)
	s.ask.Set(nil)
	a.askSeq.Update(func(n int) int { return n + 1 })
}

// pendingAsk is the extension dialog any session is waiting on.
func (a *app) pendingAsk() (*session, *extensionAsk) {
	for _, s := range a.all {
		if ask := s.ask.Get(); ask != nil {
			return s, ask
		}
	}
	return nil, nil
}

// turnsFromMessages rebuilds the transcript pi reports.
func turnsFromMessages(msgs []piMessage) []turn {
	var turns []turn
	var cur *turn
	results := map[string]toolRun{}
	flush := func() {
		if cur != nil {
			turns = append(turns, *cur)
			cur = nil
		}
	}
	now := time.Now()
	for _, m := range msgs {
		switch m.Role {
		case "user":
			flush()
			cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), Prompt: m.text(), Status: chat.Completed, Start: now, End: now}
			for _, b := range m.blocks() {
				if b.Type == "image" {
					cur.Images = append(cur.Images, promptImage{Name: "图片"})
				}
			}
		case "assistant":
			if cur == nil {
				cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: now, End: now}
			}
			step := turnStep{ID: fmt.Sprintf("h%d-%d", len(turns), len(cur.Steps))}
			var prose strings.Builder
			var calls []piContent
			for _, b := range m.blocks() {
				switch b.Type {
				case "thinking":
					step.Thinking += b.Thinking
				case "text":
					prose.WriteString(b.Text)
				case "toolCall":
					calls = append(calls, b)
				}
			}
			if prose.Len() > 0 && len(calls) > 0 {
				step.Text = prose.String()
			}
			for _, c := range calls {
				action, detail := toolSummary(c.Name, c.Arguments)
				step.Tools = append(step.Tools, toolRun{CallID: c.ID, Name: c.Name, Action: action, Detail: detail, Status: chat.Completed})
				cur.Tools++
			}
			if len(calls) == 0 && prose.Len() > 0 {
				cur.Final = prose.String()
			}
			if m.Usage != nil {
				cur.Usage = cur.Usage.add(usageInfo{Input: m.Usage.Input, Output: m.Usage.Output,
					CacheRead: m.Usage.CacheRead, CacheWrite: m.Usage.CacheWrite, Total: m.Usage.Total,
					Cost: m.Usage.Cost.Total})
			}
			if m.StopReason == "error" && m.ErrorMsg != "" {
				cur.Err = m.ErrorMsg
				cur.Status = chat.Failed
			}
			if step.Text != "" || step.Thinking != "" || len(step.Tools) > 0 {
				cur.Steps = append(cur.Steps, step)
				for _, r := range step.Tools {
					if r.CallID != "" {
						// Later toolResult messages fill these in.
						_ = r
					}
				}
			}
		case "toolResult":
			run := toolRun{CallID: m.ToolCallID, Name: m.ToolName, Output: strings.TrimSpace(m.text()), IsError: m.IsError}
			if cur != nil {
				updated := false
				for i := range cur.Steps {
					for j := range cur.Steps[i].Tools {
						if cur.Steps[i].Tools[j].CallID == run.CallID {
							cur.Steps[i].Tools[j] = mergeRun(cur.Steps[i].Tools[j], run)
							updated = true
						}
					}
				}
				if !updated {
					cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-tr%d", len(turns), len(cur.Steps)),
						Tools: []toolRun{mergeRun(toolRun{CallID: run.CallID, Name: run.Name, Action: "工具", Status: chat.Completed}, run)}})
				}
			}
			results[m.ToolCallID] = run
		case "bashExecution":
			if cur == nil {
				cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: now, End: now}
			}
			run := toolRun{CallID: "bash-" + fmt.Sprint(len(cur.Steps)), Name: "bash", Action: "运行", Detail: firstLine(m.Command, 90),
				Output: strings.TrimSpace(m.Output), Status: chat.Completed, IsError: m.ExitCode != nil && *m.ExitCode != 0}
			if run.IsError {
				run.Status = chat.Failed
			}
			cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-bash%d", len(turns), len(cur.Steps)), Tools: []toolRun{run}})
			cur.Tools++
		case "compactionSummary", "branchSummary":
			if cur == nil {
				turns = append(turns, turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: now, End: now,
					Steps: []turnStep{{ID: "summary", Note: "上下文摘要", Text: m.Summary}}})
			} else {
				cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-sum", len(turns)), Note: "上下文摘要", Text: m.Summary})
			}
		case "custom":
			if cur == nil {
				turns = append(turns, turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: now, End: now,
					Steps: []turnStep{{ID: "custom", Note: m.CustomType, Text: m.text()}}})
			} else {
				cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-custom%d", len(turns), len(cur.Steps)), Note: m.CustomType, Text: m.text()})
			}
		}
	}
	flush()
	for i := range turns {
		if turns[i].Start.IsZero() {
			turns[i].Start = now
		}
	}
	return turns
}

// pasteImage reads an image from the clipboard.
func (a *app) pasteImage(s *session) {
	a.cx.ReadClipboardImage(func(img core.ClipboardImage, ok bool, err error) {
		if err != nil {
			a.toast(ui.ToastError, "读取剪贴板失败", err.Error())
			return
		}
		if !ok {
			a.toast(ui.ToastInfo, "剪贴板里没有图片", "先复制一张图片，或者把文件拖进输入框。")
			return
		}
		a.addImage(s, promptImage{Data: img.PNG, MimeType: "image/png", Name: "粘贴的图片"})
	})
}

// dropFiles attaches dropped images and mentions other files.
func (a *app) dropFiles(s *session, uris []string) {
	for _, uri := range uris {
		path := uri
		if strings.HasPrefix(uri, "file:") {
			path = strings.TrimPrefix(uri, "file://")
			path = strings.TrimPrefix(path, "file:")
			path = strings.ReplaceAll(path, "%20", " ")
			if len(path) > 2 && path[0] == '/' && path[2] == ':' {
				path = path[1:]
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			a.toast(ui.ToastError, "无法读取文件", filepath.Base(path))
			continue
		}
		if isImage(path) {
			a.addImage(s, promptImage{Data: data, MimeType: imageMime(path), Name: filepath.Base(path)})
			continue
		}
		rel := path
		if s.WS != "" {
			if r, err := filepath.Rel(s.WS, path); err == nil {
				rel = r
			}
		}
		draft := s.draft.GetUntracked()
		if strings.TrimSpace(draft) != "" && !strings.HasSuffix(draft, " ") {
			draft += " "
		}
		s.draft.Set(draft + "@" + filepath.ToSlash(rel) + " ")
	}
}

// isImage reports whether a path names an image pi can take.
func isImage(path string) bool {
	return imageMime(path) != ""
}

// imageMime is a path's image type, empty when it is not one.
func imageMime(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return ""
}

// applyAppearance lets the settings dialog set the look. A name a theme
// carries resolves to its id, so a plugin can name a theme rather than
// know how the app keys it.
func (a *app) setTheme(name string) {
	if spec := a.themeSpecByName(name); spec != nil {
		name = spec.ID
	}
	a.theme.Set(name)
	a.applyTheme()
	a.st.edit(func(c *config) { c.Theme = name })
	a.emit(eventThemeChanged, appEvent{Data: map[string]string{"theme": name}})
}

// setTerminalFont changes the terminal's text size and keeps it.
func (a *app) setTerminalFont(size float64) {
	if size < 8 {
		size = 8
	}
	if size > 20 {
		size = 20
	}
	a.termFont.Set(size)
	a.bumpSettings()
	stored := size
	if size == 12.5 {
		stored = 0
	}
	a.cfg.TerminalFont = stored
	if a.st != nil {
		a.st.edit(func(c *config) { c.TerminalFont = stored })
	}
}

// setEditorFont changes the editor's text size and keeps it.
func (a *app) setEditorFont(size float64) {
	if size < 11 {
		size = 11
	}
	if size > 20 {
		size = 20
	}
	a.editorFont.Set(size)
	a.bumpSettings()
	stored := int(size + 0.5)
	if stored == 13 {
		stored = 0
	}
	a.cfg.EditorFont = stored
	if a.st != nil {
		a.st.edit(func(c *config) { c.EditorFont = stored })
	}
}

// cycleAppearance walks the three built-in looks: system, light, dark.
func (a *app) cycleAppearance() {
	switch a.theme.GetUntracked() {
	case "system", "":
		a.setTheme("light")
	case "light":
		a.setTheme("dark")
	default:
		a.setTheme("system")
	}
}

// openWorkspaceFolder reveals a folder in the file manager of the machine
// it is on.
func (a *app) openWorkspaceFolder(path string) {
	if path == "" {
		return
	}
	if err := revealFolder(localTarget, path); err != nil {
		a.toast(ui.ToastError, "打不开文件夹", err.Error())
	}
}

// revealProject opens a workspace's folder on its own target.
func (a *app) revealProject(ws *workspace) {
	if ws == nil {
		return
	}
	if err := revealFolder(ws.Target, ws.Path); err != nil {
		a.toast(ui.ToastError, "打不开文件夹", err.Error())
	}
}

// revealSession shows a session where it lives: its file in pi's store, or
// its project's folder for one the app owns.
func (a *app) revealSession(s *session) {
	if s == nil {
		return
	}
	if s.External && s.File != "" {
		if err := revealFile(s.Target, s.File); err != nil {
			a.toast(ui.ToastError, "打不开位置", err.Error())
		}
		return
	}
	if s.File != "" {
		if err := revealFile(s.Target, s.File); err == nil {
			return
		}
	}
	a.revealProject(a.workspaceFor(s.Target, s.WS))
}

// bindKeys is in keybindings.go: it binds each key to a router so a
// binding can change without leaving a stale handler behind.
