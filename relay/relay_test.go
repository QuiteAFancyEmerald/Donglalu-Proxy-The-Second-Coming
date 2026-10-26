package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
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
	}, extra...)
	cfg, err := Load(args)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// nodeCredential signs a credential the way src/index.ts does, so these
// tests break if the two sides stop agreeing on the format.
func nodeCredential(secret string, ttl time.Duration) (user, pass string) {
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	user = fmt.Sprintf("%d:%s", time.Now().Add(ttl).Unix(), hex.EncodeToString(id))
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(user))
	return user, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func startServer(t *testing.T, extra ...string) *Config {
	t.Helper()
	cfg := testConfig(t, extra...)
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
	t.Cleanup(func() { _ = srv.Close() })
	return cfg
}

// dial connects a TURN client over TCP, the path a browser takes once nginx
// has stripped TLS.
func dial(t *testing.T, cfg *Config, user, pass string) *turn.Client {
	t.Helper()
	conn, err := net.DialTimeout("tcp", cfg.TURNListen, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: cfg.TURNListen,
		TURNServerAddr: cfg.TURNListen,
		Conn:           turn.NewSTUNConn(conn),
		Username:       user,
		Password:       pass,
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
	return c
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
		"203.0.113.9": true, // the relay itself; selfConn limits it to relay ports
	} {
		if got := cfg.peerAllowed(net.ParseIP(ip)); got != want {
			t.Errorf("peerAllowed(%s) = %v, want %v", ip, got, want)
		}
	}

	cfg.AllowPrivatePeers = true
	cfg.DenyPeers, _ = parseCIDRs("10.9.0.0/16")
	if !cfg.peerAllowed(net.ParseIP("127.0.0.1")) || !cfg.peerAllowed(net.ParseIP("203.0.113.9")) {
		t.Error("allow-private-peers didn't lift the built-in block")
	}
	if cfg.peerAllowed(net.ParseIP("10.9.1.1")) {
		t.Error("deny-peers not enforced with allow-private-peers")
	}
	cfg.AllowPrivatePeers, cfg.DenyPeers = false, nil

	cfg.AllowPeers, _ = parseCIDRs("8.8.8.0/24")
	if cfg.peerAllowed(net.ParseIP("1.1.1.1")) || !cfg.peerAllowed(net.ParseIP("8.8.8.8")) {
		t.Error("allow-peers not enforced")
	}
}

func TestAuth(t *testing.T) {
	cfg := startServer(t, "-max-allocs-per-user", "1")
	user, pass := nodeCredential(cfg.Secret, time.Hour)

	if _, err := dial(t, cfg, user, "wrong").Allocate(); err == nil {
		t.Fatal("allocation succeeded with a bad password")
	}
	expiredUser, expiredPass := nodeCredential(cfg.Secret, -time.Minute)
	if _, err := dial(t, cfg, expiredUser, expiredPass).Allocate(); err == nil {
		t.Fatal("allocation succeeded with an expired credential")
	}
	if _, err := dial(t, cfg, user, pass).Allocate(); err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := dial(t, cfg, user, pass).Allocate(); err == nil {
		t.Fatal("per-user allocation limit not enforced")
	}
}

// TestRelay sends data through an allocation to a UDP peer and back. The
// payloads are packet sized on purpose: pion's TCP framer stalls on
// ChannelData under 5 bytes, which real media never is.
func TestRelay(t *testing.T) {
	cfg := startServer(t)

	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

	// The peer has to live on loopback here, which the filter normally
	// refuses. Lift it for this test only; TestPeerFilter covers it.
	saved := blockedPeers
	blockedPeers = nil
	cfg.RelayIP = net.IPv4(192, 0, 2, 1)
	defer func() { blockedPeers = saved }()

	user, pass := nodeCredential(cfg.Secret, time.Hour)
	relayConn, err := dial(t, cfg, user, pass).Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relayConn.Close()

	ping, pong := bytes.Repeat([]byte("i"), 200), bytes.Repeat([]byte("o"), 200)
	if _, err := relayConn.WriteTo(ping, peer.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1500)
	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, from, err := peer.ReadFrom(buf)
	if err != nil || !bytes.Equal(buf[:n], ping) {
		t.Fatalf("peer got %d bytes, %v", n, err)
	}

	// Reply several times so both return paths get used: a Data indication
	// before the client's channel bind lands, ChannelData after.
	for i := 0; i < 5; i++ {
		if _, err := peer.WriteTo(pong, from); err != nil {
			t.Fatal(err)
		}
		_ = relayConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if n, _, err = relayConn.ReadFrom(buf); err != nil || !bytes.Equal(buf[:n], pong) {
			t.Fatalf("reply %d: client got %d bytes, %v", i, n, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestSelfRelay has two clients of the same relay talk through their relay
// addresses, as two people behind one proxy would in a call, and checks
// nothing else on the relay's own IP is reachable.
func TestSelfRelay(t *testing.T) {
	cfg := startServer(t, "-relay-ports", "50400-50420")
	user, pass := nodeCredential(cfg.Secret, time.Hour)
	a, err := dial(t, cfg, user, pass).Allocate()
	if err != nil {
		t.Fatalf("allocate a: %v", err)
	}
	defer a.Close()
	b, err := dial(t, cfg, user, pass).Allocate()
	if err != nil {
		t.Fatalf("allocate b: %v", err)
	}
	defer b.Close()

	// Permissions are per IP and both relays share one, so a write each way
	// opens both; the first can be lost before b's permission exists.
	msg := bytes.Repeat([]byte("x"), 200)
	buf := make([]byte, 1500)
	if _, err := a.WriteTo(msg, b.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if _, err := b.WriteTo(msg, a.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	if n, _, err := a.ReadFrom(buf); err != nil || !bytes.Equal(buf[:n], msg) {
		t.Fatalf("a got %d bytes, %v", n, err)
	}
	if _, err := a.WriteTo(msg, b.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	_ = b.SetReadDeadline(time.Now().Add(2 * time.Second))
	if n, _, err := b.ReadFrom(buf); err != nil || !bytes.Equal(buf[:n], msg) {
		t.Fatalf("b got %d bytes, %v", n, err)
	}

	// A service on the relay's IP outside the relay range stays unreachable.
	other, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := a.WriteTo(msg, other.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	_ = other.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, _, err := other.ReadFrom(buf); err == nil {
		t.Fatalf("non-relay port on the relay IP got %d bytes", n)
	}
}
