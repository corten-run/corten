package bench.itempage;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@Controller
public class MarketplaceController {
    private final MarketplaceSource source;
    public MarketplaceController(MarketplaceSource source) { this.source = source; }

    @RequestMapping(value = "/marketplace/{locale}/{id}", method = {RequestMethod.GET, RequestMethod.POST})
    public String show(@PathVariable String locale, @PathVariable String id,
            @RequestParam(defaultValue = "") String seller, @RequestParam(defaultValue = "asc") String sort,
            @RequestParam(defaultValue = "") String offers, @RequestParam(defaultValue = "") String email,
            @RequestParam(name = "target_price", defaultValue = "") String target, HttpServletRequest request,
            HttpServletResponse response, Model model) {
        if (!MarketplaceFormat.supported(locale)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        boolean post = "POST".equals(request.getMethod());
        if (post) {
            String origin = request.getHeader("Origin");
            if ("cross-site".equals(request.getHeader("Sec-Fetch-Site")) ||
                    (origin != null && !origin.equals(request.getScheme() + "://" + request.getHeader("Host"))))
                throw new ResponseStatusException(HttpStatus.FORBIDDEN);
            response.setHeader("Cache-Control", "private, no-store");
        }
        var record = source.get(id);
        if (record == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        var format = new MarketplaceFormat(locale);
        sort = "desc".equals(sort) ? "desc" : "asc";
        model.addAttribute("record", record);
        model.addAttribute("f", format);
        model.addAttribute("t", format.getText());
        model.addAttribute("locale", locale);
        model.addAttribute("marketplacePage", true);
        model.addAttribute("pageTitle", record.title());
        model.addAttribute("prefix", seller);
        model.addAttribute("sort", sort);
        model.addAttribute("allOffers", "all".equals(offers));
        model.addAttribute("listings", MarketplaceFormat.listings(record, seller, sort));
        model.addAttribute("offers", "all".equals(offers) ? record.offers() : record.offers().subList(0, Math.min(5, record.offers().size())));
        var result = post ? format.validateAlert(email, target, record.title()) : new MarketplaceFormat.AlertResult("", null);
        model.addAttribute("message", result.message());
        if (result.targetMinor() != null)
            Alerts.append(request.getSession(), new Alerts.Alert(id, email, result.targetMinor()));
        return "marketplace";
    }

    @GetMapping("/api/alerts")
    @ResponseBody
    public ResponseEntity<java.util.List<Alerts.Alert>> alerts(HttpServletRequest request) {
        return ResponseEntity.ok().header("Cache-Control", "private, no-store").body(Alerts.read(request.getSession(false)));
    }

    @GetMapping("/api/marketplace/{id}")
    @ResponseBody
    public ResponseEntity<MarketplaceRecord> json(@PathVariable String id) {
        var record = source.get(id);
        if (record == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return ResponseEntity.ok(record);
    }
}
