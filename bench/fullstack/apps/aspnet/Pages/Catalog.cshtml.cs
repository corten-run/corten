using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace ItemPage.Pages;

public sealed class CatalogModel(CatalogSource catalog) : PageModel
{
    public CatalogRecord Record { get; private set; } = null!;
    public string Prefix { get; private set; } = "";
    public async Task<IActionResult> OnGetAsync(string id)
    {
        var record = await catalog.Get(id);
        if (record is null) return NotFound();
        Record = record;
        // Read the raw query value: model binding trims whitespace-only strings to null.
        Prefix = Request.Query["field"].FirstOrDefault() ?? "";
        return Page();
    }
}
