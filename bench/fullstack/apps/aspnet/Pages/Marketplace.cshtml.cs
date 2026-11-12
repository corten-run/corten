using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace ItemPage.Pages;

public sealed class MarketplaceModel(MarketplaceSource source) : PageModel
{
    public MarketplaceRecord Record { get; private set; } = null!;
    public MarketplaceFormat Format { get; private set; } = null!;
    public string Locale { get; private set; } = "";
    public string Prefix { get; private set; } = "";
    public string Sort { get; private set; } = "asc";
    public bool AllOffers { get; private set; }
    public string Message { get; private set; } = "";
    public Task<IActionResult> OnGetAsync(string locale, string id) => Render(locale, id);
    public Task<IActionResult> OnPostAsync(string locale, string id, [FromServices] AlertStore alerts) => Render(locale, id, alerts);

    async Task<IActionResult> Render(string locale, string id, AlertStore? alerts = null)
    {
        if (!MarketplaceFormat.Supported(locale)) return BadRequest();
        if (alerts is not null && (Request.Headers["Sec-Fetch-Site"] == "cross-site"
            || (Request.Headers.ContainsKey("Origin") && Request.Headers.Origin != $"{Request.Scheme}://{Request.Host}")))
            return StatusCode(StatusCodes.Status403Forbidden);
        var record = await source.Get(id);
        if (record is null) return NotFound();
        Record = record;
        Locale = locale;
        Format = new(locale);
        Prefix = Request.Query["seller"].FirstOrDefault() ?? "";
        Sort = Request.Query["sort"] == "desc" ? "desc" : "asc";
        AllOffers = Request.Query["offers"] == "all";
        if (alerts is not null)
        {
            var form = await Request.ReadFormAsync();
            var email = form["email"].FirstOrDefault() ?? "";
            Message = Format.Alert(email, form["target_price"].FirstOrDefault() ?? "", record.Title, out var targetMinor);
            Response.Headers.CacheControl = "no-store";
            if (targetMinor is { } minor) alerts.Append(HttpContext, new(id, email, minor));
        }
        return Page();
    }
}
