package remotewire

// MaxTranscriptImageBytes bounds one attachment fetched separately from a page.
const MaxTranscriptImageBytes = 6 << 20

// Image is an image sent with a prompt or found in a transcript.
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
