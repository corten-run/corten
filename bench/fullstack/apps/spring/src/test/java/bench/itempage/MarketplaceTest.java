package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.ui.ExtendedModelMap;
import org.thymeleaf.spring6.SpringTemplateEngine;
import org.thymeleaf.templateresolver.ClassLoaderTemplateResolver;
import org.thymeleaf.context.Context;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.PropertyNamingStrategies;

class MarketplaceTest {
    private static String spaces(String s) { return s.replace('\u00a0', ' ').replace('\u202f', ' '); }
    @Test void numericFormattingAndPluralCategories() {
        var en = new MarketplaceFormat("en-US");
        var fr = new MarketplaceFormat("fr-FR");
        var de = new MarketplaceFormat("de-DE");
        assertEquals("-$1,234.50", en.money(-123450L));
        assertEquals("1 234,50 $US", spaces(fr.money(123450L)));
        assertEquals("1.234,50 $", spaces(de.money(123450L)));
        assertEquals("0 annonce", fr.listings(0));
        assertEquals("1 000 000 d’annonces", spaces(fr.listings(1000000)));
        for (var f : List.of(en, fr, de)) {
            assertEquals("5", f.rating(499));
            assertEquals(f == en ? "4.3" : "4,3", f.rating(425));
            assertEquals(f == en ? "4.8" : "4,8", f.rating(475));
            assertTrue(f.alert("test@example.test", f == en ? "1234.50" : "1234,50", "Title").contains(f.money(123450L)));
            assertEquals(f.getText().get("invalid_price"), f.alert("a@b", "0", "Title"));
            assertEquals(f.getText().get("invalid_email"), f.alert("no", "1", "Title"));
            assertEquals(f.getText().get("invalid_price"), f.alert("a@b", "NaN", "Title"));
        }
    }
    static MarketplaceRecord sample() {
        var rows = List.of(row("a", "Alice", 100L), row("b", "alice", null), row("c", "Alice", 100L), row("d", " Alice", -100L));
        return new MarketplaceRecord("item_1", "<script> & Title", null, "Description", List.of(new MarketplaceRecord.Category("Cards", "cards")),
                List.of(), List.of(), List.of("/one"), List.of(new MarketplaceRecord.Field("Set", "<&>")),
                new MarketplaceRecord.Summary(-123450L, 1000000, 1000), rows,
                java.util.stream.IntStream.range(0, 7).mapToObj(i -> new MarketplaceRecord.Offer("o" + i, "Buyer", "NM", 1, null)).toList(),
                List.of(new MarketplaceRecord.Line("line", "item_2", "Other", 1000)), List.of());
    }
    static MarketplaceRecord.Listing row(String id, String seller, Long price) { return new MarketplaceRecord.Listing(id, seller, 425, 1000, "NM", "US", 2, price); }
    @Test void writeInvariantsAreCheckedOnTheParsedRecord() {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var valid = json.writeValueAsString(sample());
        sample().validateForWrite("item_1");
        assertThrows(IllegalStateException.class, () -> sample().validateForWrite("item_2"));
        for (String key : List.of("listings", "offers", "contents")) {
            var bad = (tools.jackson.databind.node.ObjectNode) json.readTree(valid);
            var rows = (tools.jackson.databind.node.ArrayNode) bad.get(key);
            rows.add(rows.get(0).deepCopy());
            var record = json.treeToValue(bad, MarketplaceRecord.class);
            assertThrows(IllegalStateException.class, () -> record.validateForWrite("item_1"));
        }
        for (long count : List.of(-1L, 1000000001L)) {
            var bad = (tools.jackson.databind.node.ObjectNode) json.readTree(valid);
            ((tools.jackson.databind.node.ObjectNode) bad.get("summary")).put("count", count);
            var record = json.treeToValue(bad, MarketplaceRecord.class);
            assertThrows(IllegalStateException.class, () -> record.validateForWrite("item_1"));
        }
    }

