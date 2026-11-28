package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"example.com/pideck/internal/alerts"
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// mobileSaved is the last connection the phone used, and the ones before
// it so a second server is one tap away, beside the look, the language and
// the project it was left on.
type mobileSaved struct {
	Server     string         `json:"server"`
	Token      string         `json:"token"`
	Recent     []mobileRecent `json:"recent,omitempty"`
	Language   string         `json:"language,omitempty"`
	Appearance string         `json:"appearance,omitempty"`
	Project    string         `json:"project,omitempty"`
	// Sound is the phone's own alert: whether it plays when a turn ends or
	// waits for an answer, and which built-in it plays. It is a device
	// preference, like the ring volume, so it stays here rather than
	// following the desktop's config.
	Sound     bool   `json:"sound,omitempty"`
	SoundName string `json:"soundName,omitempty"`
	Notify    bool   `json:"notify,omitempty"`
}

type mobileRecent struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Name   string `json:"name"`
	At     int64  `json:"at"`
}

type mobileApp struct {
	cx             *core.Scope
	saveGeneration atomic.Uint64
	saveWriteMu    sync.Mutex
	// scrolls are the offsets of scroll views under a Dynamic, by key: a
	// rerun clears the subtree, and the place has to come from outside.
	scrolls viewkit.Stashes

	server *core.Signal[string]
	token  *core.Signal[string]
	recent *core.Signal[[]mobileRecent]
	busy   *core.Signal[bool]
	err    *core.Signal[string]

	connected  *core.Signal[bool]
	serverName *core.Signal[string]
	// desktopVersion is what the desktop's /api/ping reports, so a page can
	// tell when it predates the app it talks to.
	desktopVersion *core.Signal[string]
	state          *core.Signal[remotewire.Snapshot]

	active        *core.Signal[string]
	activeTitle   *core.Signal[string]
	messages      *core.Signal[[]remotewire.Message]
	transcriptErr *core.Signal[string]
	// sendErr is why the phone's own send or stop did not reach the
	// desktop. It is not the turn's error, so the transcript's refresh
	// never clears it.
	sendErr        *core.Signal[string]
	transcriptBusy *core.Signal[bool]
	// transcriptTruncated says one line was too big to send whole.
	transcriptTruncated *core.Signal[bool]
	// messagesBefore is how many turns come before the loaded ones, and
	// olderBusy whether the read for them is running.
	messagesBefore *core.Signal[int]
	olderBusy      *core.Signal[bool]
	// ask is the desktop's pending question, answerable from here.
	ask        *core.Signal[*remotewire.Ask]
	askText    *core.Signal[string]
	askSending *core.Signal[bool]
	// askPicks are the batch's answered questions and askTexts what each
	// field holds; askKey names the request they belong to, so another
	// turn's questions never inherit them.
	askPicks *core.Signal[[]remotewire.AskAnswer]
	askTexts *core.Signal[map[string]string]
	askKey   string

	// git is one project's repository, read-only.
	gitOpen         *core.Signal[bool]
	gitProject      *core.Signal[string]
	gitName         *core.Signal[string]
	gitState        *core.Signal[remotewire.Git]
	gitBusy         *core.Signal[bool]
	gitErr          *core.Signal[string]
	gitDiffOpen     *core.Signal[bool]
	gitDiffTitle    *core.Signal[string]
	gitDiffText     *core.Signal[string]
	gitDiffErr      *core.Signal[string]
	gitDiffBusy     *core.Signal[bool]
	gitMsg          *core.Signal[string]
	gitSending      *core.Signal[bool]
	gitBranchesOpen *core.Signal[bool]

	// review is a project's pull requests and issues.
	reviewOpen       *core.Signal[bool]
	reviewProject    *core.Signal[string]
	reviewName       *core.Signal[string]
	reviewKind       *core.Signal[string]
	reviewFilter     *core.Signal[string]
	reviewQuery      *core.Signal[string]
	reviewItems      *core.Signal[[]remotewire.ReviewItem]
	reviewBusy       *core.Signal[bool]
	reviewErr        *core.Signal[string]
	reviewMissing    *core.Signal[bool]
	reviewDetailOpen *core.Signal[bool]
	reviewDetail     *core.Signal[remotewire.ReviewDetail]
	reviewDetailBusy *core.Signal[bool]
	reviewDetailErr  *core.Signal[string]
	reviewComment    *core.Signal[string]
	reviewSending    *core.Signal[bool]
	reviewPending    *core.Signal[string]
	reviewPatchOpen  *core.Signal[bool]
	reviewPatch      *core.Signal[string]
	reviewPatchErr   *core.Signal[string]
	reviewPatchBusy  *core.Signal[bool]

	// filesOpen browses a project's files, fileOpen shows one file's text.
	filesOpen    *core.Signal[bool]
	filesProject *core.Signal[string]
	filesName    *core.Signal[string]
	filesQuery   *core.Signal[string]
	filesList    *core.Signal[[]remotewire.File]
	filesBusy    *core.Signal[bool]
	filesErr     *core.Signal[string]
	filesSeq     int
	fileOpen     *core.Signal[bool]
	fileTitle    *core.Signal[string]
	fileText     *core.Signal[string]
	fileEdit     mobileFileEditor
	fileBusy     *core.Signal[bool]
	fileErr      *core.Signal[string]
	fileFind     *core.Signal[string]

	client   *remoteClient
	gen      int
	features mobileSessionFeatures

	// drawer is the rail over the page on a phone; initProject, initDraft
	// and initPending are the new-session page's choices, and railCollapsed
	// the projects folded in the rail.
	drawerOpen    *core.Signal[bool]
	railHidden    *core.Signal[bool]
	initProject   *core.Signal[string]
	initDraft     *core.Signal[string]
	initPending   *core.Signal[[]remotewire.Image]
	initSending   *core.Signal[bool]
	railCollapsed *core.Signal[[]string]
	// railExpandedPaths are the projects showing sessions older than the
	// last few days, which the rail folds away by default.
	railExpandedPaths *core.Signal[[]string]
	settingsOpen      *core.Signal[bool]
	projectOpen       *core.Signal[string]
	appearance        *core.Signal[string]
	language          *core.Signal[string]
	// soundOn and soundName are the phone's alert settings, kept in
	// remote.json beside the look; sounds plays them.
	soundOn   *core.Signal[bool]
	notifyOn  *core.Signal[bool]
	soundName *core.Signal[string]
	sounds    *alerts.Player

	// The rail's lists: the ways of working a session can start with, the
	// desktop's cron tasks and its favorites.
	agents        *core.Signal[[]remotewire.Agent]
	agentsBusy    *core.Signal[bool]
	agentsErr     *core.Signal[string]
	agentsOpen    *core.Signal[bool]
	tasks         *core.Signal[[]remotewire.Task]
	tasksBusy     *core.Signal[bool]
	tasksErr      *core.Signal[string]
	tasksOpen     *core.Signal[bool]
	taskOpen      *core.Signal[string]
	taskBusy      *core.Signal[string]
	favorites     *core.Signal[[]remotewire.Favorite]
	favoritesBusy *core.Signal[bool]
	favoritesErr  *core.Signal[string]
	favoritesOpen *core.Signal[bool]
	favOpen       *core.Signal[string]

	// query filters the session list, findText the open transcript.
	query                *core.Signal[string]
	searchOpen           *core.Signal[bool]
	findOpen             *core.Signal[bool]
	findText             *core.Signal[string]
	findSelected         *core.Signal[transcriptRowKey]
	transcriptPicture    *core.Signal[transcriptPicture]
	transcriptPictureSeq uint64
	transcriptImages     transcriptImageCache

	// draft is the composer's text, pending the pictures attached to it;
	// sending covers one request in flight.
	draft             *core.Signal[string]
	draftChange       *core.Signal[*viewkit.DraftChange]
	draftChangeOwner  string
	draftChangeClient *remoteClient
	pending           *core.Signal[[]remotewire.Image]
	sending           *core.Signal[bool]
	running           *core.Signal[bool]
	// mode is what the open session's next turn asks for, echoed from the
	// desktop: "" for a normal prompt, else "plan", "goal" or "imagegen".
	mode *core.Signal[string]
	// composerPlusOpen shows the composer's add menu, aiBusy names the draft
	// tool running for it, and filesMention makes the file list insert an
	// @path instead of opening the file.
	composerPlusOpen *core.Signal[bool]
	aiBusy           *core.Signal[string]
	filesMention     *core.Signal[bool]

	// actionID is the session whose action sheet is open, renameID the one
	// being renamed, newOpen the project chooser.
	actionID   *core.Signal[string]
	deleteID   *core.Signal[string]
	renameID   *core.Signal[string]
	renameText *core.Signal[string]
	newOpen    *core.Signal[bool]
	creating   *core.Signal[bool]
	// addPath is the folder being added, removePath the project being
	// taken off the desktop.
	addPath    *core.Signal[string]
	addOpen    *core.Signal[bool]
	removePath *core.Signal[string]

	// options are the open session's models and thinking levels, shown in
	// the sheet over optionsOpen; optionsQuery filters its model list.
	options      *core.Signal[remotewire.Options]
	optionsOpen  *core.Signal[bool]
	optionsQuery *core.Signal[string]

	// toolOpen is the key of the tool block the user unfolded, longOpen the
	// long user message that is fully shown.
	toolOpen *core.Signal[string]
	longOpen *core.Signal[string]
	// thoughtOpen holds the thinking blocks the user opened, thoughtFull
	// the ones whose rest they asked for: a long block opens to its head
	// first, so one reasoning does not fill the screen. procOpen holds the
	// finished turns whose process the user unfolded.
	thoughtOpen *core.Signal[[]string]
	thoughtFull *core.Signal[[]string]
	procOpen    *core.Signal[[]string]

	// hits are the message matches for the list's query; searchSeq drops
	// answers for a query the user already changed.
	hits      *core.Signal[[]remotewire.Hit]
	hitsBusy  *core.Signal[bool]
	searchSeq int
	hitsQuery string

	// scroll is the transcript's scroller; atBottom says it rests at the
	// end, notice is a short confirmation over the composer.
	scroll   *core.Ref
	atBottom *core.Signal[bool]
	notice   *core.Signal[string]

	stateLoading bool
	// pendingRoute is the session a page's address named before the state
	// that holds it arrived; applyingRoute says the app is following the
	// browser, so the address it reads is not written back.
	pendingRoute  webRoute
	applyingRoute bool
	// sessionSeq identifies each visit, including reopening the same session.
	// Reads from an earlier visit cannot publish into the current one.
	sessionSeq int
	// transcriptSeq names the newest transcript read; an older reply that
	// arrives after a switch is dropped instead of filling the page.
	transcriptSeq int
	refreshing    *core.Signal[bool]
	// busyMark is what the header's spinner follows: a read slow enough to
	// be worth explaining, not every poll the page makes on its own.
	busyMark *core.Signal[bool]
}

