package bench.itempage;

import java.util.List;
import java.util.Objects;

public record CatalogRecord(String id, String title, String subtitle, String description,
        List<String> tags, List<Field> fields, List<Related> related) {
    public CatalogRecord {
        Objects.requireNonNull(id);
        Objects.requireNonNull(title);
        Objects.requireNonNull(subtitle);
        Objects.requireNonNull(description);
        tags = List.copyOf(tags);
        fields = List.copyOf(fields);
        related = List.copyOf(related);
    }
    public record Field(String name, String value) {
        public Field { Objects.requireNonNull(name); Objects.requireNonNull(value); }
    }
    public record Related(String id, String title) {
        public Related { Objects.requireNonNull(id); Objects.requireNonNull(title); }
    }
}