    @Test void fixtureParsingCannotEraseMissingOrCoercedWriteFields() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var file = java.nio.file.Files.createTempFile("marketplace-write", ".json");
        try {
            java.nio.file.Files.writeString(file, json.writeValueAsString(java.util.Map.of("item_1", sample())));
            new MarketplaceSource(json, "http://unused", file.toString()).getForWrite("item_1").validateForWrite("item_1");
            for (String key : List.of("description", "subtitle", "summary")) {
                var bad = (tools.jackson.databind.node.ObjectNode) json.valueToTree(sample());
                bad.remove(key);
                java.nio.file.Files.writeString(file, json.writeValueAsString(java.util.Map.of("item_1", bad)));
                assertThrows(RuntimeException.class, () -> new MarketplaceSource(json, "http://unused", file.toString()));
            }
            var bad = (tools.jackson.databind.node.ObjectNode) json.valueToTree(sample());
            bad.put("id", 1);
            java.nio.file.Files.writeString(file, json.writeValueAsString(java.util.Map.of("item_1", bad)));
            assertThrows(RuntimeException.class, () -> new MarketplaceSource(json, "http://unused", file.toString()));
        } finally { java.nio.file.Files.delete(file); }
    }
    @Test void stableSortPrefixAndNumericJson() {
        var record = sample();
        assertEquals(List.of("a", "c"), MarketplaceFormat.listings(record, "Alice", "desc").stream().map(MarketplaceRecord.Listing::id).toList());
        assertEquals(List.of("a", "c", "d", "b"), MarketplaceFormat.listings(record, "", "desc").stream().map(MarketplaceRecord.Listing::id).toList());
        assertEquals(List.of("d"), MarketplaceFormat.listings(record, " ", "asc").stream().map(MarketplaceRecord.Listing::id).toList());
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var encoded = json.writeValueAsString(record);
        assertTrue(encoded.contains("\"price_minor\":null"));
        assertTrue(encoded.contains("\"lowest_minor\":-123450"));
        assertEquals(record, json.readValue(encoded, MarketplaceRecord.class));
    }
    @Test void nativeTemplateEscapesAndLimitsRows() throws Exception {
        var resolver = new ClassLoaderTemplateResolver(); resolver.setPrefix("templates/"); resolver.setSuffix(".html");
        var engine = new SpringTemplateEngine(); engine.setTemplateResolver(resolver);
        var model = new ExtendedModelMap();
        var source = org.mockito.Mockito.mock(MarketplaceSource.class);
        org.mockito.Mockito.when(source.get("item_1")).thenReturn(sample());
        var controller = new MarketplaceController(source, org.mockito.Mockito.mock(org.thymeleaf.spring6.view.ThymeleafViewResolver.class));
        var request = new MockHttpServletRequest("GET", "/marketplace/fr-FR/item_1");
        assertEquals("marketplace", controller.show("fr-FR", "item_1", "", "asc", "", "", "", request, new org.springframework.mock.web.MockHttpServletResponse(), model));
        // The web context expands @{...} routes in the actual MVC integration; this
        // unit test uses a link builder that preserves their already-parsed paths.
        engine.setLinkBuilder(new org.thymeleaf.linkbuilder.StandardLinkBuilder() {
            @Override protected String computeContextPath(org.thymeleaf.context.IExpressionContext context, String base, java.util.Map<String, Object> parameters) { return ""; }
        });
        String html = engine.process("marketplace", new Context(java.util.Locale.FRANCE, model));
        assertTrue(html.contains("lang=\"fr-FR\""));
        assertTrue(html.contains("&lt;script&gt; &amp; Title"));
        assertFalse(html.contains("data-offer-id=\"o5\""));
        assertTrue(html.contains("marketplace__more"));
        assertTrue(html.contains("<th>Vendeur</th>"));
        assertTrue(html.contains("<th>Acheteur</th>"));
        assertTrue(html.contains("1\u202f000\u202f000 d’annonces") || html.contains("1\u00a0000\u00a0000 d’annonces"));
    }

    @Test void fixtureAndHttpSourcesReadNumericRecordsWithoutResponseCaching() throws Exception {
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        var file = java.nio.file.Files.createTempFile("marketplace", ".json");
        var requests = new java.util.concurrent.atomic.AtomicInteger();
        var status = new java.util.concurrent.atomic.AtomicInteger(200);
        var current = new java.util.concurrent.atomic.AtomicReference<>(sample());
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/marketplace/records/", exchange -> {
            requests.incrementAndGet();
            assertEquals("/marketplace/records/a%2Fb%20%3F", exchange.getRequestURI().getRawPath());
            byte[] bytes = json.writeValueAsString(current.get()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.get(), bytes.length);
            try (var body = exchange.getResponseBody()) { body.write(bytes); }
        });
        server.start();
        try {
            java.nio.file.Files.writeString(file, json.writeValueAsString(java.util.Map.of("item_1", sample())));
            var fixture = new MarketplaceSource(json, "http://unused", file.toString());
            java.nio.file.Files.writeString(file, "{}");
            assertEquals(sample(), fixture.get("item_1"));
            assertNull(fixture.get("missing"));
            var http = new MarketplaceSource(json, "http://127.0.0.1:" + server.getAddress().getPort(), null);
            assertEquals(sample(), http.get("a/b ?"));
            assertEquals(sample(), http.get("a/b ?"));
            assertEquals(2, requests.get());
            status.set(404); assertNull(http.get("a/b ?"));
            status.set(503); assertThrows(IllegalStateException.class, () -> http.get("a/b ?"));
            assertEquals(4, requests.get());
        } finally { server.stop(0); java.nio.file.Files.delete(file); }
    }
}
