package bench.itempage;

import jakarta.servlet.http.HttpSession;
import java.util.ArrayList;
import java.util.List;
import org.springframework.web.util.WebUtils;

/** One servlet session's alerts; all reads return a snapshot under the same mutex as writes. */
public final class Alerts {
    public record Alert(String itemId, String email, long targetMinor) {}
    private final List<Alert> rows = new ArrayList<>();

    public static void append(HttpSession session, Alert alert) {
        synchronized (WebUtils.getSessionMutex(session)) {
            var alerts = (Alerts) session.getAttribute(Alerts.class.getName());
            if (alerts == null) {
                alerts = new Alerts();
                session.setAttribute(Alerts.class.getName(), alerts);
            }
            alerts.rows.add(alert);
        }
    }

    public static List<Alert> read(HttpSession session) {
        if (session == null) return List.of();
        synchronized (WebUtils.getSessionMutex(session)) {
            var alerts = (Alerts) session.getAttribute(Alerts.class.getName());
            return alerts == null ? List.of() : List.copyOf(alerts.rows);
        }
    }
}
