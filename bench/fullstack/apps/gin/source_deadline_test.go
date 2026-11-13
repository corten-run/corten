package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecordSourceStatus(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{
		{fmt.Errorf("source: %w", context.DeadlineExceeded), 504},
		{fmt.Errorf("source: %w", context.Canceled), 408},
		{&net.DNSError{IsTimeout: true}, 504},
		{errors.New("private source failure"), 502},
	} {
		if got := recordSourceStatus(tc.err); got != tc.status {
			t.Fatal(got, tc.status)
		}
	}
}

func TestNativePageDeadlineAndAlertAbort(t *testing.T) {
	for _, phase := range []string{"headers", "body"} {
		for _, mode := range []string{"GET", "POST", "abort-POST"} {
			t.Run(phase+"/"+mode, func(t *testing.T) {
				started, canceled := make(chan struct{}), make(chan struct{})
				var stall atomic.Bool
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if !stall.Load() {
						_ = json.NewEncoder(w).Encode(sampleMarketplace())
						return
					}
					if phase == "body" {
						_, _ = io.WriteString(w, `{"id":`)
						w.(http.Flusher).Flush()
					}
					close(started)
					<-r.Context().Done()
					close(canceled)
				}))
				defer upstream.Close()
				router, source := nativeSourceRouter(t, "marketplace", "api", upstream.URL, nil)
				source.Timeout = 500 * time.Millisecond
				if mode == "abort-POST" {
					// Cancellation must beat the source deadline, not be caused by it.
					source.Timeout = 5 * time.Second
				}
				app := httptest.NewServer(router)
				defer app.Close()
				client := &http.Client{Timeout: 3 * time.Second}
				client.Jar, _ = cookiejar.New(nil)
				defer client.CloseIdleConnections()
				path := "/marketplace/en-US/item_1"
				form := "email=native%40example.test&target_price=1.23"
				response, err := client.Post(app.URL+path, "application/x-www-form-urlencoded", strings.NewReader(form))
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, response.Body)
				response.Body.Close()
				if response.StatusCode != 200 {
					t.Fatal(response.Status)
				}
				stall.Store(true)
				if mode == "abort-POST" {
					conn, err := net.DialTimeout("tcp", app.Listener.Addr().String(), time.Second)
					if err != nil {
						t.Fatal(err)
					}
					defer conn.Close()
					cookie := response.Cookies()[0]
					_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %d\r\n\r\n%s", path, app.Listener.Addr(), cookie.Name, cookie.Value, len(form), form)
					if err != nil {
						t.Fatal(err)
					}
					awaitNative(t, started, "source start")
					_ = conn.Close()
				} else {
					var body io.Reader
					if mode == "POST" {
						body = strings.NewReader(form)
					}
					request, _ := http.NewRequest(mode, app.URL+path, body)
					if body != nil {
						request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
					}
					response, err = client.Do(request)
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(response.Body)
					response.Body.Close()
					if err != nil || response.StatusCode != 504 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(data), "Gateway Timeout") || len(response.Cookies()) != 0 {
						t.Fatal(response.Status, response.Header, string(data), err)
					}
				}
				awaitNative(t, canceled, "native source cancellation")
				_, data := nativeRequest(t, client, "GET", app.URL+"/api/alerts")
				var alerts []storedAlert
				if err := json.Unmarshal(data, &alerts); err != nil || len(alerts) != 1 || alerts[0].Email != "native@example.test" || alerts[0].TargetMinor != 123 {
					t.Fatal("failed source mutated alert store", string(data), err)
				}
			})
		}
	}
}