// newMobileApp builds the phone's state and reconnects to the last server.
func newMobileApp(cx *core.Scope) *mobileApp {
	cx.SetAppearance(core.AppearanceSystem)
	cx.SetTheme(viewkit.Theme())
	setting := strings.TrimSpace(os.Getenv("PIDECK_V2_LANG"))
	cx.SetLocale(apptext.Locale(setting))
	apptext.SetLanguage(apptext.ResolveLanguage(setting, cx.Env().Locale()))
	a := &mobileApp{
		cx:                  cx,
		features:            newMobileSessionFeatures(cx),
		server:              core.NewSignal(cx, ""),
		recent:              core.NewSignalFunc(cx, []mobileRecent(nil), nil),
		token:               core.NewSignal(cx, ""),
		busy:                core.NewSignal(cx, false),
		err:                 core.NewSignal(cx, ""),
		connected:           core.NewSignal(cx, false),
		serverName:          core.NewSignal(cx, "PiDeck"),
		desktopVersion:      core.NewSignal(cx, ""),
		state:               core.NewSignalFunc(cx, remotewire.Snapshot{}, sameSnapshot),
		active:              core.NewSignal(cx, ""),
		activeTitle:         core.NewSignal(cx, ""),
		messages:            core.NewSignalFunc(cx, []remotewire.Message(nil), sameMessages),
		transcriptErr:       core.NewSignal(cx, ""),
		sendErr:             core.NewSignal(cx, ""),
		transcriptBusy:      core.NewSignal(cx, false),
		transcriptTruncated: core.NewSignal(cx, false),
		messagesBefore:      core.NewSignal(cx, 0),
		olderBusy:           core.NewSignal(cx, false),
		ask:                 core.NewSignalFunc(cx, (*remotewire.Ask)(nil), sameAsk),
		askText:             core.NewSignal(cx, ""),
		askSending:          core.NewSignal(cx, false),
		askPicks:            core.NewSignalFunc(cx, []remotewire.AskAnswer(nil), nil),
		askTexts:            core.NewSignalFunc(cx, map[string]string(nil), nil),
		reviewOpen:          core.NewSignal(cx, false),
		reviewProject:       core.NewSignal(cx, ""),
		reviewName:          core.NewSignal(cx, ""),
		reviewKind:          core.NewSignal(cx, "pr"),
		reviewFilter:        core.NewSignal(cx, "open"),
		reviewQuery:         core.NewSignal(cx, ""),
		reviewItems:         core.NewSignalFunc(cx, []remotewire.ReviewItem(nil), nil),
		reviewBusy:          core.NewSignal(cx, false),
		reviewErr:           core.NewSignal(cx, ""),
		reviewMissing:       core.NewSignal(cx, false),
		reviewDetailOpen:    core.NewSignal(cx, false),
		reviewDetail:        core.NewSignalFunc(cx, remotewire.ReviewDetail{}, nil),
		reviewDetailBusy:    core.NewSignal(cx, false),
		reviewDetailErr:     core.NewSignal(cx, ""),
		reviewComment:       core.NewSignal(cx, ""),
		reviewSending:       core.NewSignal(cx, false),
		reviewPending:       core.NewSignal(cx, ""),
		reviewPatchOpen:     core.NewSignal(cx, false),
		reviewPatch:         core.NewSignal(cx, ""),
		reviewPatchErr:      core.NewSignal(cx, ""),
		reviewPatchBusy:     core.NewSignal(cx, false),
		gitOpen:             core.NewSignal(cx, false),
		gitProject:          core.NewSignal(cx, ""),
		gitName:             core.NewSignal(cx, ""),
		gitState:            core.NewSignalFunc(cx, remotewire.Git{}, nil),
		gitBusy:             core.NewSignal(cx, false),
		gitErr:              core.NewSignal(cx, ""),
		gitDiffOpen:         core.NewSignal(cx, false),
		gitDiffTitle:        core.NewSignal(cx, ""),
		gitDiffText:         core.NewSignal(cx, ""),
		gitDiffErr:          core.NewSignal(cx, ""),
		gitDiffBusy:         core.NewSignal(cx, false),
		gitMsg:              core.NewSignal(cx, ""),
		gitSending:          core.NewSignal(cx, false),
		gitBranchesOpen:     core.NewSignal(cx, false),
		filesOpen:           core.NewSignal(cx, false),
		filesProject:        core.NewSignal(cx, ""),
		filesName:           core.NewSignal(cx, ""),
		filesQuery:          core.NewSignal(cx, ""),
		filesList:           core.NewSignalFunc(cx, []remotewire.File(nil), nil),
		filesBusy:           core.NewSignal(cx, false),
		filesErr:            core.NewSignal(cx, ""),
		fileOpen:            core.NewSignal(cx, false),
		fileTitle:           core.NewSignal(cx, ""),
		fileText:            core.NewSignal(cx, ""),
		fileEdit:            newMobileFileEditor(cx),
		fileBusy:            core.NewSignal(cx, false),
		fileErr:             core.NewSignal(cx, ""),
		fileFind:            core.NewSignal(cx, ""),
		refreshing:          core.NewSignal(cx, false),
		busyMark:            core.NewSignal(cx, false),
		query:               core.NewSignal(cx, ""),
		searchOpen:          core.NewSignal(cx, false),
		findOpen:            core.NewSignal(cx, false),
		findText:            core.NewSignal(cx, ""),
		findSelected:        core.NewSignal(cx, transcriptRowKey{}),
		transcriptPicture:   core.NewSignalFunc(cx, transcriptPicture{}, nil),
		transcriptImages:    transcriptImageCache{ctx: cx.Context()},
		draft:               core.NewSignal(cx, ""),
		draftChange:         core.NewSignal(cx, (*viewkit.DraftChange)(nil)),
		pending:             core.NewSignalFunc(cx, []remotewire.Image(nil), nil),
		sending:             core.NewSignal(cx, false),
		running:             core.NewSignal(cx, false),
		mode:                core.NewSignal(cx, ""),
		composerPlusOpen:    core.NewSignal(cx, false),
		aiBusy:              core.NewSignal(cx, ""),
		filesMention:        core.NewSignal(cx, false),
		actionID:            core.NewSignal(cx, ""),
		deleteID:            core.NewSignal(cx, ""),
		renameID:            core.NewSignal(cx, ""),
		renameText:          core.NewSignal(cx, ""),
		newOpen:             core.NewSignal(cx, false),
		creating:            core.NewSignal(cx, false),
		addPath:             core.NewSignal(cx, ""),
		addOpen:             core.NewSignal(cx, false),
		removePath:          core.NewSignal(cx, ""),
		options:             core.NewSignalFunc(cx, remotewire.Options{}, sameOptions),
		optionsOpen:         core.NewSignal(cx, false),
		optionsQuery:        core.NewSignal(cx, ""),
		toolOpen:            core.NewSignal(cx, ""),
		longOpen:            core.NewSignal(cx, ""),
		thoughtOpen:         core.NewSignalFunc(cx, []string(nil), nil),
		thoughtFull:         core.NewSignalFunc(cx, []string(nil), nil),
		procOpen:            core.NewSignalFunc(cx, []string(nil), nil),
		hits:                core.NewSignalFunc(cx, []remotewire.Hit(nil), nil),
		hitsBusy:            core.NewSignal(cx, false),
		scroll:              &core.Ref{},
		atBottom:            core.NewSignal(cx, true),
		notice:              core.NewSignal(cx, ""),
		drawerOpen:          core.NewSignal(cx, false),
		railHidden:          core.NewSignal(cx, false),
		initProject:         core.NewSignal(cx, ""),
		initDraft:           core.NewSignal(cx, ""),
		initPending:         core.NewSignalFunc(cx, []remotewire.Image(nil), nil),
		initSending:         core.NewSignal(cx, false),
		railCollapsed:       core.NewSignalFunc(cx, []string(nil), nil),
		railExpandedPaths:   core.NewSignalFunc(cx, []string(nil), nil),
		settingsOpen:        core.NewSignal(cx, false),
		projectOpen:         core.NewSignal(cx, ""),
		appearance:          core.NewSignal(cx, appearanceSystem),
		language:            core.NewSignal(cx, apptext.LangZhCN),
		soundOn:             core.NewSignal(cx, false),
		notifyOn:            core.NewSignal(cx, false),
		soundName:           core.NewSignal(cx, ""),
		agents:              core.NewSignalFunc(cx, []remotewire.Agent(nil), nil),
		agentsBusy:          core.NewSignal(cx, false),
		agentsErr:           core.NewSignal(cx, ""),
		agentsOpen:          core.NewSignal(cx, false),
		tasks:               core.NewSignalFunc(cx, []remotewire.Task(nil), nil),
		tasksBusy:           core.NewSignal(cx, false),
		tasksErr:            core.NewSignal(cx, ""),
		tasksOpen:           core.NewSignal(cx, false),
		taskOpen:            core.NewSignal(cx, ""),
		taskBusy:            core.NewSignal(cx, ""),
		favorites:           core.NewSignalFunc(cx, []remotewire.Favorite(nil), nil),
		favoritesBusy:       core.NewSignal(cx, false),
		favoritesErr:        core.NewSignal(cx, ""),
		favoritesOpen:       core.NewSignal(cx, false),
		favOpen:             core.NewSignal(cx, ""),
	}
	a.watchSessionActivity(cx)
	saved := loadMobileSaved(cx)
	// The saved look, language and last project win over the system's:
	// the user chose them here, not on this boot.
	if saved.Language != "" {
		cx.SetLocale(apptext.Locale(saved.Language))
		apptext.SetLanguage(apptext.ResolveLanguage(saved.Language, cx.Env().Locale()))
	}
	a.language.Set(apptext.CurrentLanguage())
	a.appearance.Set(saved.Appearance)
	cx.SetAppearance(appearanceOf(saved.Appearance))
	a.initProject.Set(saved.Project)
	a.soundOn.Set(saved.Sound)
	a.soundName.Set(saved.SoundName)
	a.notifyOn.Set(saved.Notify)
	a.installNotificationHandler()
	a.sounds = alerts.New(cx)
	a.watchBusy(cx)
	// A page is served by a desktop, so its origin is the server and a link's
	// ?token= the token; a saved connection wins only over the origin.
	entry := webStart()
	if entry.Server != "" {
		if saved.Server == "" {
			saved.Server = entry.Server
		}
		if entry.Token != "" {
			saved.Token = entry.Token
		}
		// The address keeps only the route: a token left in it would sit in
		// the browser's history, a bookmark and a screenshot of this window.
		// It is cleared once the connection works, so a mistyped or expired
		// link still holds its token for a second try.
		a.pendingRoute = entry.Route
	}
	if saved.Server != "" || len(saved.Recent) > 0 {
		a.recent.Set(saved.Recent)
		if saved.Server != "" {
			a.server.Set(saved.Server)
			a.token.Set(saved.Token)
			a.connect()
		}
	}
	// A page keeps the open session in its address, so a reload, a bookmark
	// and a link pasted into a chat all land on it. A browser navigation
	// reads that address back; whether a sheet or a page closes first is the
	// back handler's call, which the browser asks before this.
	if webMode() {
		cx.OnAppURLChange(func(change core.AppURLChange) { a.showWebRoute(parseWebRoute(change.URL)) })
		cx.Effect(func() { setPageTitle(webPageTitle(a.connected.Get(), a.activeTitle.Get())) })
	}
	cx.OnBackPress(func() bool {
		if a.transcriptPicture.GetUntracked().Open {
			a.closeTranscriptPicture()
			return true
		}
		if a.drawerOpen.GetUntracked() {
			a.openDrawer(false)
			return true
		}
		if a.active.GetUntracked() != "" {
			a.closeSession()
			return true
		}
		return false
	})
	// A phone that comes back reads at once: the tunnel it left is often
	// gone, and waiting for the next poll would show a stale page.
	cx.Effect(func() {
		if cx.Env().Lifecycle() != core.LifecycleActive || !a.connected.Get() {
			return
		}
		a.refreshState()
		a.refreshTranscript()
	})
	return a
}

// scrollStashFor is the stash of the phone's scroll view called key, made on
// first use.
func (a *mobileApp) scrollStashFor(key string) *viewkit.ScrollStash {
	if a.scrolls == nil {
		a.scrolls = viewkit.Stashes{}
	}
	return a.scrolls.For(key)
}
