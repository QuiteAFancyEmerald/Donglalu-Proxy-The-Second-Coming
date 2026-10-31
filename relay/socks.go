package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/pion/turn/v4"
)

// socksProxy is an upstream SOCKS5 proxy that relayed media leaves through,
// so peers see the proxy's address instead of the server's. It has to
// support UDP ASSOCIATE; most proxies only do TCP.
type socksProxy struct {
	Addr string // host:port
	User string
	Pass string
}

func parseSocksProxy(s string) (*socksProxy, error) {
	if s == "" {
		return nil, nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return nil, fmt.Errorf("%q must start with socks5://", s)
	}
	if u.Hostname() == "" || u.Port() == "" {
		return nil, fmt.Errorf("%q needs a host and port", s)
	}
	p := &socksProxy{Addr: u.Host}
	if u.User != nil {
		p.User = u.User.Username()
		p.Pass, _ = u.User.Password()
	}
	return p, nil
}

const socksTimeout = 10 * time.Second

// associate opens a UDP association: the control connection that keeps it
// alive, and the proxy's UDP address to send datagrams to.
func (p *socksProxy) associate() (net.Conn, *net.UDPAddr, error) {
	ctrl, err := net.DialTimeout("tcp", p.Addr, socksTimeout)
	if err != nil {
		return nil, nil, err
	}
	_ = ctrl.SetDeadline(time.Now().Add(socksTimeout))
	relay, err := p.handshake(ctrl)
	if err != nil {
		_ = ctrl.Close()
		return nil, nil, fmt.Errorf("socks5 %s: %w", p.Addr, err)
	}
	_ = ctrl.SetDeadline(time.Time{})
	// A proxy that answers 0.0.0.0 or a private address means "the address
	// you reached me on".
	if relay.IP.IsUnspecified() || containsIP(blockedPeers, relay.IP) {
		relay.IP = ctrl.RemoteAddr().(*net.TCPAddr).IP
	}
	return ctrl, relay, nil
}

