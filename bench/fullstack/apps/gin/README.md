# Native record JSON

The catalog and marketplace JSON routes use Gin's native JSON serialization of
their parsed Go records. They accept GET/HEAD and return JSON 404, 405 and 502
errors; unsupported methods include `Allow: GET, HEAD` and do not fetch a record.
Record JSON responses use `Cache-Control: no-store`.

Both record sources use a request-context-aware Go HTTP client with redirects
disabled and a ten-second whole-response timeout, including JSON body decoding.
The same sources serve their existing native templ pages; templates, localization,
forms and legacy item transport are not replaced. This does not add the production
middleware required by the localized-marketplace or hardening groups.

With the pinned Go and templ tools from the Dockerfile installed, generate native
views and run the checks from this directory:

```sh
templ generate
go test ./...
go vet ./...
```

The focused socket tests cover fixture/API reads, JSON methods and errors,
headers/body stalls, caller disconnects, upstream closure and recovery. They are
functional checks, not independent serialization-audit receipts or a load baseline.
