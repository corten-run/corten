package bench.itempage;

import java.util.List;

public record MarketplaceRecord(String id, String title, String subtitle, String description,
        List<Category> categories, List<String> badges, List<String> tags, List<String> images,
        List<Field> fields, Summary summary, List<Listing> listings, List<Offer> offers,
        List<Line> contents, List<Line> includedIn) {
    public void validateForWrite(String requestedId) {
        require(id != null && id.equals(requestedId) && title != null && description != null);
        require(categories != null && fields != null);
        for (var row : categories) require(row != null && row.name() != null && row.slug() != null);
        for (var row : fields) require(row != null && row.name() != null && row.value() != null);
        for (var values : List.of(badges, tags, images))
            for (var value : values) require(value != null);
        if (summary != null) {
            number(summary.lowestMinor(), -1000000000L, 1000000000L);
            count(summary.count()); count(summary.quantity());
        }
        require(listings != null && offers != null && contents != null && includedIn != null);
        var ids = new java.util.HashSet<String>();
        for (var row : listings) {
            require(row != null && row.id() != null && ids.add(row.id()) && row.seller() != null
                    && row.condition() != null && row.shipsFrom() != null);
            number(row.ratingHundredths() == null ? null : row.ratingHundredths().longValue(), 0, 500);
            count(row.reviews()); count(row.quantity()); number(row.priceMinor(), -1000000000L, 1000000000L);
        }
        ids.clear();
        for (var row : offers) {
            require(row != null && row.id() != null && ids.add(row.id()) && row.buyer() != null && row.condition() != null);
            count(row.quantity()); number(row.priceMinor(), -1000000000L, 1000000000L);
        }
        for (var lines : List.of(contents, includedIn)) {
            ids.clear();
            for (var row : lines) {
                require(row != null && row.id() != null && ids.add(row.id()) && row.itemId() != null && row.title() != null);
                count(row.quantity());
            }
        }
    }

    private static void require(boolean valid) {
        if (!valid) throw new IllegalStateException("Invalid marketplace record");
    }
    private static void count(long value) { number(value, 0, 1000000000L); }
    private static void number(Long value, long min, long max) {
        require(value == null || (value >= min && value <= max));
    }

    public record Category(String name, String slug) {}
    public record Field(String name, String value) {}
    public record Summary(Long lowestMinor, long count, long quantity) {}
    public record Listing(String id, String seller, Integer ratingHundredths, long reviews,
            String condition, String shipsFrom, long quantity, Long priceMinor) {}
    public record Offer(String id, String buyer, String condition, long quantity, Long priceMinor) {}
    public record Line(String id, String itemId, String title, long quantity) {}
}
