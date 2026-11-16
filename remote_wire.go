package main

// The desktop's HTTP API and the phone and browser clients it serves share
// these shapes: remote.go fills them, remote_client.go and mobile.go read
// them. They live here, apart from the server, so a browser build that has
// no server still knows what it receives.

// remoteWireFile is one file in a project's list.
type remoteWireFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// remoteWireGitFile is one changed path.
type remoteWireGitFile struct {
	Path   string `json:"path"`
	Mark   string `json:"mark"`
	Staged bool   `json:"staged"`
}

// remoteWireCommit is one commit in the phone's history.
type remoteWireCommit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	When    string `json:"when"`
}

// remoteWireGit is a project's repository as the phone shows it.
type remoteWireGit struct {
	IsRepo   bool                `json:"isRepo"`
	Branch   string              `json:"branch,omitempty"`
	Upstream string              `json:"upstream,omitempty"`
	Ahead    int                 `json:"ahead,omitempty"`
	Behind   int                 `json:"behind,omitempty"`
	Branches []string            `json:"branches,omitempty"`
	Files    []remoteWireGitFile `json:"files,omitempty"`
	Commits  []remoteWireCommit  `json:"commits,omitempty"`
	Error    string              `json:"error,omitempty"`
}

// remoteWireHit is one message a search matched.
type remoteWireHit struct {
	Session string `json:"session"`
	Title   string `json:"title"`
	Project string `json:"project"`
	Snippet string `json:"snippet"`
}

// remoteWireModel is one model the phone can switch to.
type remoteWireModel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Reasoning bool   `json:"reasoning"`
}

// remoteWireOptions is a session's model and thinking choices.
type remoteWireOptions struct {
	Models   []remoteWireModel `json:"models"`
	Model    string            `json:"model"`
	Provider string            `json:"provider"`
	Thinking string            `json:"thinking"`
	Levels   []string          `json:"levels"`
	Ready    bool              `json:"ready"`
}

type remoteWireProject struct {
	Path     string              `json:"path"`
	Name     string              `json:"name"`
	Sessions []remoteWireSession `json:"sessions"`
}

type remoteWireSession struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Status   string         `json:"status"`
	Updated  int64          `json:"updated"`
	External bool           `json:"external"`
	Pinned   bool           `json:"pinned"`
	Running  bool           `json:"running"`
	Ask      *remoteWireAsk `json:"ask,omitempty"`
	// Tokens and context are what the phone shows above the composer.
	Tokens        int     `json:"tokens,omitempty"`
	Context       int     `json:"context,omitempty"`
	ContextWindow int     `json:"contextWindow,omitempty"`
	Cost          float64 `json:"cost,omitempty"`
}

// remoteWireAsk is a question the desktop is waiting on, so the phone can
// answer it instead of leaving the turn stuck.
type remoteWireAsk struct {
	Method  string   `json:"method"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	Options []string `json:"options,omitempty"`
}

type remoteWireSnapshot struct {
	Name     string              `json:"name"`
	Version  string              `json:"version"`
	Host     string              `json:"host"`
	Projects []remoteWireProject `json:"projects"`
}

type remoteWireMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type remoteWireTranscript struct {
	ID       string              `json:"id"`
	Title    string              `json:"title"`
	Running  bool                `json:"running"`
	Messages []remoteWireMessage `json:"messages"`
	Ask      *remoteWireAsk      `json:"ask,omitempty"`
	Error    string              `json:"error,omitempty"`
}
