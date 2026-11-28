namespace ItemPage;

public sealed class MarketplacePublicOrigin
{
    readonly string? origin;
    readonly string? authority;

    public MarketplacePublicOrigin(string? configured)
    {
        if (configured is null) return;
        if (!Uri.TryCreate(configured, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || uri.Port == 0
            || uri.HostNameType is UriHostNameType.Unknown or UriHostNameType.Basic
            || !uri.IsWellFormedOriginalString() || configured.Any(c => c > 127)
            || configured != uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped))
            throw new InvalidOperationException("MARKETPLACE_PUBLIC_ORIGIN must be one serialized HTTP(S) origin.");
        origin = configured;
        authority = uri.Authority;
    }

    public bool Allows(HttpRequest request)
    {
        if (origin is not null && string.Equals(request.Host.Value, authority, StringComparison.OrdinalIgnoreCase))
            return request.Headers.Origin == origin;
        return !request.Headers.ContainsKey("Origin") || request.Headers.Origin == $"{request.Scheme}://{request.Host}";
    }
}
