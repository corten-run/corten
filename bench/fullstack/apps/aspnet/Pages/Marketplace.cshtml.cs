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
    public Task<IActionResult> OnGetAsync(string locale, string id) => Render(locale, id, false);
    public Task<IActionResult> OnPostAsync(string locale, string id) => Render(locale, id, true);

    async Task<IActionResult> Render(string locale, string id, bool post)
    {
        if (!MarketplaceFormat.Supported(locale)) return BadRequest();
        var record = await source.Get(id);
        if (record is null) return NotFound();
        Record = record;
        Locale = locale;
        Format = new(locale);
        Prefix = Request.Query["seller"].FirstOrDefault() ?? "";
        Sort = Request.Query["sort"] == "desc" ? "desc" : "asc";
        AllOffers = Request.Query["offers"] == "all";
        if (post)
        {
            var form = await Request.ReadFormAsync();
            Message = Format.Alert(form["email"].FirstOrDefault() ?? "", form["target_price"].FirstOrDefault() ?? "", record.Title);
        }
        return Page();
    }
}
