using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace ItemPage;

public sealed record Alert(string ItemId, string Email, Int128 TargetMinor);

public sealed class AlertStore
{
    const string CookieName = "marketplace-alerts";
    readonly ConcurrentDictionary<string, List<Alert>> sessions = new();

    public Alert[] Read(HttpRequest request)
    {
        if (!request.Cookies.TryGetValue(CookieName, out var id) || !sessions.TryGetValue(id, out var rows)) return [];
        lock (rows) return rows.ToArray();
    }

    public void Append(HttpContext context, Alert alert)
    {
        if (context.Request.Cookies.TryGetValue(CookieName, out var id) && sessions.TryGetValue(id, out var rows))
        {
            lock (rows) rows.Add(alert);
            return;
        }
        // A caller-supplied unknown token never creates a store under that token.
        do { id = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)); }
        while (!sessions.TryAdd(id, [alert]));
        context.Response.Cookies.Append(CookieName, id, new CookieOptions
        {
            HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = context.Request.IsHttps, Path = "/"
        });
    }
}
