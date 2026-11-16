package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.CookieManager;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.http.HttpStatus;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.core.exc.JacksonIOException;
import tools.jackson.core.JacksonException;

@Timeout(30)
class MarketplaceDeadlineTest {
    private static final JsonMapper JSON = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
    private static MarketplaceSource nativeSource;

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import({MarketplaceController.class, RecordJsonErrors.class})
    static class TestApplication {
        @Bean MarketplaceSource marketplaceSource() { return nativeSource; }
    }

    @Test void defaultsKeepAReadThatExceedsTheMatchedBudget() throws Exception {
        try (var upstream = new Upstream(11000, false, 200)) {
            var source = new MarketplaceSource(JSON, upstream.base(), null);
            assertEquals(MarketplaceTest.sample(), source.get("item_1"));
            upstream.assertCounters(1, 1, 0, 0);
        }
    }

    @Test void matchedHealthyReadsWritesAndFixturesKeepNativeRecords() throws Exception {
        try (var upstream = new Upstream(0, false, 200)) {
            var source = new MarketplaceSource(JSON, upstream.base(), null, "matched");
            assertEquals(MarketplaceTest.sample(), source.get("item_1", "trace-read"));
            assertEquals(MarketplaceTest.sample(), source.getForWrite("item_1", "trace-write"));
            upstream.assertCounters(2, 2, 0, 0);
            assertEquals(List.of("trace-read", "trace-write"), upstream.traces);
            var file = Files.createTempFile("spring-deadline-fixture-", ".json");
            try {
                Files.writeString(file, JSON.writeValueAsString(Map.of("item_1", MarketplaceTest.sample())));
                var fixture = new MarketplaceSource(JSON, upstream.base(), file.toString(), "matched");
                assertEquals(MarketplaceTest.sample(), fixture.get("item_1"));
                assertEquals(MarketplaceTest.sample(), fixture.getForWrite("item_1"));
                upstream.assertCounters(2, 2, 0, 0);
            } finally { Files.delete(file); }
        }
    }

    @Test void matchedHeaderTimeoutMapsOnlyTheNativeTimeoutTo504() throws Exception {
        try (var upstream = new Upstream(40000, false, 200)) {
            var source = new MarketplaceSource(JSON, upstream.base(), null, "matched");
            long start = System.nanoTime();
            var failure = assertThrows(RuntimeException.class, () -> source.get("item_1"));
            long elapsedMs = (System.nanoTime() - start) / 1000000;
            printTypes("headers", failure, elapsedMs);
            upstream.assertCounters(1, 0, 1, 0);
            assertTrue(elapsedMs >= 9000 && elapsedMs < 15000, "native ten-second budget");
            var timeout = assertInstanceOf(ResponseStatusException.class, failure);
            assertEquals(HttpStatus.GATEWAY_TIMEOUT, timeout.getStatusCode());
            var nativeFailure = assertInstanceOf(ResourceAccessException.class, timeout.getCause());
            assertEquals(HttpTimeoutException.class, nativeFailure.getCause().getClass());
        }
    }

    @Test void matchedBodyTimeoutClosesTheNativeReadWithoutInventingATimeoutCategory() throws Exception {
        try (var upstream = new Upstream(40000, true, 200)) {
            var source = new MarketplaceSource(JSON, upstream.base(), null, "matched");
            long start = System.nanoTime();
            var failure = assertThrows(RuntimeException.class, () -> source.get("item_1"));
            long elapsedMs = (System.nanoTime() - start) / 1000000;
            printTypes("body", failure, elapsedMs);
            upstream.assertCounters(1, 0, 1, 0);
            assertTrue(elapsedMs >= 9000 && elapsedMs < 15000, "body read uses the same native budget");
            assertFalse(failure instanceof ResponseStatusException, "unclassified body I/O is not relabeled 504");
            assertEquals(JacksonIOException.class, failure.getClass());
            assertInstanceOf(IOException.class, failure.getCause());
        }
    }

    @Test void matchedNonTimeoutFailuresAreNotRelabeled() throws Exception {
        try (var missing = new Upstream(0, false, 404); var failed = new Upstream(0, false, 502)) {
            assertNull(new MarketplaceSource(JSON, missing.base(), null, "matched").get("item_1"));
            assertThrows(IllegalStateException.class,
                    () -> new MarketplaceSource(JSON, failed.base(), null, "matched").get("item_1"));
            missing.assertCounters(1, 1, 0, 0);
            failed.assertCounters(1, 1, 0, 0);
        }
        try (var malformed = new Upstream(0, false, 200)) {
            malformed.responseBody = "{".getBytes(StandardCharsets.UTF_8);
            assertThrows(JacksonException.class,
                    () -> new MarketplaceSource(JSON, malformed.base(), null, "matched").get("item_1"));
            malformed.assertCounters(1, 1, 0, 0);
        }
        var unavailable = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        String base = "http://127.0.0.1:" + unavailable.getLocalPort();
        unavailable.close();
        var failure = assertThrows(ResourceAccessException.class,
                () -> new MarketplaceSource(JSON, base, null, "matched").get("item_1"));
        assertFalse(failure.getCause() instanceof HttpTimeoutException);
    }

