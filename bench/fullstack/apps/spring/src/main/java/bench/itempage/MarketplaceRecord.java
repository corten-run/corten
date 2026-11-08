package bench.itempage;

import java.util.List;

public record MarketplaceRecord(String id, String title, String subtitle, String description,
        List<Category> categories, List<String> badges, List<String> tags, List<String> images,
        List<Field> fields, Summary summary, List<Listing> listings, List<Offer> offers,
        List<Line> contents, List<Line> includedIn) {
    public record Category(String name, String slug) {}
    public record Field(String name, String value) {}
    public record Summary(Long lowestMinor, long count, long quantity) {}
    public record Listing(String id, String seller, Integer ratingHundredths, long reviews,
            String condition, String shipsFrom, long quantity, Long priceMinor) {}
    public record Offer(String id, String buyer, String condition, long quantity, Long priceMinor) {}
    public record Line(String id, String itemId, String title, long quantity) {}
}
