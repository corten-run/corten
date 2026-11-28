package bench.itempage.transport;

import static java.nio.charset.StandardCharsets.US_ASCII;
import static org.junit.jupiter.api.Assertions.*;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public final class DisconnectSockets implements AutoCloseable {
    public static final String PAGE = "/marketplace/en-US/item_1";
    public static final String RECORD = "/marketplace/records/item_1";
    private static final int OBSERVATION_MS = 500;
    private static final int IO_GUARD_MS = 5000;
    private static final String TRACE = "00-11111111111111111111111111111111-2222222222222222-01";
    private final ServerSocket listener = new ServerSocket();

    public DisconnectSockets() throws IOException {
        listener.bind(new InetSocketAddress("127.0.0.1", 0));
        listener.setSoTimeout(IO_GUARD_MS);
    }

    public String base() { return "http://127.0.0.1:" + listener.getLocalPort(); }

    public static Socket request(int port) throws IOException {
        var caller = new Socket();
        try {
            caller.connect(new InetSocketAddress("127.0.0.1", port), IO_GUARD_MS);
            write(caller, "GET " + PAGE + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
                    + "\r\nConnection: keep-alive\r\ntraceparent: " + TRACE + "\r\n\r\n");
            return caller;
        } catch (IOException failure) {
            caller.close();
            throw failure;
        }
    }

    public Exchange awaitRecord(byte[] body) throws IOException {
        var socket = listener.accept();
        try {
            socket.setSoTimeout(IO_GUARD_MS);
            var input = reader(socket);
            assertEquals("GET " + RECORD + " HTTP/1.1", input.readLine());
            assertEquals(TRACE, headers(input).get("traceparent"));
            return new Exchange(socket, input, body);
        } catch (IOException | RuntimeException | AssertionError failure) {
            socket.close();
            throw failure;
        }
    }

    public void assertNoSecondExchange() throws IOException {
        listener.setSoTimeout(50);
        assertThrows(SocketTimeoutException.class, () -> {
            try (var unexpected = listener.accept()) { fail("second upstream connection"); }
        });
    }

    // This read is the driver's 50 ms post-observation pause, not a server timer.
    public static void assertNoResponse(Socket caller) throws IOException {
        caller.setSoTimeout(50);
        assertThrows(SocketTimeoutException.class, () -> caller.getInputStream().read(),
                "caller received a byte or EOF before the upstream response was released");
    }

    public static void assertOk(Socket caller, String marker) throws IOException {
        caller.setSoTimeout(IO_GUARD_MS);
        var input = reader(caller);
        String status = input.readLine();
        assertTrue(status != null && status.startsWith("HTTP/1.1 200 "), "native response: " + status);
        headers(input);
        // Both test responses put the marker on the first few lines, with or without chunking.
        for (int i = 0; i < 8; i++) {
            String line = input.readLine();
            if (line == null) break;
            if (line.contains(marker)) return;
        }
        fail("native response did not contain the expected marker");
    }

    private static BufferedReader reader(Socket socket) throws IOException {
        return new BufferedReader(new InputStreamReader(socket.getInputStream(), US_ASCII));
    }

    private static Map<String, String> headers(BufferedReader input) throws IOException {
        var headers = new HashMap<String, String>();
        for (;;) {
            String line = input.readLine();
            assertNotNull(line, "incomplete HTTP head");
            if (line.isEmpty()) return headers;
            int colon = line.indexOf(':');
            assertTrue(colon > 0, "invalid HTTP header");
            headers.put(line.substring(0, colon).toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
    }

    private static void write(Socket socket, String text) throws IOException {
        var output = socket.getOutputStream();
        output.write(text.getBytes(US_ASCII));
        output.flush();
    }

    @Override public void close() throws IOException { listener.close(); }

    static void assertPeerClosed(BufferedReader input) throws IOException {
        try {
            assertEquals(-1, input.read(), "upstream received request bytes rather than peer close");
        } catch (SocketException failure) {
            // These are the JDK socket messages for peer reset; other socket errors are not evidence of it.
            String message = failure.getMessage();
            if (!"Connection reset".equals(message) && !"Connection reset by peer".equals(message)) throw failure;
        }
    }

    public static final class Exchange implements AutoCloseable {
        private final Socket socket;
        private final BufferedReader input;
        private final byte[] body;
        private int sent;

        private Exchange(Socket socket, BufferedReader input, byte[] body) {
            this.socket = socket;
            this.input = input;
            this.body = body;
        }

        private void sendHeaders() throws IOException {
            write(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n");
        }

        public void startBody() throws IOException {
            assertTrue(body.length > 1);
            sendHeaders();
            socket.getOutputStream().write(body, 0, 1);
            socket.getOutputStream().flush();
            sent = 1;
        }

        public void complete() throws IOException {
            if (sent == 0) sendHeaders();
            socket.getOutputStream().write(body, sent, body.length - sent);
            socket.getOutputStream().flush();
        }

        public void assertPending() throws IOException {
            assertPendingFor(OBSERVATION_MS);
        }

        public void assertOpenBeforeAbort() throws IOException {
            assertPendingFor(1);
        }

        private void assertPendingFor(int millis) throws IOException {
            socket.setSoTimeout(millis);
            assertThrows(SocketTimeoutException.class, () -> input.read(),
                    "upstream was closed or received more request bytes while held");
        }

        public void assertClosedSince(long abortNanos) throws IOException {
            long limit = TimeUnit.MILLISECONDS.toNanos(OBSERVATION_MS);
            long remaining = limit - (System.nanoTime() - abortNanos);
            assertTrue(remaining > 0, "500 ms observation elapsed before upstream read");
            socket.setSoTimeout((int) Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining - 1) + 1));
            try {
                assertPeerClosed(input);
            } catch (SocketTimeoutException failure) {
                fail("upstream still pending 500 ms after caller abort", failure);
            }
            assertFalse(socket.isClosed() || Thread.currentThread().isInterrupted(), "probe closed or interrupted locally");
            assertTrue(System.nanoTime() - abortNanos <= limit, "upstream closed outside the 500 ms observation");
        }

        @Override public void close() throws IOException { socket.close(); }
    }
}
