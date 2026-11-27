package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import java.util.List;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.ui.ExtendedModelMap;
import org.springframework.web.server.ResponseStatusException;

class AlertsTest {
    @Test void concurrentWritesKeepEveryRowAndSnapshotsAreIndependent() throws Exception {
        var session = new MockHttpSession();
        Alerts.append(session, new Alerts.Alert("first", "a@b", 1));
        var snapshot = Alerts.read(session);
        try (var pool = Executors.newFixedThreadPool(4)) {
            var tasks = java.util.stream.IntStream.range(0, 32).<java.util.concurrent.Callable<Void>>mapToObj(i -> () -> {
                Alerts.append(session, new Alerts.Alert("item_" + i, "a@b", i));
                return null;
            }).toList();
            for (var task : pool.invokeAll(tasks)) task.get();
        }
        assertEquals(33, Alerts.read(session).size());
        assertEquals(33, Alerts.read(session).stream().map(Alerts.Alert::itemId).distinct().count());
        assertEquals(snapshot.getFirst(), Alerts.read(session).getFirst());
        assertEquals(1, snapshot.size());
        assertEquals(List.of(), Alerts.read(new MockHttpSession()));
        assertEquals(List.of(), Alerts.read(null));
    }

    @Test void validationAndCrossSiteRequestsNeverAppend() throws Exception {
        var source = org.mockito.Mockito.mock(MarketplaceSource.class);
        org.mockito.Mockito.when(source.getForWrite("item_1")).thenReturn(MarketplaceTest.sample());
        var views = org.mockito.Mockito.mock(org.thymeleaf.spring6.view.ThymeleafViewResolver.class);
        var view = org.mockito.Mockito.mock(org.springframework.web.servlet.View.class);
        org.mockito.Mockito.when(views.resolveViewName(org.mockito.ArgumentMatchers.eq("marketplace"), org.mockito.ArgumentMatchers.any())).thenReturn(view);
        var controller = new MarketplaceController(source, views, null);
        var request = new MockHttpServletRequest("POST", "/marketplace/en-US/item_1");
        var response = new MockHttpServletResponse();
        for (String target : List.of("", "0", "NaN", "92233720368547758.08"))
            controller.show("en-US", "item_1", "", "asc", "", "a@b", target, request, response, new ExtendedModelMap());
        assertNull(request.getSession(false));
        controller.show("en-US", "item_1", "", "asc", "", "a@b", "12.505", request, response, new ExtendedModelMap());
        assertEquals(List.of(new Alerts.Alert("item_1", "a@b", 1251)), Alerts.read(request.getSession()));
        request.addHeader("Origin", "http://evil.test");
        assertThrows(ResponseStatusException.class, () -> controller.show("en-US", "item_1", "", "asc", "", "a@b", "2", request, response, new ExtendedModelMap()));
        assertEquals(1, Alerts.read(request.getSession()).size());
        assertThrows(ResponseStatusException.class, () -> controller.show("en-US", "missing", "", "asc", "", "a@b", "2", new MockHttpServletRequest("POST", "/"), response, new ExtendedModelMap()));
    }

