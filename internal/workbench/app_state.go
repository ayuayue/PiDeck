//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"context"
	"example.com/pideck-v2/internal/remotewire"
	"sync"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/sessionimport"
	"example.com/pideck-v2/internal/viewkit"
	"example.com/pideck-v2/internal/volcvoice"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// app is everything the window shows.
type app struct {
	// Capture while constructing the app: Scope.Context resolves the current
	// reactive owner and must not be sampled from a transient control later.
	lifetime context.Context
	cx       *core.Scope
	st       *store
	cfg      config
	dataDir  string
	// sounds plays the notification sounds; customSound is the imported
	// file's bytes, read when the config loads and after an import, so an
	// alert never reads the disk on the UI thread. alertVolumeSeq drops a
	// pending write while the slider still moves.
	sounds *alerts.Player
	// speech transcribes the phone's recordings; a test points it at
	// its own server.
	speech         *volcvoice.Client
	customSound    []byte
	customSoundFor string
	alertVolumeSeq int
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
	favOpen    *core.Signal[bool]
	reviewOpen *core.Signal[bool]
	// metricsOpen is the composer footer's metric menu. One composer shows
	// at a time, so its popover state lives here rather than on a session.
	metricsOpen         *core.Signal[bool]
	draftsAtStart       map[string]storedSessionDraft
	pendingTabs         []string // saved tabs waiting for their remote history scan
	pendingActive       string
	draftSeq            uint64
	browser             browserState
	memory              memoryViewState
	localToolsExtension string
	trajectory          *core.Signal[*trajectoryView]
	delegationSession   *core.Signal[*session]
	modelCatalogBusy    *core.Signal[bool]
	piUpdateBusy        *core.Signal[bool]
	providerQuery       *core.Signal[string]
	reduceEffects       *core.Signal[bool]
	codeWrap            *core.Signal[bool]
	// footerMetrics is which groups the composer footer's line shows, as
	// the config stores them; "" is the default set, "none" shows none.
	footerMetrics  *core.Signal[string]
	preview        *core.Signal[*filePreview]
	previewAudio   *previewPlayer
	notifications  *notificationHistory
	translation    *core.Signal[*translationDraft]
	promptTemplate *core.Signal[*promptTemplateForm]
	quickReplies   *replyShortcutState
	settingsSync   *core.Signal[*settingsSyncForm]
	favKind        *core.Signal[string]
	favQuery       *core.Signal[string]
	favRev         *core.Signal[int]
	favMu          sync.Mutex
	favorites      []favoriteEntry
	favWriteTail   chan []favoriteEntry // UI thread; pending durable snapshots

	// Scheduled tasks: the list, run history and the editor's fields.
	// taskMu guards the list the ticker and the UI both touch.
	taskMu          sync.Mutex
	tasks           []*scheduledTask
	taskRuns        []taskRun
	taskRunning     map[string]bool
	taskOpen        *core.Signal[bool]
	taskFormOpen    *core.Signal[bool]
	taskRev         *core.Signal[int]
	taskErr         *core.Signal[string]
	taskEditID      *core.Signal[string]
	taskName        *core.Signal[string]
	taskCron        *core.Signal[string]
	taskPrompt      *core.Signal[string]
	taskProject     *core.Signal[string]
	taskBackend     *core.Signal[string]
	taskPreset      *core.Signal[string]
	taskPersona     *core.Signal[string]
	taskEnabled     *core.Signal[bool]
	taskTimeout     *core.Signal[string]
	themes          *core.Signal[[]themeSpec]
	plugins         *core.Signal[[]plugin]
	pluginArchive   *core.Signal[pluginArchiveSnapshot]
	pluginFileBusy  *core.Signal[bool]
	providers       *core.Signal[[]providerInfo]
	providerLoadSeq uint64
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

	// Diagnostics: recent records, the asynchronous journal and launch time.
	diagMu      sync.Mutex
	diagEvents  []diagEvent
	diagJournal *diagJournal
	diagSeq     uint64
	diagPath    string
	startedAt   time.Time

	// projectsRev changes when a project is pinned, grouped or moved.
	projectsRev           *core.Signal[int]
	projectGroupOpen      *core.Signal[bool]
	projectRemoveOpen     *core.Signal[bool]
	organization          *core.Signal[sessionOrganization]
	organizationDialog    *core.Signal[sessionOrganizationDialog]
	organizationInput     *core.Signal[string]
	organizationCollapsed *core.Signal[map[string]bool]
	projectGroupPath      *core.Signal[string]
	projectGroupText      *core.Signal[string]
	wsRenameOpen          *core.Signal[bool]
	wsRenameKey           *core.Signal[string]
	wsRenameText          *core.Signal[string]

	// The ACP preset picker.
	acpOpen *core.Signal[bool]
	// The ACP preset manager: which preset is open, which tab of its
	// editor shows, and the editor's fields.
	acpManageOpen  *core.Signal[bool]
	acpPresetSel   *core.Signal[string]
	acpPresetTab   *core.Signal[string]
	acpEditID      *core.Signal[string]
	acpEditName    *core.Signal[string]
	acpEditCommand *core.Signal[string]
	acpEditArgs    *core.Signal[string]
	acpEditEnv     *core.Signal[string]
	acpEditBypass  *core.Signal[bool]
	acpManageErr   *core.Signal[string]
	acpManager     *core.Signal[acpManagerSnapshot]
	acpInstalling  *core.Signal[string]
	acpManageBusy  *core.Signal[bool]
	acpManageProbe int
	// acpManagePick picks a preset for the editor once, when the manager
	// opens; anything the user does first wins.
	acpManagePick bool
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
	searchOpen    *core.Signal[bool]
	searchText    *core.Signal[string]
	searchScope   *core.Signal[string]
	searchRev     *core.Signal[int]
	searchResults *core.Signal[*searchResult]
	searchBusy    *core.Signal[bool]
	searchDocs    []searchDoc
	searchIndexed bool
	searchTimer   func() bool
	searchCancel  context.CancelFunc
	searchEnter   bool

	// The prompt library: its packs, the dialog's query and category.
	prompts          *core.Signal[[]promptItem]
	promptOpen       *core.Signal[bool]
	promptLoading    *core.Signal[bool]
	promptQuery      *core.Signal[string]
	promptImportOpen *core.Signal[bool]
	promptImportURL  *core.Signal[string]
	promptImportBusy *core.Signal[bool]
	promptImportErr  *core.Signal[string]
	promptCat        *core.Signal[string]
	promptWindow     *core.Signal[int]

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
	providerModelImages    *core.Signal[bool]
	providerModelCostIn    *core.Signal[string]
	providerModelCostOut   *core.Signal[string]
	providerModelCostRead  *core.Signal[string]
	providerModelCostWrite *core.Signal[string]
	providerModelsRev      *core.Signal[int]
	// modelCompat is the flags the compatibility editor set for the model
	// being edited; modelCompatRev redraws it.
	modelCompat           map[string]bool
	modelCompatRev        *core.Signal[int]
	modelCompatSuggestion map[string]bool
	// The TokenDance account: its key, its balance, the catalog pull, and
	// the recharge session whose status the dialog keeps asking about.
	tdLoginOpen   *core.Signal[bool]
	tdLoginState  *core.Signal[string]
	tdLoginCancel func()
	tdKeyOpen     *core.Signal[bool]
	tdKeyText     *core.Signal[string]
	tdKeyErr      *core.Signal[string]
	tdKeyBusy     *core.Signal[bool]
	tdBusy        *core.Signal[bool]
	tdBalance     *core.Signal[string]
	tdBalanceErr  *core.Signal[string]
	tdModelBusy   *core.Signal[bool]
	tdModelMsg    *core.Signal[string]
	tdPayOpen     *core.Signal[bool]
	tdPayAmount   *core.Signal[string]
	tdPayErr      *core.Signal[string]
	tdPayBusy     *core.Signal[bool]
	tdPayStatus   *core.Signal[string]
	tdPaySession  tokenDanceSession
	tdPayKeyHint  string
	tdPayQR       []byte
	tdPayStop     chan struct{}
	tdWatchMu     sync.Mutex
	// The tip dialog: one snapshot at a time, its code, and the watch that
	// waits for the count to grow.
	supportOpen     *core.Signal[bool]
	supportBusy     *core.Signal[bool]
	supportErr      *core.Signal[string]
	supportState    *core.Signal[string]
	supportPaid     *core.Signal[bool]
	supportPolling  *core.Signal[bool]
	supportSnapshot watchaSnapshot
	supportQR       []byte
	supportBase     int
	supportPayStop  chan struct{}
	supportStopMu   sync.Mutex
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
	// chatWidthPctSig is the transcript's share of the chat area, so a slider
	// drag redraws the chat without touching the stored config;
	// chatWidthSeq drops a pending write while the drag moves.
	chatWidthPctSig *core.Signal[int]
	chatWidthSeq    int
	// tabWidthPctSig is a session tab's share of the window, read the same
	// way: the drag redraws the tab bar, the file write waits.
	tabWidthPctSig *core.Signal[int]
	tabWidthSeq    int
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
	// railTab is the rail's visible column: activity, chat or projects.
	railTab *core.Signal[string]
	// hoveredProject is the project row the pointer rests on, by key, so
	// its actions can show while it is hovered.
	hoveredProject *core.Signal[string]
	// projectMoreOpen is the project whose row menu is open, by key: its
	// trigger stays out while the menu is, so the pointer can reach it.
	projectMoreOpen *core.Signal[string]
	// addProjectOpen is the add-project menu beside the project count.
	addProjectOpen *core.Signal[bool]
	// railMoreOpen folds 更多 open and shut.
	railMoreOpen *core.Signal[bool]
	// overviewMore is the overview path whose actions menu is open, by key:
	// its trigger stays out while the menu is, so the pointer can reach it.
	overviewMore *core.Signal[string]
	// activePane is the split pane filling the work area, "" for the
	// session's own view.
	activePane *core.Signal[string]
	filter     *core.Signal[string]
	sidebar    *core.Signal[bool]
	drawer     *core.Signal[bool]
	drawerTab  *core.Signal[string]
	theme      *core.Signal[string]
	uiFont     *core.Signal[string]
	monoFont   *core.Signal[string]
	// chatFont, chatLine and inputFont are the reading and writing sizes;
	// 0 follows the built-in defaults.
	chatFont  *core.Signal[float64]
	chatLine  *core.Signal[float64]
	inputFont *core.Signal[float64]
	toolRev   *core.Signal[int]
	aiBusy    *core.Signal[string]
	bgImage   *core.Signal[string]
	bgOpacity *core.Signal[float64]
	// bgOpacitySeq numbers opacity changes, so only the last one settles the
	// theme after a drag.
	bgOpacitySeq int
	// alertVolumeSig is the notification volume the slider shows, 0 to 100: the
	// drag redraws its label from it without rebuilding the page around it.
	alertVolumeSig *core.Signal[int]
	llmFn          func(tool, system, prompt string, maxTokens int) (string, error)

	byID map[string]*session
	all  []*session

	palette  *core.Signal[bool]
	settings *core.Signal[bool]
	// settingsRev changes after a setting is switched, so the page shows
	// the value it now holds.
	settingsRev   *core.Signal[int]
	brandOpen     *core.Signal[bool]
	brandRev      *core.Signal[int]
	brandNameRev  *core.Signal[int]
	brandInputRev *core.Signal[int]
	brandBusy     *core.Signal[bool]
	brandError    *core.Signal[string]
	customBrand   brandImage
	brandImageSeq int
	settingsTab   *core.Signal[string]
	// scrolls are the offsets of scroll views under a Dynamic, by key: a
	// rerun clears the subtree, and the place has to come from outside.
	scrolls viewkit.Stashes
	// tabRefs are the open tabs' elements, by tab id: the bar scrolls the
	// focused one into sight so a full bar never hides it.
	tabRefs map[string]*core.Ref
	// The diagnostics page reads these, and a slow tick fills them, so
	// showing what is running never rebuilds the page's scroll view.
	diagMem    *core.Signal[diagMemory]
	diagProcs  *core.Signal[*diagProcs]
	diagLog    *core.Signal[*diagLogEvents]
	addWS      *core.Signal[bool]
	addTarget  *core.Signal[bool]
	addKind    *core.Signal[int]
	addWhere   *core.Signal[string]
	addPath    *core.Signal[string]
	importOpen *core.Signal[bool]
	renameOpen *core.Signal[bool]
	renameText *core.Signal[string]
	renameID   string
	// The file name dialog: new file, new folder or rename.
	fileOpOpen   *core.Signal[bool]
	fileOpTitle  *core.Signal[string]
	fileOpText   *core.Signal[string]
	fileOpAction func(string)
	// The export dialog and the session it writes.
	exportOpen     *core.Signal[bool]
	exportOriginal *core.Signal[bool]
	exportID       string
	// pendingShot is the name of a window shot queued for the export dialog's
	// close, which runs once the picture is free of the dialog itself.
	pendingShot string
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
	// The pi extension store: `pi list` plus pi.dev's package directory.
	piStoreOpen         *core.Signal[bool]
	piStoreQuery        *core.Signal[string]
	piStoreBusy         *core.Signal[bool]
	piStoreErr          *core.Signal[string]
	piStoreList         *core.Signal[[]piCatalogItem]
	piStorePage         *core.Signal[int]
	piStoreLast         *core.Signal[int]
	piStoreInstalled    *core.Signal[[]piPackage]
	piStoreInstalledErr *core.Signal[string]
	piStoreActing       *core.Signal[string]
	piStoreLocal        *core.Signal[bool]
	// A new query or close invalidates posted catalog results.
	piStoreGen    uint64
	piStoreCancel context.CancelFunc
	// The plugin market.
	marketOpen *core.Signal[bool]
	marketURL  *core.Signal[string]
	marketBusy *core.Signal[bool]
	marketErr  *core.Signal[string]
	marketList *core.Signal[[]marketEntry]
	// Request ownership is UI-only. Every replacement/close invalidates
	// posted results; installation state remains owned by its signal.
	marketRequestGen    uint64
	marketRequestCancel context.CancelFunc
	// Hot update for the bundled pi extensions.
	piExtUpdateBusy *core.Signal[bool]
	// Image generation.
	imageOpen       *core.Signal[bool]
	transcriptImage *core.Signal[remotewire.Image]
	// attachPreview is the composer image the preview dialog enlarges; empty
	// bytes close it.
	attachPreview *core.Signal[remotewire.Image]
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
	confirmPrimary bool
	confirmFn      func()
	// askSeq redraws the ask card when its request changes.
	askSeq *core.Signal[int]

	pick *pickerState

	files      *fileTree
	filesRev   *core.Signal[int]
	filesQuery *core.Signal[string]
	fileIdx    fileIndexCache
	editor     *editorHost
	git        *gitRepo
	review     *review
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
	// railExpanded holds the sessions whose children the rail shows: a
	// persisted subagent reads folded under its parent until asked for.
	railExpanded *core.Signal[map[string]bool]
	archiveRev   *core.Signal[int]
	archiveOpen  *core.Signal[bool]
	// The import dialog: what a scan of the other agents' stores found,
	// what the user picked, and how far a run has got.
	impOpen     *core.Signal[bool]
	impRows     *core.Signal[[]sessionimport.Row]
	impScanning *core.Signal[bool]
	impBusy     *core.Signal[bool]
	impDone     *core.Signal[int]
	impTotal    *core.Signal[int]
	impFailed   *core.Signal[int]
	impQuery    *core.Signal[string]
	impOnly     *core.Signal[string]
	// impProject is the project the dialog was opened for: what is imported
	// goes there whatever folder it ran in. Empty means "where it ran".
	impProject *core.Signal[string]
	impSel     *core.Signal[[]string]
	// impSelSet is impSel as a set, so a row's checked state is a lookup.
	impSelSet map[string]bool
	impGen    int
	// railWidth and drawerWidth are the side panels' widths, saved when a
	// drag rests; the seq counters drop a save a newer drag replaced.
	railWidth       *core.Signal[core.Points]
	drawerWidth     *core.Signal[core.Points]
	railSeq         int
	drawerSeq       int
	winSeq          int
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
	fileSearchRoot  string
	fileSearchHits  []fileHit
	fileSearchSeq   int
	// gitDiffHash is the commit the diff dialog shows, empty for a file.
	gitDiffHash string
	// closedTabs are the sessions whose tabs were closed, newest last.
	closedTabs []string
	// addonsGen drops a stale plugin reload that finished after a newer one.
	addonsGen int
	// A successful file change remains busy until the current inventory is published.
	pluginFilesReloaded func()
	// piScanGen drops a pi history scan that finished after a newer one.
	piScanGen        int
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
	mainWin         *core.Window
	voiceCapture    desktopVoice
	video           *videoHost
	wechat          *wechatHost
	balanceAccounts *balanceAccountsState
	tray            *core.Tray
	quitting        bool
	trayHinted      bool
	mainHooked      bool
	mainTries       int
	lastTray        time.Time
	// lastHeapRelease is when idle heap last went back to the system, so a
	// big transcript release costs one pause and not one per tick.
	lastHeapRelease time.Time
	// releasing guards one collection at a time, so a second press does not
	// queue another full GC behind the first.
	releasing bool

	// Warm agent processes: one booted spare per project, adopted by the
	// next new session instead of starting a CLI from scratch. warmMu guards
	// the slots the spawn goroutines write.
	warmMu          sync.Mutex
	warm            *warmPi
	warmSpawning    string
	warmOK          bool
	acpWarmMu       sync.Mutex
	acpWarm         *warmACP
	acpWarmSpawning string
}
