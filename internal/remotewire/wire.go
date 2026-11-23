package remotewire

// The desktop's HTTP API and the phone and browser clients it serves share
// these shapes: remote.go fills them, remote_client.go and mobile.go read
// them. They live here, apart from the server, so a browser build that has
// no server still knows what it receives.

// askMethodBatch is shared with the phone, which can dismiss a batch
// request even though its questions are answered in the desktop card.
const AskMethodBatch = "batch_ask"

// remoteWireFile is one file in a project's list.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type FileText struct {
	Path     string `json:"path"`
	Text     string `json:"text"`
	Size     int64  `json:"size"`
	Revision string `json:"revision,omitempty"`
	Writable bool   `json:"writable,omitempty"`
}

type FileWrite struct {
	Project  string `json:"project"`
	Path     string `json:"path"`
	Text     string `json:"text"`
	Revision string `json:"revision"`
}

// remoteWireGitFile is one changed path.
type GitFile struct {
	Path   string `json:"path"`
	Mark   string `json:"mark"`
	Staged bool   `json:"staged"`
}

// remoteWireCommit is one commit in the phone's history.
type Commit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	When    string `json:"when"`
}

// remoteWireGit is a project's repository as the phone shows it.
type Git struct {
	IsRepo   bool      `json:"isRepo"`
	Branch   string    `json:"branch,omitempty"`
	Upstream string    `json:"upstream,omitempty"`
	Ahead    int       `json:"ahead,omitempty"`
	Behind   int       `json:"behind,omitempty"`
	Branches []string  `json:"branches,omitempty"`
	Files    []GitFile `json:"files,omitempty"`
	Commits  []Commit  `json:"commits,omitempty"`
	Error    string    `json:"error,omitempty"`
}

// remoteWireHit is one message a search matched.
type Hit struct {
	Session string `json:"session"`
	Title   string `json:"title"`
	Project string `json:"project"`
	Snippet string `json:"snippet"`
}

// remoteWireModel is one model the phone can switch to.
type Model struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Reasoning bool   `json:"reasoning"`
}

// remoteWireOptions is a session's model and thinking choices, the backend
// it runs on, and what the composer can do with a draft.
type Options struct {
	Models   []Model  `json:"models"`
	Model    string   `json:"model"`
	Provider string   `json:"provider"`
	Thinking string   `json:"thinking"`
	Levels   []string `json:"levels"`
	Ready    bool     `json:"ready"`
	// Mode is the next turn's request, as Session.Mode spells it.
	Mode string `json:"mode,omitempty"`
	// Backend is the choice in force: "pi" or "acp:<preset>". It locks once
	// the session's first message fixes where its transcript lives.
	Backend       string    `json:"backend,omitempty"`
	BackendName   string    `json:"backendName,omitempty"`
	BackendLocked bool      `json:"backendLocked,omitempty"`
	Backends      []Backend `json:"backends,omitempty"`
	// Tools are the draft tools the desktop has a model for: "prompt"
	// rewrites the draft, "predict" continues it.
	Tools []string `json:"tools,omitempty"`
}

// remoteWireBackend is one place a session can run: pi, or an ACP preset
// the desktop has installed.
type Backend struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Detail string `json:"detail,omitempty"`
}

type Project struct {
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Target   string    `json:"target,omitempty"`
	Root     string    `json:"root,omitempty"`
	Sessions []Session `json:"sessions"`
}

type Session struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Updated  int64  `json:"updated"`
	External bool   `json:"external"`
	Pinned   bool   `json:"pinned"`
	Running  bool   `json:"running"`
	Ask      *Ask   `json:"ask,omitempty"`
	// Mode is what the next turn asks for: empty for a normal prompt, else
	// "plan", "goal" or "imagegen", as the desktop's composer names them.
	Mode string `json:"mode,omitempty"`
	// Tokens and context are what the phone shows above the composer.
	Tokens        int     `json:"tokens,omitempty"`
	Context       int     `json:"context,omitempty"`
	ContextWindow int     `json:"contextWindow,omitempty"`
	Cost          float64 `json:"cost,omitempty"`
}

