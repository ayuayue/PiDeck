package main

// promptImage is an image sent with a prompt: the workbench attaches one,
// the client sends it to its desktop.

// promptImage is an image sent with a prompt.
type promptImage struct {
	Data     []byte
	MimeType string
	Name     string
}
