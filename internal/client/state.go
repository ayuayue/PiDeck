package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"os"
	"strings"

	"example.com/pideck-lite/internal/alerts"
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
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
}

type mobileRecent struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Name   string `json:"name"`
	At     int64  `json:"at"`
}

type mobileApp struct {
	cx *core.Scope

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
	reviewPatchBusy  *core.Signal[bool]

	// filesOpen browses a project's files, fileOpen shows one file's text.
	filesOpen    *core.Signal[bool]
	filesProject *core.Signal[string]
	filesName    *core.Signal[string]
	filesQuery   *core.Signal[string]
	filesList    *core.Signal[[]remotewire.File]
	filesBusy    *core.Signal[bool]
	filesErr     *core.Signal[string]
	fileOpen     *core.Signal[bool]
	fileTitle    *core.Signal[string]
	fileText     *core.Signal[string]
	fileBusy     *core.Signal[bool]
	fileErr      *core.Signal[string]
	fileFind     *core.Signal[string]

	client *remoteClient
	gen    int

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
	query      *core.Signal[string]
	searchOpen *core.Signal[bool]
	findOpen   *core.Signal[bool]
	findText   *core.Signal[string]

	// draft is the composer's text, pending the pictures attached to it;
	// sending covers one request in flight.
	draft   *core.Signal[string]
	pending *core.Signal[[]remotewire.Image]
	sending *core.Signal[bool]
	running *core.Signal[bool]
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
	// the sheet over optionsOpen.
	options     *core.Signal[remotewire.Options]
	optionsOpen *core.Signal[bool]

	// toolOpen is the key of the tool block the user unfolded, longOpen the
	// long user message that is fully shown.
	toolOpen *core.Signal[string]
	longOpen *core.Signal[string]
	// thoughtOpen holds the thinking blocks the user opened, thoughtFull
	// the ones whose rest they asked for: a long block opens to its head
	// first, so one reasoning does not fill the screen.
	thoughtOpen *core.Signal[[]string]
	thoughtFull *core.Signal[[]string]

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
	// transcriptSeq names the newest transcript read; an older reply that
	// arrives after a switch is dropped instead of filling the page.
	transcriptSeq int
	refreshing    *core.Signal[bool]
}

// newMobileApp builds the phone's state and reconnects to the last server.
func newMobileApp(cx *core.Scope) *mobileApp {
	cx.SetAppearance(core.AppearanceSystem)
	cx.SetTheme(viewkit.Theme())
	setting := strings.TrimSpace(os.Getenv("PIDECK_LITE_LANG"))
	apptext.SetLanguage(apptext.ResolveLanguage(setting, cx.Env().Locale()))
	a := &mobileApp{
		cx:                  cx,
		server:              core.NewSignal(cx, ""),
		recent:              core.NewSignalFunc(cx, []mobileRecent(nil), nil),
		token:               core.NewSignal(cx, ""),
		busy:                core.NewSignal(cx, false),
		err:                 core.NewSignal(cx, ""),
		connected:           core.NewSignal(cx, false),
		serverName:          core.NewSignal(cx, "PiDeck Lite"),
		desktopVersion:      core.NewSignal(cx, ""),
		state:               core.NewSignalFunc(cx, remotewire.Snapshot{}, nil),
		active:              core.NewSignal(cx, ""),
		activeTitle:         core.NewSignal(cx, ""),
		messages:            core.NewSignalFunc(cx, []remotewire.Message(nil), nil),
		transcriptErr:       core.NewSignal(cx, ""),
		sendErr:             core.NewSignal(cx, ""),
		transcriptBusy:      core.NewSignal(cx, false),
		transcriptTruncated: core.NewSignal(cx, false),
		messagesBefore:      core.NewSignal(cx, 0),
		olderBusy:           core.NewSignal(cx, false),
		ask:                 core.NewSignalFunc(cx, (*remotewire.Ask)(nil), nil),
		askText:             core.NewSignal(cx, ""),
		askSending:          core.NewSignal(cx, false),
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
		fileBusy:            core.NewSignal(cx, false),
		fileErr:             core.NewSignal(cx, ""),
		fileFind:            core.NewSignal(cx, ""),
		refreshing:          core.NewSignal(cx, false),
		query:               core.NewSignal(cx, ""),
		searchOpen:          core.NewSignal(cx, false),
		findOpen:            core.NewSignal(cx, false),
		findText:            core.NewSignal(cx, ""),
		draft:               core.NewSignal(cx, ""),
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
		options:             core.NewSignalFunc(cx, remotewire.Options{}, nil),
		optionsOpen:         core.NewSignal(cx, false),
		toolOpen:            core.NewSignal(cx, ""),
		longOpen:            core.NewSignal(cx, ""),
		thoughtOpen:         core.NewSignalFunc(cx, []string(nil), nil),
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
	saved := loadMobileSaved(cx)
	// The saved look, language and last project win over the system's:
	// the user chose them here, not on this boot.
	if saved.Language != "" {
		apptext.SetLanguage(apptext.ResolveLanguage(saved.Language, cx.Env().Locale()))
	}
	a.language.Set(apptext.CurrentLanguage())
	a.appearance.Set(saved.Appearance)
	cx.SetAppearance(appearanceOf(saved.Appearance))
	a.initProject.Set(saved.Project)
	a.soundOn.Set(saved.Sound)
	a.soundName.Set(saved.SoundName)
	a.sounds = alerts.New(cx)
	// A page is served by a desktop, so its origin is the server and a link's
	// ?token= the token; a saved connection wins only over the origin.
	if origin, linkToken := webStart(); origin != "" {
		if saved.Server == "" {
			saved.Server = origin
		}
		if linkToken != "" {
			saved.Token = linkToken
		}
	}
	if saved.Server != "" || len(saved.Recent) > 0 {
		a.recent.Set(saved.Recent)
		if saved.Server != "" {
			a.server.Set(saved.Server)
			a.token.Set(saved.Token)
			a.connect()
		}
	}
	cx.OnBackPress(func() bool {
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