// remoteWireAsk is a question the desktop is waiting on, so the phone can
// answer it instead of leaving the turn stuck.
type Ask struct {
	Method  string   `json:"method"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	Options []string `json:"options,omitempty"`
	// Questions is a batch ask: each one carries its own shape and choices,
	// so the phone shows the same card the desktop does.
	Questions []AskQuestion `json:"questions,omitempty"`
	// Review asks for a page of all answers before they are sent.
	Review bool `json:"review,omitempty"`
}

// AskQuestion is one question of a batch: what it asks, how it is answered,
// and the choices a select or multi_select offers.
type AskQuestion struct {
	ID          string      `json:"id"`
	Type        string      `json:"type"`
	Question    string      `json:"question"`
	Options     []AskOption `json:"options,omitempty"`
	AllowOther  bool        `json:"allowOther,omitempty"`
	Placeholder string      `json:"placeholder,omitempty"`
	Prefill     string      `json:"prefill,omitempty"`
}

// AskOption is one choice: what it shows, what it answers with, and the
// line under it.
type AskOption struct {
	Label       string `json:"label"`
	Value       string `json:"value,omitempty"`
	Description string `json:"description,omitempty"`
}

// AskAnswer is one question's answer travelling from the phone: the value
// the model receives, and whether the question was let go instead. Value is
// a string, a bool, or a list of strings, as the question's type says.
type AskAnswer struct {
	ID        string `json:"id"`
	Type      string `json:"type,omitempty"`
	Value     any    `json:"value,omitempty"`
	Label     string `json:"label,omitempty"`
	WasCustom bool   `json:"wasCustom,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
}

type Snapshot struct {
	Name     string    `json:"name"`
	Version  string    `json:"version"`
	Host     string    `json:"host"`
	Projects []Project `json:"projects"`
}

// VoiceRequest carries a recording the phone made to the desktop, which
// transcribes it: the audio as base64, mono 16-bit PCM WAV, and its format
// as the file says it.
type VoiceRequest struct {
	Format string `json:"format"`
	Data   string `json:"data"`
}

// VoiceText is the desktop's answer: what the recording said, empty when
// it held no speech.
type VoiceText struct {
	Text string `json:"text"`
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
	// Turn is the turn this line belongs to, counted from the session's
	// start. A client keeps the older pages it loaded by it while it
	// refreshes the newest one.
	Turn int `json:"turn,omitempty"`
	// Image is an opaque reference for the transcript attachment endpoint.
	Image string `json:"image,omitempty"`
	// Tool is what a "tool" line did, when the desktop knows more than the
	// line's words: its verb, its target, how it ended, and what it wrote.
	Tool *ToolLine `json:"tool,omitempty"`
}

