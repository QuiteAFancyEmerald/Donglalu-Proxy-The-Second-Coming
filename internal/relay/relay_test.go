package relay

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

func testConfig(t *testing.T, extra ...string) *Config {
	t.Helper()
	args := append([]string{
		"-secret", "test-secret",
		"-relay-ip", "127.0.0.1",
		"-relay-bind", "127.0.0.1",
		"-turn-listen", "127.0.0.1:0",
		"-http-listen", "",
	}, extra...)
	cfg, err := Load(args)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestPeerFilter(t *testing.T) {
	cfg := testConfig(t, "-relay-ip", "203.0.113.9")
	for ip, want := range map[string]bool{
		"8.8.8.8":     true,
		"127.0.0.1":   false,
		"10.1.2.3":    false,
		"192.168.1.1": false,
		"100.64.0.1":  false,
		"169.254.1.1": false,
		"fd00::1":     false,
		"2606:4700::": true,
	} {
		if got := cfg.peerAllowed(net.ParseIP(ip)); got != want {
			t.Errorf("peerAllowed(%s) = %v, want %v", ip, got, want)
		}
	}

	cfg.AllowPeers, _ = parseCIDRs("8.8.8.0/24")
	if cfg.peerAllowed(net.ParseIP("1.1.1.1")) || !cfg.peerAllowed(net.ParseIP("8.8.8.8")) {
		t.Error("allow-peers not enforced")
	}
}

func TestNormalizeHost(t *testing.T) {
	cfg := testConfig(t)
	if h, err := cfg.NormalizeHost("Mirror.Example.com:443"); err != nil || h != "mirror.example.com" {
		t.Errorf("got %q, %v", h, err)
	}
	if _, err := cfg.NormalizeHost(`evil"host`); err == nil {
		t.Error("accepted invalid host")
	}

	cfg.Hosts = []string{"*.example.com", "example2.com"}
	for host, ok := range map[string]bool{"a.example.com": true, "example2.com": true, "example.com": false, "badexample.com": false} {
		if _, err := cfg.NormalizeHost(host); (err == nil) != ok {
			t.Errorf("NormalizeHost(%s) err=%v, want ok=%v", host, err, ok)
		}
	}
}

func TestClientScriptEndpoint(t *testing.T) {
	cfg := testConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/dlpcc/client.js", nil)
	req.Header.Set("X-Forwarded-Host", "mirror.example.com")
	rec := httptest.NewRecorder()
	Handler(cfg).ServeHTTP(rec, req)

	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, `turns:mirror.example.com:443?transport=tcp`) {
		t.Fatalf("status %d body %s", rec.Code, body)
	}
	if strings.Contains(body, "__DLPCC_CONFIG__") {
		t.Error("placeholder was not replaced")
	}
}

// TestAllocate runs a real TURN client over TCP against the server using a
// credential from the ICE endpoint, the same path a browser takes after
// nginx strips TLS.
func TestAllocate(t *testing.T) {
	cfg := testConfig(t, "-max-allocs-per-user", "1")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg.TURNListen = ln.Addr().String()
	_ = ln.Close()

	srv, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	rec := httptest.NewRecorder()
	Handler(cfg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://mirror.example.com/dlpcc/ice", nil))
	var ice ICEConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &ice); err != nil {
		t.Fatal(err)
	}
	user, pass := ice.IceServers[0].Username, ice.IceServers[0].Credential

	dial := func(password string) (*turn.Client, error) {
		conn, err := net.DialTimeout("tcp", cfg.TURNListen, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		c, err := turn.NewClient(&turn.ClientConfig{
			STUNServerAddr: cfg.TURNListen,
			TURNServerAddr: cfg.TURNListen,
			Conn:           turn.NewSTUNConn(conn),
			Username:       user,
			Password:       password,
			Realm:          cfg.Realm,
			RTO:            200 * time.Millisecond,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Listen(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(c.Close)
		_, err = c.Allocate()
		return c, err
	}

	if _, err := dial("wrong"); err == nil {
		t.Fatal("allocation succeeded with a bad password")
	}
	if _, err := dial(pass); err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := dial(pass); err == nil {
		t.Fatal("per-user allocation limit not enforced")
	}
}
