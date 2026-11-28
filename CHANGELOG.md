# Changelog

Notable changes to Corten. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Corten is pre-1.0, so any minor version may change the API.

## Unreleased

Pending entries are in [changelog.d/](changelog.d/).

## 0.3.1 (2026-11-27)

- A declared handler that draws a submit key while it runs now sends its answer private with
  no tag, even if it renders the key into JSON, text or `raw` markup. This applies to staged
  and `unstaged` handlers, including staged requests and responses rebuilt in middleware.
  The watch does not see bare renders on another thread, keys drawn after the handler returns,
  or keys put in feed rows
  ([#1895 Keep a Public answer whose handler rendered a submit key out of shared caches, however it was rendered](https://github.com/corten-run/corten/pull/1895)).

  If a CDN or other shared cache could have stored these responses, invalidate the affected
  entries, including all cached variants, after patching every origin that serves them. The
  upgrade does not remove responses that a shared cache already holds.

- An answer that drew a submit key is sent with `private, no-cache` or `private, no-store`,
  even when it had a private lifetime. This includes custom `Json<T>` responses; existing
  `ToJson` implementations need no change
  ([#1895 Keep a Public answer whose handler rendered a submit key out of shared caches, however it was rendered](https://github.com/corten-run/corten/pull/1895)).

## Release archive

- [0.3.0](CHANGELOG.0.3.0.md)
- [0.2.0](CHANGELOG.0.2.0.md)
- [0.1.0](CHANGELOG.0.1.0.md)
