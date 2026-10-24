// Package web holds the browser-side patch that points RTCPeerConnection at
// the relay. client.js is the single source; the Node package copies it.
package web

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed client.js
var clientJS string

// ConfigPlaceholder is replaced with the JSON ICE config when serving.
const ConfigPlaceholder = "/*__DLPCC_CONFIG__*/null"

// ClientScript returns client.js with config baked in. encoding/json escapes
// <, > and &, so the result is also safe to inline in a <script> tag.
func ClientScript(config any) ([]byte, error) {
	b, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	return []byte(strings.Replace(clientJS, ConfigPlaceholder, string(b), 1)), nil
}
