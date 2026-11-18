//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"
	"sync"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

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
	images     *core.Signal[[]remotewire.Image]
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
	// steering mirrors pi's queue: messages that take effect before its
	// next call. sending holds the follow-ups this app keeps for the end of
	// the turn.
	steering *core.Signal[[]string]
	sending  *core.Signal[[]queuedMessage]
	// ask is the request the card shows; asks wait behind it, oldest
	// first, and askPending counts them all for the rail's badge. askUI
	// holds what the card has typed and answered.
	ask        *core.Signal[*extensionAsk]
	asks       []*extensionAsk
	askPending *core.Signal[int]
	askUI      *core.Signal[askUIState]
	// askTexts is what the card's fields hold. Typing writes only this, so
	// a keystroke redraws the field and not the card around it.
	askTexts *core.Signal[map[string]string]
	window   *core.Signal[int]
	// todos is the agent's task list, and todoOpen whether the bar above
	// the composer shows all of it.
	todos    *core.Signal[[]todoItem]
	todoOpen *core.Signal[bool]
	// todoDismissed is the list the strip was closed on: it stays away
	// until the list changes again. extWidgets holds what extensions
	// publish with setWidget, by key.
	todoDismissed string
	extWidgets    map[string][]string
	// runningSig is whether a turn is in flight. It changes twice a turn,
	// so the composer's controls are not rebuilt by every streamed delta.
	runningSig *core.Signal[bool]
	// agentMode is what the next prompt asks for: normal work, a plan, an
	// auto-continued goal, or an image. sendMode is how a message reaches a
	// running turn: steer before its next call, or a follow-up after it ends.
	agentMode *core.Signal[string]
	sendMode  *core.Signal[string]
	// goalRounds counts a goal's turns, and goalPaused holds it after the
	// user stops, until they ask it to go on.
	goalRounds int
	goalPaused *core.Signal[bool]
	// goalText is the objective the user wrote, for the goal strip.
	goalText string
	// Step-by-step plan execution.
	planSteps  []string
	planIndex  int
	planActive bool
	// readySig is whether pi answered for this session.
	readySig *core.Signal[bool]

	modelOpen   *core.Signal[bool]
	modelQuery  *core.Signal[string]
	backendOpen *core.Signal[bool]
	modeOpen    *core.Signal[bool]
	imageOpen2  *core.Signal[bool]
	sendOpen    *core.Signal[bool]
	usageOpen   *core.Signal[bool]
	projectOpen *core.Signal[bool]

	streamText     *core.Signal[string]
	streamThinking *core.Signal[string]
	liveTools      *core.Signal[[]toolRun]

	conversation *chatScroll
	// tops is where each rendered turn sits in the transcript, by turn ID,
	// so the ruler can scroll to the one it stands for. Only the interface
	// thread touches it.
	tops map[string]float64

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
