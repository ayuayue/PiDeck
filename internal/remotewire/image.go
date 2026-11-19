package remotewire

// promptImage is an image sent with a prompt: the workbench attaches one,
// the client sends it to its desktop.

// promptImage is an image sent with a prompt.
type Image struct {
	Data     []byte
	MimeType string
	Name     string
}

// Picture is one picture the desktop generated for the phone, with its
// bytes base64-encoded because the reply is JSON.
type Picture struct {
	Mime string `json:"mime"`
	Data string `json:"data"`
}

// Pictures is the reply of a generation: the pictures, or why there are
// none.
type Pictures struct {
	Images []Picture `json:"images,omitempty"`
	Error  string    `json:"error,omitempty"`
}
