package remotewire

// promptImage is an image sent with a prompt: the workbench attaches one,
// the client sends it to its desktop.

// promptImage is an image sent with a prompt.
type Image struct {
	Data     []byte
	MimeType string
	Name     string
}
