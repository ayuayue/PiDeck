package remotewire

// Command is an executable slash command, without a leading slash or local paths.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source,omitempty"`
}

// Commands is the optional command-discovery endpoint's reply.
type Commands struct {
	Commands []Command `json:"commands"`
}

// SessionRef links to a visible session without exposing its transcript path.
type SessionRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state,omitempty"`
}

// Delegation is a subagent or workflow activity projected from session history.
type Delegation struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state"`
	Turn  int    `json:"turn"`
}

// SessionActivity is optional, so older desktops and clients remain compatible.
type SessionActivity struct {
	Parent      *SessionRef  `json:"parent,omitempty"`
	Children    []SessionRef `json:"children,omitempty"`
	Delegations []Delegation `json:"delegations,omitempty"`
}