    @Test @Timeout(60)
    void nativeMvcResolvesTheSharedPageJsonAndPostDeadlineWithoutCommittingAlerts() throws Exception {
        try (var upstream = new Upstream(40000, false, 200)) {
            nativeSource = new MarketplaceSource(JSON, upstream.base(), null, "matched");
            try (var context = new SpringApplicationBuilder(TestApplication.class).run("--server.port=0");
                    var client = HttpClient.newBuilder().cookieHandler(new CookieManager()).build()) {
                String base = "http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort();
                assertEquals("[]", client.send(HttpRequest.newBuilder(URI.create(base + "/api/alerts")).build(),
                        HttpResponse.BodyHandlers.ofString()).body());
                var pending = new java.util.ArrayList<java.util.concurrent.CompletableFuture<HttpResponse<String>>>();
                var expectedTraces = new java.util.HashSet<String>();
                var paths = List.of("/marketplace/en-US/item_1", "/marketplace/fr-FR/item_1",
                        "/marketplace/de-DE/item_1", "/api/marketplace/item_1", "/marketplace/en-US/item_1");
                for (int i = 0; i < paths.size(); i++) {
                    String trace = "00-" + String.format("%032x", i + 1) + "-" + String.format("%016x", i + 1) + "-01";
                    expectedTraces.add(trace);
                    var request = HttpRequest.newBuilder(URI.create(base + paths.get(i)))
                            .timeout(Duration.ofSeconds(20)).header("traceparent", trace);
                    if (i == paths.size() - 1) request.header("Content-Type", "application/x-www-form-urlencoded")
                            .POST(HttpRequest.BodyPublishers.ofString("email=deadline%40example.test&target_price=1.00"));
                    pending.add(client.sendAsync(request.build(), HttpResponse.BodyHandlers.ofString()));
                }
                for (var response : pending) assertEquals(504, response.get().statusCode());
                var problem = pending.get(3).get();
                assertTrue(problem.headers().firstValue("Content-Type").orElse("").startsWith("application/problem+json"));
                assertEquals(504, JSON.readTree(problem.body()).get("status").asInt());
                upstream.assertCounters(5, 0, 5, 0);
                assertEquals(expectedTraces, new java.util.HashSet<>(upstream.traces));
                assertEquals(5, upstream.traces.size());
                assertEquals("[]", client.send(HttpRequest.newBuilder(URI.create(base + "/api/alerts")).build(),
                        HttpResponse.BodyHandlers.ofString()).body());
            }
        }
    }

    private static void printTypes(String phase, Throwable failure, long elapsedMs) {
        var types = new java.util.ArrayList<String>();
        for (var cause = failure; cause != null && types.size() < 8; cause = cause.getCause())
            types.add(cause.getClass().getName());
        System.out.println("native-timeout phase=" + phase + " elapsedMs=" + elapsedMs + " types=" + types);
    }

    private static class Upstream implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        final java.util.concurrent.ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
        final List<Socket> sockets = new CopyOnWriteArrayList<>();
        final List<String> traces = new CopyOnWriteArrayList<>();
        final AtomicInteger requests = new AtomicInteger(), completed = new AtomicInteger(),
                cancelled = new AtomicInteger(), pending = new AtomicInteger();
        volatile byte[] responseBody = JSON.writeValueAsBytes(MarketplaceTest.sample());

        Upstream(int delayMs, boolean body, int status) throws IOException {
            workers.submit(() -> {
                while (!server.isClosed()) {
                    try {
                        var socket = server.accept();
                        sockets.add(socket);
                        workers.submit(() -> answer(socket, delayMs, body, status));
                    } catch (IOException error) {
                        if (!server.isClosed()) throw new java.io.UncheckedIOException(error);
                    }
                }
            });
        }

        String base() { return "http://127.0.0.1:" + server.getLocalPort(); }

        void answer(Socket socket, int delayMs, boolean body, int status) {
            boolean counted = false;
            try (socket) {
                socket.setSoTimeout(15000);
                var input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                for (String line; (line = input.readLine()) != null && !line.isEmpty();) {
                    if (line.toLowerCase(java.util.Locale.ROOT).startsWith("traceparent:"))
                        traces.add(line.substring(line.indexOf(':') + 1).trim());
                }
                requests.incrementAndGet(); pending.incrementAndGet(); counted = true;
                byte[] bytes = responseBody;
                var output = socket.getOutputStream();
                byte[] headers = ("HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nContent-Length: "
                        + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
                if (body) { output.write(headers); output.write(bytes, 0, 16); output.flush(); }
                if (delayMs > 0) {
                    socket.setSoTimeout(delayMs);
                    try {
                        if (input.read() == -1) { cancelled.incrementAndGet(); return; }
                        throw new IOException("unexpected extra request bytes");
                    } catch (SocketTimeoutException expected) { /* Complete the delayed response. */ }
                }
                if (!body) output.write(headers);
                output.write(bytes, body ? 16 : 0, bytes.length - (body ? 16 : 0));
                output.flush(); completed.incrementAndGet();
            } catch (IOException error) {
                if (counted) cancelled.incrementAndGet();
            } finally {
                if (counted) pending.decrementAndGet();
                sockets.remove(socket);
            }
        }

        void assertCounters(int expectedRequests, int expectedCompleted, int expectedCancelled, int expectedPending) throws Exception {
            long until = System.nanoTime() + 500000000L;
            while (pending.get() != expectedPending && System.nanoTime() < until) Thread.sleep(5);
            assertEquals(expectedRequests, requests.get());
            assertEquals(expectedCompleted, completed.get());
            assertEquals(expectedCancelled, cancelled.get());
            assertEquals(expectedPending, pending.get());
        }

        @Override public void close() throws Exception {
            server.close();
            for (var socket : sockets) socket.close();
            workers.shutdownNow();
            assertTrue(workers.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS));
        }
    }
}
