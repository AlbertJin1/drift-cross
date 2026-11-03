// Drift VPN Gate userspace OpenVPN-to-SOCKS5 bridge.
//
// This executable is deliberately a browser proxy, not a system VPN client.
// The OpenVPN tunnel and gVisor TCP/IP stack live inside this process; the only
// host socket it exposes is a SOCKS5 listener bound to 127.0.0.1. It never opens
// a TUN/TAP device or changes host routes, DNS settings, or firewall rules.
//
// The OpenVPN protocol implementation is github.com/buengese/go-openvpn. See
// the matching source archive and LGPL-2.1-or-later usage exception shipped
// with Drift for the exact third-party source and notices.
package main

import (
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	vpn "github.com/buengese/go-openvpn"
	"github.com/buengese/go-openvpn/netstack"
	"github.com/buengese/go-openvpn/profile"
)

const (
	socksVersion = 5
	methodNoAuth = 0
	cmdConnect   = 1
	atypIPv4     = 1
	atypDomain   = 3
	atypIPv6     = 4
)

func main() {
	configPath := flag.String("config", "", "path to a sanitized OpenVPN client profile")
	listenAddress := flag.String("listen", "127.0.0.1:0", "loopback SOCKS5 listen address")
	connectTimeout := flag.Duration("connect-timeout", 60*time.Second, "maximum time allowed for the OpenVPN handshake")
	flag.Parse()

	if *configPath == "" {
		fatalf("config", "-config is required")
	}
	if err := validateLoopbackListen(*listenAddress); err != nil {
		fatalf("config", "%v", err)
	}

	prof, err := profile.ParsePath(*configPath)
	if err != nil {
		fatalf("profile", "%v", err)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	connectCtx, cancelConnect := context.WithTimeout(rootCtx, *connectTimeout)
	tunnel, err := netstack.Connect(connectCtx, prof, netstack.Options{
		// VPN Gate's public OpenVPN profiles request the shared credentials
		// documented by VPN Gate itself. This callback is used only when the
		// selected profile includes auth-user-pass.
		CredentialsFn: func(context.Context) (vpn.Credentials, error) {
			return vpn.Credentials{Username: "vpn", Password: "vpn"}, nil
		},
	})
	cancelConnect()
	if err != nil {
		fatalf("openvpn dial", "%v", err)
	}
	defer tunnel.Close()

	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		fatalf("socks5", "could not bind loopback proxy: %v", err)
	}
	defer listener.Close()

	bound, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !bound.IP.IsLoopback() {
		fatalf("socks5", "refusing to expose a non-loopback proxy listener")
	}
	// Drift's main process waits for this exact line before it applies the
	// SOCKS proxy to its Electron session and verifies the VPN exit address.
	fmt.Printf("SOCKS5 listening addr=%s\n", listener.Addr().String())

	go func() {
		<-rootCtx.Done()
		_ = listener.Close()
	}()

	for {
		client, acceptErr := listener.Accept()
		if acceptErr != nil {
			if rootCtx.Err() != nil || errors.Is(acceptErr, net.ErrClosed) {
				return
			}
			fmt.Fprintf(os.Stderr, "warning: SOCKS5 accept failed: %v\n", acceptErr)
			continue
		}
		go handleSOCKS5(rootCtx, client, tunnel)
	}
}

func validateLoopbackListen(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid -listen address: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("SOCKS5 must bind to a loopback IP (127.0.0.1 or ::1)")
	}
	if ip.To4() == nil || !ip.To4().Equal(net.ParseIP("127.0.0.1")) {
		return fmt.Errorf("Drift currently requires the IPv4 loopback SOCKS5 address 127.0.0.1")
	}
	return nil
}

