# Native marketplace lifetime

The marketplace Razor page and record JSON endpoint use ASP.NET Core's ten-second
request timeout and propagate RequestAborted to source reads. Before MVC's
antiforgery authorization filter runs, middleware reads the native URL-encoded
marketplace form once with FormPipeReader and RequestAborted. It preserves the
configured native form limits and encoding rules, and assigns Request.Form so
MVC antiforgery and the handler share that collection. Antiforgery is not disabled
or replaced. Other endpoints and form encodings retain their native readers.

FormPipeReader is used directly because FormFeature.ReadFormAsync(token) also
aborts HttpContext on cancellation, preventing the timeout middleware's HTTP 504.
The timeout includes an unfinished URL-encoded upload, not only the source fetch.
The [native socket checks](../../../marketplace/corten/README.md#request-lifetime)
use real Kestrel images, captured antiforgery fields/cookies, slow unfinished
uploads, genuine caller aborts, independent alert readback and recovery requests.

MarketplaceSource.Get also accepts an optional immutable traceParent argument.
The page and record-JSON endpoint capture their own incoming traceparent before
the source await. A valid W3C context is added only to that HttpRequestMessage,
not shared HttpClient headers or ambient operation state. Known future-version
fields are down-versioned to 00; invalid/zero-ID/duplicate values add no app
header. Existing native Activity propagation remains configured as before and
may generate a fresh trace for an untraced request. No exporter, parser, extra
fetch or deadline change is involved. The scoped native trace checks linked
above verify overlapping contexts, delayed source work, forms and readback.