func (p *socksProxy) handshake(c net.Conn) (*net.UDPAddr, error) {
	methods := []byte{5, 1, 0}
	if p.User != "" {
		methods = []byte{5, 2, 0, 2}
	}
	if _, err := c.Write(methods); err != nil {
		return nil, err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil {
		return nil, err
	}
	switch reply[1] {
	case 0:
	case 2:
		if p.User == "" {
			return nil, errors.New("proxy wants a username and password")
		}
		auth := append([]byte{1, byte(len(p.User))}, p.User...)
		auth = append(append(auth, byte(len(p.Pass))), p.Pass...)
		if _, err := c.Write(auth); err != nil {
			return nil, err
		}
		if _, err := io.ReadFull(c, reply); err != nil {
			return nil, err
		}
		if reply[1] != 0 {
			return nil, errors.New("username or password rejected")
		}
	default:
		return nil, errors.New("proxy refused every auth method; is this server's IP whitelisted?")
	}

	// UDP ASSOCIATE from 0.0.0.0:0: we can't know the address NAT gives us.
	if _, err := c.Write([]byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return nil, err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		return nil, err
	}
	if head[1] != 0 {
		return nil, fmt.Errorf("UDP ASSOCIATE refused (reply %d); the proxy may not support UDP", head[1])
	}
	addr, err := readSocksAddr(c, head[3])
	if err != nil {
		return nil, err
	}
	return addr, nil
}

func readSocksAddr(r io.Reader, atyp byte) (*net.UDPAddr, error) {
	var ip []byte
	switch atyp {
	case 1:
		ip = make([]byte, 4)
	case 4:
		ip = make([]byte, 16)
	case 3:
		n := make([]byte, 1)
		if _, err := io.ReadFull(r, n); err != nil {
			return nil, err
		}
		name := make([]byte, n[0]+2)
		if _, err := io.ReadFull(r, name); err != nil {
			return nil, err
		}
		ips, err := net.LookupIP(string(name[:n[0]]))
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("can't resolve proxy relay %q", name[:n[0]])
		}
		return &net.UDPAddr{IP: ips[0], Port: int(binary.BigEndian.Uint16(name[n[0]:]))}, nil
	default:
		return nil, fmt.Errorf("unknown address type %d", atyp)
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(r, ip); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(r, port); err != nil {
		return nil, err
	}
	return &net.UDPAddr{IP: ip, Port: int(binary.BigEndian.Uint16(port))}, nil
}

// socksGenerator gives every allocation its own UDP association. The local
// socket still comes from the relay port range, so the firewall rules for
// relayed media cover the proxy's replies too.
type socksGenerator struct {
	turn.RelayAddressGenerator
	proxy *socksProxy
}

func (g socksGenerator) AllocatePacketConn(network string, _ int) (net.PacketConn, net.Addr, error) {
	local, _, err := g.RelayAddressGenerator.AllocatePacketConn(network, 0)
	if err != nil {
		return nil, nil, err
	}
	ctrl, relay, err := g.proxy.associate()
	if err != nil {
		_ = local.Close()
		// pion only logs this at debug, and it's the one thing to fix.
		log.Printf("dlpcc-relay: upstream proxy: %v", err)
		return nil, nil, err
	}
	c := &socksConn{PacketConn: local, ctrl: ctrl, relay: relay}
	// The association ends with its control connection. Closing the socket
	// then makes pion drop the allocation instead of relaying into nothing.
	go func() {
		_, _ = io.Copy(io.Discard, ctrl)
		_ = c.Close()
	}()
	return c, relay, nil
}

// socksConn wraps each datagram in the SOCKS5 UDP header on the way out and
// unwraps it on the way in.
type socksConn struct {
	net.PacketConn
	ctrl  net.Conn
	relay *net.UDPAddr
	once  sync.Once
	buf   []byte // pion reads each allocation from one goroutine
}

func (c *socksConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	u, ok := addr.(*net.UDPAddr)
	if !ok {
		return 0, fmt.Errorf("socks5: unsupported address %v", addr)
	}
	var head []byte
	if ip4 := u.IP.To4(); ip4 != nil {
		head = append([]byte{0, 0, 0, 1}, ip4...)
	} else {
		head = append([]byte{0, 0, 0, 4}, u.IP.To16()...)
	}
	head = binary.BigEndian.AppendUint16(head, uint16(u.Port))
	if _, err := c.PacketConn.WriteTo(append(head, p...), c.relay); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *socksConn) ReadFrom(p []byte) (int, net.Addr, error) {
	if len(c.buf) < len(p)+22 { // room for the largest (IPv6) header
		c.buf = make([]byte, len(p)+22)
	}
	buf := c.buf
	for {
		n, from, err := c.PacketConn.ReadFrom(buf)
		if err != nil {
			return 0, nil, err
		}
		// Only the proxy speaks on this socket; anything else is noise, as
		// are fragments, which no proxy we'd use sends.
		if u, ok := from.(*net.UDPAddr); !ok || !u.IP.Equal(c.relay.IP) || u.Port != c.relay.Port {
			continue
		}
		if n < 4 || buf[2] != 0 {
			continue
		}
		var src *net.UDPAddr
		var body []byte
		switch {
		case buf[3] == 1 && n >= 10:
			src = &net.UDPAddr{IP: net.IP(append([]byte(nil), buf[4:8]...)), Port: int(binary.BigEndian.Uint16(buf[8:10]))}
			body = buf[10:n]
		case buf[3] == 4 && n >= 22:
			src = &net.UDPAddr{IP: net.IP(append([]byte(nil), buf[4:20]...)), Port: int(binary.BigEndian.Uint16(buf[20:22]))}
			body = buf[22:n]
		default:
			continue
		}
		return copy(p, body), src, nil
	}
}

func (c *socksConn) Close() error {
	var err error
	c.once.Do(func() {
		_ = c.ctrl.Close()
		err = c.PacketConn.Close()
	})
	return err
}
