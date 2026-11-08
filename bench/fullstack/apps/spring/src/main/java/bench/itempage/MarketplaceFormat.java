package bench.itempage;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.ParsePosition;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import com.ibm.icu.text.DecimalFormat;
import com.ibm.icu.text.NumberFormat;
import com.ibm.icu.text.PluralRules;
import com.ibm.icu.util.Currency;
import com.ibm.icu.util.ULocale;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

public final class MarketplaceFormat {
    private static final Map<String, Map<String, String>> LABELS = loadLabels();
    private final NumberFormat money;
    private final NumberFormat count;
    private final NumberFormat rating;
    private final DecimalFormat parser;
    private final PluralRules plurals;
    private final Map<String, String> text;
    private final com.ibm.icu.text.MessageFormat alert;

    private static Map<String, Map<String, String>> loadLabels() {
        try (var input = new ClassPathResource("marketplace-labels.json").getInputStream()) {
            return JsonMapper.builder().build().readValue(input, new TypeReference<Map<String, Map<String, String>>>() {});
        } catch (java.io.IOException e) { throw new ExceptionInInitializerError(e); }
    }

    public static boolean supported(String locale) { return LABELS.containsKey(locale); }
    public MarketplaceFormat(String locale) {
        var culture = ULocale.forLanguageTag(locale);
        text = LABELS.get(locale);
        alert = new com.ibm.icu.text.MessageFormat(text.get("alert_set"), culture);
        money = NumberFormat.getCurrencyInstance(culture);
        money.setCurrency(Currency.getInstance("USD"));
        money.setMinimumFractionDigits(2);
        money.setMaximumFractionDigits(2);
        count = NumberFormat.getIntegerInstance(culture);
        rating = NumberFormat.getNumberInstance(culture);
        rating.setMinimumFractionDigits(0);
        rating.setMaximumFractionDigits(1);
        parser = (DecimalFormat) NumberFormat.getNumberInstance(culture);
        parser.setParseBigDecimal(true);
        parser.setParseStrict(true);
        parser.setGroupingUsed(false);
        plurals = PluralRules.forLocale(culture);
    }
    public Map<String, String> getText() { return text; }
    public String money(Long minor) { return minor == null ? "\u2014" : amount(BigDecimal.valueOf(minor, 2)); }
    public String amount(BigDecimal amount) { return money.format(amount.setScale(2, RoundingMode.HALF_UP)); }
    public String count(long value) { return count.format(value); }
    public String rating(int value) { return rating.format(BigDecimal.valueOf(value, 2).setScale(1, RoundingMode.HALF_UP)); }
    public String listings(long value) { return count(value) + " " + text.get("listing_" + plurals.select(value)); }

    public String alert(String email, String target, String title) {
        if (!email.contains("@")) return text.get("invalid_email");
        var input = target.strip();
        var position = new ParsePosition(0);
        var parsed = parser.parse(input, position);
        if (parsed == null || position.getIndex() != input.length()) return text.get("invalid_price");
        BigDecimal price;
        try { price = new BigDecimal(parsed.toString()); }
        catch (NumberFormatException e) { return text.get("invalid_price"); }
        if (price.signum() <= 0) return text.get("invalid_price");
        return alert.format(Map.of("email", email, "title", title, "price", amount(price)));
    }

    public static List<MarketplaceRecord.Listing> listings(MarketplaceRecord record, String prefix, String sort) {
        Comparator<Long> order = "desc".equals(sort) ? Comparator.reverseOrder() : Comparator.naturalOrder();
        return record.listings().stream().filter(row -> row.seller().startsWith(prefix))
                .sorted(Comparator.comparing(MarketplaceRecord.Listing::priceMinor, Comparator.nullsLast(order))).toList();
    }
}
