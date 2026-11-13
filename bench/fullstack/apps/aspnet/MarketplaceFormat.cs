using System.Globalization;
using System.Text.Json;
using Jeffijoe.MessageFormat;

namespace ItemPage;

public sealed class MarketplaceFormat
{
    static readonly Dictionary<string, Dictionary<string, string>> Labels = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "marketplace-labels.json")))!;
    readonly NumberFormatInfo money;
    readonly CultureInfo culture;
    readonly MessageFormatter plurals = new();
    public Dictionary<string, string> Text { get; }
    public static bool Supported(string locale) => locale is "en-US" or "fr-FR" or "de-DE";

    public MarketplaceFormat(string locale)
    {
        culture = CultureInfo.GetCultureInfo(locale);
        // ICU's standard Unicode currency extension keeps the URL locale's
        // number pattern while selecting USD, including its localized symbol.
        money = CultureInfo.GetCultureInfo(locale + "-u-cu-usd").NumberFormat;
        Text = Labels[locale];
    }

    public string Money(long? minor) => minor is null ? "\u2014" : Amount(minor.Value / 100m);
    // .NET's currency patterns use a breakable space for ICU's currency spacing.
    // Preserve the native formatting while keeping the amount and symbol together.
    public string Amount(decimal amount) => Math.Round(amount, 2, MidpointRounding.AwayFromZero).ToString("C2", money).Replace(' ', '\u00a0');
    public string Count(long value) => value.ToString("N0", culture);
    public string Rating(int value) => Math.Round(value / 100m, 1, MidpointRounding.AwayFromZero).ToString("#,##0.#", culture);
    public string Listings(long count)
    {
        var category = plurals.FormatMessage("{n, plural, one{one} many{many} other{other}}", new { n = count }, culture);
        return Count(count) + " " + Text["listing_" + category];
    }

    public string Alert(string email, string target, string title) => Alert(email, target, title, out _);

    public string Alert(string email, string target, string title, out Int128? targetMinor)
    {
        targetMinor = null;
        if (!email.Contains('@')) return Text["invalid_email"];
        // A decimal mark from a different locale is not silently read as grouping.
        var separator = culture.NumberFormat.NumberDecimalSeparator;
        if ((separator == "," && target.Contains('.')) || (separator == "." && target.Contains(','))
            || !decimal.TryParse(target, NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite |
                NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, culture, out var amount) || amount <= 0)
            return Text["invalid_price"];
        var rounded = Math.Round(amount, 2, MidpointRounding.AwayFromZero);
        // Scaling decimal.MaxValue by 100 overflows decimal. Split first so every price the
        // native parser already accepts remains representable as integer minor units.
        var whole = decimal.Truncate(rounded);
        targetMinor = (Int128)whole * 100 + (Int128)((rounded - whole) * 100);
        return plurals.FormatMessage(Text["alert_set"], new { email, title, price = Amount(amount) }, culture);
    }

    public static IEnumerable<MarketplaceListing> Listings(MarketplaceRecord record, string prefix, string sort)
    {
        var rows = record.Listings.Where(row => row.Seller.StartsWith(prefix, StringComparison.Ordinal));
        return sort == "desc"
            ? rows.OrderBy(row => row.PriceMinor is null).ThenByDescending(row => row.PriceMinor)
            : rows.OrderBy(row => row.PriceMinor is null).ThenBy(row => row.PriceMinor);
    }
}
