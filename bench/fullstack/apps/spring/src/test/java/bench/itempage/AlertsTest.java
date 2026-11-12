package bench.itempage;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
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

    @Test void validationAndCrossSiteRequestsNeverAppend() {
        var source = org.mockito.Mockito.mock(MarketplaceSource.class);
        org.mockito.Mockito.when(source.get("item_1")).thenReturn(MarketplaceTest.sample());
        var controller = new MarketplaceController(source);
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
}
