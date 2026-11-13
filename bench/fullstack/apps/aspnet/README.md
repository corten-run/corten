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