// ToolLine is one tool call as the phone draws it: the same row the desktop
// shows, with the sizes the call cost and what it printed.
type ToolLine struct {
	// Name is the tool as pi spells it, so a client can draw its glyph.
	Name   string `json:"name,omitempty"`
	Action string `json:"action,omitempty"`
	Detail string `json:"detail,omitempty"`
	// Status is "running", "done" or "error".
	Status     string `json:"status,omitempty"`
	Added      int    `json:"added,omitempty"`
	Removed    int    `json:"removed,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	// Nested is how many calls the tool made itself.
	Nested int `json:"nested,omitempty"`
	// Output is what the call wrote, cut to what a page carries.
	Output string `json:"output,omitempty"`
}

type Transcript struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Running  bool      `json:"running"`
	Messages []Message `json:"messages"`
	Ask      *Ask      `json:"ask,omitempty"`
	Error    string    `json:"error,omitempty"`
	// Before is how many turns come before the first one sent: the client
	// asks for them with ?before=, so a long session pages instead of
	// losing its start.
	Before int `json:"before,omitempty"`
	// Truncated says one message was too big to send whole.
	Truncated bool `json:"truncated,omitempty"`
}

// remoteWireAgent is one way of working the phone can start a session with.
// The name and description come translated by the desktop, so the phone
// shows them in the language the desktop runs in.
type Agent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// remoteWireAgents is /api/agents' reply.
type Agents struct {
	Agents []Agent `json:"agents"`
}

// remoteWireTask is one cron task on the desktop, as the phone lists it.
type Task struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Prompt     string `json:"prompt,omitempty"`
	Project    string `json:"project,omitempty"`
	Cron       string `json:"cron"`
	Backend    string `json:"backend,omitempty"`
	Agent      string `json:"agent,omitempty"`
	Enabled    bool   `json:"enabled"`
	LastStatus string `json:"lastStatus,omitempty"`
	LastRunAt  int64  `json:"lastRunAt,omitempty"`
	NextRunAt  int64  `json:"nextRunAt,omitempty"`
	// SessionID is the session the newest run made, for a jump back.
	SessionID string `json:"sessionId,omitempty"`
}

// remoteWireTasks is /api/tasks' reply.
type Tasks struct {
	Tasks []Task `json:"tasks"`
}

// remoteWireFavorite is one saved answer or session reference.
type Favorite struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	SessionID    string `json:"sessionId,omitempty"`
	SessionTitle string `json:"sessionTitle,omitempty"`
	Project      string `json:"project,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
	Text         string `json:"text,omitempty"`
	CreatedAt    int64  `json:"createdAt,omitempty"`
}

// remoteWireFavorites is /api/favorites' reply.
type Favorites struct {
	Favorites []Favorite `json:"favorites"`
}

// ReviewItem is one pull request or issue as the phone lists it.
type ReviewItem struct {
	Kind    string   `json:"kind"`
	Number  int      `json:"number"`
	Title   string   `json:"title"`
	State   string   `json:"state"`
	Draft   bool     `json:"draft,omitempty"`
	Author  string   `json:"author,omitempty"`
	Branch  string   `json:"branch,omitempty"`
	Base    string   `json:"base,omitempty"`
	Review  string   `json:"review,omitempty"`
	Checks  string   `json:"checks,omitempty"`
	Adds    int      `json:"adds,omitempty"`
	Deletes int      `json:"deletes,omitempty"`
	Labels  []string `json:"labels,omitempty"`
	URL     string   `json:"url,omitempty"`
	Reason  string   `json:"reason,omitempty"`
	// Updated is the last change, in Unix milliseconds.
	Updated int64 `json:"updated,omitempty"`
}

// ReviewList is /api/review's reply: the rows, and why there are none.
type ReviewList struct {
	Repo    string       `json:"repo,omitempty"`
	Items   []ReviewItem `json:"items"`
	Missing bool         `json:"missing,omitempty"`
	Error   string       `json:"error,omitempty"`
}

// ReviewComment is one entry of a conversation.
type ReviewComment struct {
	Author string `json:"author"`
	Body   string `json:"body"`
	Kind   string `json:"kind"`
	State  string `json:"state,omitempty"`
	// At is when it was written, in Unix milliseconds.
	At int64 `json:"at,omitempty"`
}

// ReviewCheck is one check run or status context.
type ReviewCheck struct {
	Name  string `json:"name"`
	State string `json:"state"`
	URL   string `json:"url,omitempty"`
}

// ReviewFile is one changed path with its line counts.
type ReviewFile struct {
	Path    string `json:"path"`
	Adds    int    `json:"adds"`
	Deletes int    `json:"deletes"`
}

// ReviewDetail is /api/review/detail's reply.
type ReviewDetail struct {
	Item     ReviewItem      `json:"item"`
	Body     string          `json:"body,omitempty"`
	Merge    string          `json:"merge,omitempty"`
	Comments []ReviewComment `json:"comments,omitempty"`
	Checks   []ReviewCheck   `json:"checks,omitempty"`
	Files    []ReviewFile    `json:"files,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// ReviewEvaluation is /api/review/evaluate's reply: the session the
// desktop started, so the phone can read the answer where it lands.
type ReviewEvaluation struct {
	Session string `json:"session,omitempty"`
	Error   string `json:"error,omitempty"`
}
