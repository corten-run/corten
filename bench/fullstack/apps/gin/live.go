package main

import (
	"io"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
)

// The live benchmark (bench/live): every open GET /live/prices stream has a queue, and each
// POST /live/publish body is added to all of them. A queue never blocks the publisher, so a slow
// client delays only itself.
type livePrices struct {
	mu      sync.Mutex
	clients map[*subscriber]struct{}
}

type subscriber struct {
	mu    sync.Mutex
	queue []string
	wake  chan struct{}
}

func newLivePrices() *livePrices {
	return &livePrices{clients: make(map[*subscriber]struct{})}
}

func (l *livePrices) stream(c *gin.Context) {
	s := &subscriber{wake: make(chan struct{}, 1)}
	l.mu.Lock()
	l.clients[s] = struct{}{}
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.clients, s)
		l.mu.Unlock()
	}()
	c.Header("Cache-Control", "no-cache")
	// An event first, so the headers go out now rather than with the first price.
	c.SSEvent("open", "")
	c.Writer.Flush()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-s.wake:
			s.mu.Lock()
			messages := s.queue
			s.queue = nil
			s.mu.Unlock()
			for _, m := range messages {
				c.SSEvent("", m)
			}
			c.Writer.Flush()
		}
	}
}

func (l *livePrices) publish(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	message := string(body)
	l.mu.Lock()
	for s := range l.clients {
		s.mu.Lock()
		s.queue = append(s.queue, message)
		s.mu.Unlock()
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	l.mu.Unlock()
	c.Status(http.StatusNoContent)
}
