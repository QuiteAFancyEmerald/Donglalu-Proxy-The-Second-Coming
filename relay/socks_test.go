package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

// fakeSocks is just enough of a SOCKS5 proxy with UDP ASSOCIATE to relay
// datagrams, with optional username/password auth.
func fakeSocks(t *testing.T, user, pass string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serveSocks(c, user, pass)
		}
	}()
	return ln.Addr().String()
}

func serveSocks(c net.Conn, user, pass string) {
	defer c.Close()
	head := make([]byte, 2)
	if _, err := io.ReadFull(c, head); err != nil {
		return
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	if user == "" {
		_, _ = c.Write([]byte{5, 0})
	} else {
		if !bytes.Contains(methods, []byte{2}) {
			_, _ = c.Write([]byte{5, 0xff})
			return
		}
		_, _ = c.Write([]byte{5, 2})
		got := make([]byte, 2)
		_, _ = io.ReadFull(c, got)
		u := make([]byte, got[1])
		_, _ = io.ReadFull(c, u)
		_, _ = io.ReadFull(c, got[:1])
		p := make([]byte, got[0])
		_, _ = io.ReadFull(c, p)
		if string(u) != user || string(p) != pass {
			_, _ = c.Write([]byte{1, 1})
			return
		}
		_, _ = c.Write([]byte{1, 0})
	}
	req := make([]byte, 10)
	if _, err := io.ReadFull(c, req); err != nil || req[1] != 3 {
		return
	}
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		return
	}
	defer udp.Close()
	port := udp.LocalAddr().(*net.UDPAddr).Port
	_, _ = c.Write(binary.BigEndian.AppendUint16([]byte{5, 0, 0, 1, 127, 0, 0, 1}, uint16(port)))

	go func() {
		var client net.Addr
		buf := make([]byte, 2048)
		for {
			n, from, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			// The first sender is the client; the relay always speaks first.
			if client == nil {
				client = from
			}
			if from.String() == client.String() {
				dst := &net.UDPAddr{IP: net.IP(buf[4:8]), Port: int(binary.BigEndian.Uint16(buf[8:10]))}
				_, _ = udp.WriteTo(buf[10:n], dst)
				continue
			}
			src := from.(*net.UDPAddr)
			out := append([]byte{0, 0, 0, 1}, src.IP.To4()...)
			out = binary.BigEndian.AppendUint16(out, uint16(src.Port))
			_, _ = udp.WriteTo(append(out, buf[:n]...), client)
		}
	}()
	_, _ = io.Copy(io.Discard, c) // the association lives as long as this
}

func TestParseSocksProxy(t *testing.T) {
	p, err := parseSocksProxy("socks5://alice:s3cret@203.0.113.5:1080")
	if err != nil || p.Addr != "203.0.113.5:1080" || p.User != "alice" || p.Pass != "s3cret" {
		t.Fatalf("got %+v, %v", p, err)
	}
	if p, err := parseSocksProxy(""); p != nil || err != nil {
		t.Fatalf("empty: got %+v, %v", p, err)
	}
	for _, bad := range []string{"http://203.0.113.5:1080", "socks5://203.0.113.5", "203.0.113.5:1080"} {
		if _, err := parseSocksProxy(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// TestUpstreamProxy relays through a SOCKS5 proxy: the peer has to see the
// proxy's address, the client gets that address as its relay, and replies
// find their way back.
func TestUpstreamProxy(t *testing.T) {
	proxy := fakeSocks(t, "alice", "s3cret")
	cfg := startServer(t, "-upstream-proxy", "socks5://alice:s3cret@"+proxy)

	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

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
	if from.String() != relayConn.LocalAddr().String() {
		t.Fatalf("peer saw %v, client was told its relay is %v", from, relayConn.LocalAddr())
	}

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

func TestUpstreamProxyAuth(t *testing.T) {
	proxy := fakeSocks(t, "alice", "s3cret")
	for _, url := range []string{"socks5://" + proxy, "socks5://alice:wrong@" + proxy} {
		p, _ := parseSocksProxy(url)
		if _, _, err := p.associate(); err == nil {
			t.Errorf("%s: associate succeeded", url)
		}
	}
	p, _ := parseSocksProxy("socks5://alice:s3cret@" + proxy)
	ctrl, relay, err := p.associate()
	if err != nil {
		t.Fatal(err)
	}
	defer ctrl.Close()
	if !relay.IP.Equal(net.IPv4(127, 0, 0, 1)) || relay.Port == 0 {
		t.Fatalf("relay address %v", relay)
	}
}
