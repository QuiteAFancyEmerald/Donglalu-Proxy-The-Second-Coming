package relay

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/pion/turn/v4"
)

// ICEServer and ICEConfig mirror the browser's RTCIceServer/RTCConfiguration.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type ICEConfig struct {
	IceServers         []ICEServer `json:"iceServers"`
	IceTransportPolicy string      `json:"iceTransportPolicy,omitempty"`
	Expires            int64       `json:"expires"`
}

var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

// NormalizeHost strips any port from a Host header value and checks it
// against the configured allowlist.
func (c *Config) NormalizeHost(raw string) (string, error) {
	host := strings.ToLower(strings.TrimSpace(raw))
	if i := strings.LastIndexByte(host, ':'); i != -1 && !strings.Contains(host[i:], "]") {
		host = host[:i]
	}
	if !hostPattern.MatchString(host) {
		return "", fmt.Errorf("invalid host %q", raw)
	}
	if len(c.Hosts) == 0 {
		return host, nil
	}
	for _, allowed := range c.Hosts {
		if allowed == host || (strings.HasPrefix(allowed, "*.") && strings.HasSuffix(host, allowed[1:])) {
			return host, nil
		}
	}
	return "", fmt.Errorf("host %q is not in the allowlist", host)
}

// ICEFor issues a fresh time-limited credential pointing at host. The TURN
// URL reuses the hostname the visitor already reached, so every mirror gets
// a working relay without its own DNS record or certificate.
func (c *Config) ICEFor(host string) (ICEConfig, error) {
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		return ICEConfig{}, err
	}
	username, password, err := turn.GenerateLongTermTURNRESTCredentials(c.Secret, hex.EncodeToString(id), c.TTL)
	if err != nil {
		return ICEConfig{}, err
	}
	expires, _ := strconv.ParseInt(strings.SplitN(username, ":", 2)[0], 10, 64)

	cfg := ICEConfig{
		IceServers: []ICEServer{{
			URLs:       []string{fmt.Sprintf("turns:%s:%d?transport=tcp", host, c.PublicPort)},
			Username:   username,
			Credential: password,
		}},
		Expires: expires,
	}
	if c.ForceRelay {
		cfg.IceTransportPolicy = "relay"
	}
	return cfg, nil
}