func handleSOCKS5(ctx context.Context, client net.Conn, tunnel *netstack.Tunnel) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(20 * time.Second))
	reader := client

	// RFC 1928 method negotiation. The listener is reachable only from this
	// machine and is intentionally configured for no-authentication SOCKS5.
	var hello [2]byte
	if _, err := io.ReadFull(reader, hello[:]); err != nil || hello[0] != socksVersion || hello[1] == 0 {
		return
	}
	methods := make([]byte, int(hello[1]))
	if _, err := io.ReadFull(reader, methods); err != nil {
		return
	}
	noAuth := false
	for _, method := range methods {
		if method == methodNoAuth {
			noAuth = true
			break
		}
	}
	if !noAuth {
		_, _ = client.Write([]byte{socksVersion, 0xff})
		return
	}
	if _, err := client.Write([]byte{socksVersion, methodNoAuth}); err != nil {
		return
	}

	var request [4]byte
	if _, err := io.ReadFull(reader, request[:]); err != nil {
		return
	}
	if request[0] != socksVersion || request[2] != 0 {
		writeSOCKSReply(client, 1)
		return
	}
	if request[1] != cmdConnect {
		writeSOCKSReply(client, 7) // command not supported (UDP/BIND are intentionally off)
		return
	}

	host, err := readSOCKSAddress(reader, request[3])
	if err != nil {
		writeSOCKSReply(client, 8)
		return
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(reader, portBytes[:]); err != nil {
		writeSOCKSReply(client, 1)
		return
	}
	port := binary.BigEndian.Uint16(portBytes[:])
	if port == 0 || host == "" {
		writeSOCKSReply(client, 8)
		return
	}

	_ = client.SetDeadline(time.Time{})
	dialCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	remote, err := tunnel.DialContextResolving(dialCtx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
	if err != nil {
		writeSOCKSReply(client, mapDialError(err))
		return
	}
	defer remote.Close()
	if err := writeSOCKSReply(client, 0); err != nil {
		return
	}

	// Preserve TCP half-closes so HTTPS requests whose upload side closes
	// early can still receive the complete response through the VPN.
	done := make(chan struct{}, 2)
	go copyAndHalfClose(remote, reader, done)
	go copyAndHalfClose(client, remote, done)
	<-done
	_ = client.Close()
	_ = remote.Close()
	<-done
}

func readSOCKSAddress(reader io.Reader, addressType byte) (string, error) {
	switch addressType {
	case atypIPv4:
		var raw [4]byte
		if _, err := io.ReadFull(reader, raw[:]); err != nil {
			return "", err
		}
		return net.IP(raw[:]).String(), nil
	case atypIPv6:
		var raw [16]byte
		if _, err := io.ReadFull(reader, raw[:]); err != nil {
			return "", err
		}
		return net.IP(raw[:]).String(), nil
	case atypDomain:
		var length [1]byte
		if _, err := io.ReadFull(reader, length[:]); err != nil || length[0] == 0 {
			return "", fmt.Errorf("invalid SOCKS5 domain length")
		}
		raw := make([]byte, int(length[0]))
		if _, err := io.ReadFull(reader, raw); err != nil {
			return "", err
		}
		host := string(raw)
		if strings.ContainsAny(host, "\x00\r\n/\\") {
			return "", fmt.Errorf("invalid SOCKS5 domain")
		}
		return host, nil
	default:
		return "", fmt.Errorf("unsupported SOCKS5 address type")
	}
}

func writeSOCKSReply(conn net.Conn, code byte) error {
	// 0.0.0.0:0 is a valid unspecified BND.ADDR for a CONNECT proxy.
	_, err := conn.Write([]byte{socksVersion, code, 0, atypIPv4, 0, 0, 0, 0, 0, 0})
	return err
}

func mapDialError(err error) byte {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "refused"):
		return 5
	case strings.Contains(message, "no route"), strings.Contains(message, "network is unreachable"):
		return 3
	case strings.Contains(message, "no such host"), strings.Contains(message, "dns"), strings.Contains(message, "host unreachable"):
		return 4
	case strings.Contains(message, "timeout"), strings.Contains(message, "deadline exceeded"):
		return 6
	default:
		return 1
	}
}

func copyAndHalfClose(destination net.Conn, source io.Reader, done chan<- struct{}) {
	_, _ = io.Copy(destination, source)
	if halfCloser, ok := destination.(interface{ CloseWrite() error }); ok {
		_ = halfCloser.CloseWrite()
	} else {
		_ = destination.Close()
	}
	done <- struct{}{}
}

func fatalf(stage, format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: %s: %s\n", stage, fmt.Sprintf(format, args...))
	os.Exit(2)
}
