package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/a-h/templ"
	"github.com/gin-gonic/gin"
)

func (s *alertStore) renderPost(c *gin.Context, component templ.Component, row *storedAlert) {
	var body bytes.Buffer
	if err := component.Render(c.Request.Context(), &body); err != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	if row != nil {
		if err := s.append(c, *row); err != nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "alert storage unavailable"})
			return
		}
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", body.Bytes())
}

const alertCookie = "marketplace_session"

type storedAlert struct {
	ItemID      string `json:"item_id"`
	Email       string `json:"email"`
	TargetMinor int64  `json:"target_minor"`
}

type alertSession struct {
	expires time.Time
	rows    []storedAlert
}

type alertStore struct {
	sync.Mutex
	sessions map[string]*alertSession
}

func (s *alertStore) append(c *gin.Context, row storedAlert) error {
	s.Lock()
	defer s.Unlock()
	now := time.Now()
	for id, session := range s.sessions {
		if !now.Before(session.expires) {
			delete(s.sessions, id)
		}
	}
	id, _ := c.Cookie(alertCookie)
	session := s.sessions[id]
	if session == nil {
		if len(s.sessions) >= 4096 {
			return errors.New("alert storage capacity reached")
		}
		var bytes [32]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return err
		}
		id = hex.EncodeToString(bytes[:])
		session = &alertSession{expires: now.Add(time.Hour)}
		if s.sessions == nil {
			s.sessions = make(map[string]*alertSession)
		}
		s.sessions[id] = session
		// Forwarding headers never decide whether a credential is Secure.
		secure := c.Request.TLS != nil || strings.HasPrefix(os.Getenv("MARKETPLACE_PUBLIC_ORIGIN"), "https://")
		http.SetCookie(c.Writer, &http.Cookie{Name: alertCookie, Value: id, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
	}
	if len(session.rows) >= 1024 {
		return errors.New("alert storage capacity reached")
	}
	session.rows = append(session.rows, row)
	return nil
}

func (s *alertStore) read(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	id, _ := c.Cookie(alertCookie)
	s.Lock()
	rows := make([]storedAlert, 0)
	if session := s.sessions[id]; session != nil && time.Now().Before(session.expires) {
		rows = append(rows, session.rows...)
	}
	s.Unlock()
	c.JSON(http.StatusOK, rows)
}
