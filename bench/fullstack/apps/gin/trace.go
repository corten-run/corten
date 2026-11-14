package main

import (
	"context"
	"net/http"
	"strings"
)

type marketplaceTraceKey struct{}

// Strings are captured by value, never a request header map or pooled Gin context.
type marketplaceTrace struct{ parent, state string }

func marketplaceReadContext(r *http.Request) context.Context {
	trace := marketplaceTrace{}
	if parents := r.Header.Values("traceparent"); len(parents) == 1 {
		trace.parent = marketplaceTraceParent(parents[0])
		if trace.parent != "" {
			state := strings.Join(r.Header.Values("tracestate"), ",")
			if traceHTTPField(state) {
				trace.state = state
			}
		}
	}
	return context.WithValue(r.Context(), marketplaceTraceKey{}, trace)
}

func (trace marketplaceTrace) apply(r *http.Request) {
	if trace.parent != "" {
		r.Header.Set("traceparent", trace.parent)
		if trace.state != "" {
			r.Header.Set("tracestate", trace.state)
		}
	}
}

// Match the native Corten/Express known-field validation and future down-versioning.
func marketplaceTraceParent(value string) string {
	if len(value) < 55 || strings.Contains(value, ",") || value[:2] == "ff" || !traceHTTPField(value) {
		return ""
	}
	if len(value) != 55 && (value[:2] == "00" || value[55] != '-') {
		return ""
	}
	for i := 0; i < 55; i++ {
		b := value[i]
		if i == 2 || i == 35 || i == 52 {
			if b != '-' {
				return ""
			}
		} else if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f') {
			return ""
		}
	}
	if value[3:35] == "00000000000000000000000000000000" || value[36:52] == "0000000000000000" {
		return ""
	}
	if value[:2] == "00" {
		return value
	}
	// W3C 3.2.4: only the sampled bit is known when downgrading a future version.
	flags := "00"
	if strings.ContainsRune("13579bdf", rune(value[54])) {
		flags = "01"
	}
	return "00" + value[2:53] + flags
}

// Tracestate is opaque HTTP field data, including obs-text bytes, not UTF-8 text.
func traceHTTPField(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < ' ' && value[i] != '\t' || value[i] == 0x7f {
			return false
		}
	}
	return true
}
