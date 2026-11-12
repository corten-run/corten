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
            if (targetMinor is { } minor) return new AcceptedAlertPageResult(alerts, new(id, email, minor));
        }
        return Page();
    }

    sealed class AcceptedAlertPageResult(AlertStore alerts, Alert alert) : PageResult
    {
        public override async Task ExecuteResultAsync(ActionContext context)
        {
            var response = context.HttpContext.Response;
            var output = response.Body;
            await using var rendered = new MemoryStream();
            // Stage only accepted POSTs so a Razor/layout failure cannot commit an alert.
            response.Body = rendered;
            try { await base.ExecuteResultAsync(context); }
            finally { response.Body = output; }
            var cancellation = context.HttpContext.RequestAborted;
            cancellation.ThrowIfCancellationRequested();
            if (response.StatusCode is >= 200 and < 300) alerts.Append(context.HttpContext, alert);
            rendered.Position = 0;
            await rendered.CopyToAsync(output, cancellation);
        }
    }
}