    @Test void publicOriginIsExactAndDoesNotTrustForwardingHeaders() throws Exception {
        var source = org.mockito.Mockito.mock(MarketplaceSource.class);
        org.mockito.Mockito.when(source.getForWrite("item_1")).thenReturn(MarketplaceTest.sample());
        var views = org.mockito.Mockito.mock(org.thymeleaf.spring6.view.ThymeleafViewResolver.class);
        var view = org.mockito.Mockito.mock(org.springframework.web.servlet.View.class);
        org.mockito.Mockito.when(views.resolveViewName(org.mockito.ArgumentMatchers.eq("marketplace"), org.mockito.ArgumentMatchers.any())).thenReturn(view);
        String edge = "https://localhost:8080";
        var mvc = MockMvcBuilders.standaloneSetup(new MarketplaceController(source, views, edge)).build();
        for (String invalid : List.of("", "ftp://localhost:8080", "https://user@localhost:8080",
                edge + "/", edge + "?", edge + "#fragment", "https://localhost:65536", "https://localhost:443"))
            assertThrows(IllegalArgumentException.class, () -> new MarketplaceController(source, views, invalid));
        record Case(String host, String origin, String site, boolean forged, int status) {}
        for (var c : List.of(
                new Case("localhost:8080", edge, "same-origin", false, 200),
                new Case("127.0.0.1:8080", "http://127.0.0.1:8080", "same-origin", false, 200),
                new Case("localhost:8080", "http://localhost:8080", "same-origin", true, 403),
                new Case("localhost:8080", "https://localhost:8081", "same-origin", true, 403),
                new Case("localhost:8080", "https://wrong.test:8080", "same-origin", true, 403),
                new Case("127.0.0.1:8080", edge, "same-origin", true, 403),
                new Case("localhost:8080", edge, "cross-site", false, 403),
                new Case("localhost:8080", null, "same-origin", false, 403))) {
            var request = post("/marketplace/en-US/item_1").header("Host", c.host())
                    .header("Sec-Fetch-Site", c.site()).contentType("application/x-www-form-urlencoded")
                    .content("email=edge%40example.test&target_price=12.50");
            if (c.origin() != null) request.header("Origin", c.origin());
            if (c.forged()) {
                var claimed = java.net.URI.create(c.origin());
                request.header("Forwarded", "proto=" + claimed.getScheme() + ";host=\"" + claimed.getAuthority() + "\"")
                        .header("X-Forwarded-Proto", claimed.getScheme()).header("X-Forwarded-Host", claimed.getAuthority());
            }
            var result = mvc.perform(request).andReturn();
            assertEquals(c.status(), result.getResponse().getStatus(), c.toString());
            var session = result.getRequest().getSession(false);
            if (c.status() == 200)
                assertEquals(List.of(new Alerts.Alert("item_1", "edge@example.test", 1250)), Alerts.read(session));
            else
                assertNull(session);
        }
    }

    @Test void failedOrErrorStatusViewDoesNotAppendOrExposePartialHtml() throws Exception {
        var source = org.mockito.Mockito.mock(MarketplaceSource.class);
        org.mockito.Mockito.when(source.getForWrite("item_1")).thenReturn(MarketplaceTest.sample());
        var views = org.mockito.Mockito.mock(org.thymeleaf.spring6.view.ThymeleafViewResolver.class);
        var view = org.mockito.Mockito.mock(org.springframework.web.servlet.View.class);
        org.mockito.Mockito.when(views.resolveViewName(org.mockito.ArgumentMatchers.eq("marketplace"), org.mockito.ArgumentMatchers.any())).thenReturn(view);
        var controller = new MarketplaceController(source, views, null);
        org.mockito.Mockito.doAnswer(call -> {
            var response = call.getArgument(2, jakarta.servlet.http.HttpServletResponse.class);
            response.getWriter().write("partial");
            response.flushBuffer();
            throw new IllegalStateException("render failed");
        }).when(view).render(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        var request = new MockHttpServletRequest("POST", "/marketplace/en-US/item_1");
        var response = new MockHttpServletResponse();
        assertThrows(IllegalStateException.class, () -> controller.show("en-US", "item_1", "", "asc", "", "a@b", "1", request, response, new ExtendedModelMap()));
        assertNull(request.getSession(false));
        assertFalse(response.isCommitted());
        assertEquals("", response.getContentAsString());
        org.mockito.Mockito.doAnswer(call -> {
            call.getArgument(2, jakarta.servlet.http.HttpServletResponse.class).setStatus(500);
            return null;
        }).when(view).render(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        controller.show("en-US", "item_1", "", "asc", "", "a@b", "1", request, response, new ExtendedModelMap());
        assertEquals(500, response.getStatus());
        assertNull(request.getSession(false));
    }
}
