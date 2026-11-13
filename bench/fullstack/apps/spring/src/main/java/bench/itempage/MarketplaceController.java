package bench.itempage;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.ContentCachingResponseWrapper;
import org.thymeleaf.spring6.view.ThymeleafViewResolver;

@Controller
public class MarketplaceController {
    private final MarketplaceSource source;
    private final ThymeleafViewResolver views;
    public MarketplaceController(MarketplaceSource source, ThymeleafViewResolver views) {
        this.source = source;
        this.views = views;
    }

    @RequestMapping(value = "/marketplace/{locale}/{id}", method = {RequestMethod.GET, RequestMethod.POST})
    public String show(@PathVariable String locale, @PathVariable String id,
            @RequestParam(defaultValue = "") String seller, @RequestParam(defaultValue = "asc") String sort,
            @RequestParam(defaultValue = "") String offers, @RequestParam(defaultValue = "") String email,
            @RequestParam(name = "target_price", defaultValue = "") String target, HttpServletRequest request,
            HttpServletResponse response, Model model) throws Exception {
        if (!MarketplaceFormat.supported(locale)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        boolean post = "POST".equals(request.getMethod());
        if (post) {
            String origin = request.getHeader("Origin");
            if ("cross-site".equals(request.getHeader("Sec-Fetch-Site")) ||
                    (origin != null && !origin.equals(request.getScheme() + "://" + request.getHeader("Host"))))
                throw new ResponseStatusException(HttpStatus.FORBIDDEN);
            response.setHeader("Cache-Control", "private, no-store");
        }
        var record = post ? source.getForWrite(id) : source.get(id);
        if (record == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        if (post) record.validateForWrite(id);
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
        if (result.targetMinor() != null) {
            // MVC normally renders after returning from the controller. Keep this write
            // pending until the complete native view has rendered without a partial response.
            var buffered = new ContentCachingResponseWrapper(response);
            var view = views.resolveViewName("marketplace", request.getLocale());
            if (view == null) throw new IllegalStateException("Missing marketplace view");
            view.render(model.asMap(), request, buffered);
            if (buffered.getStatus() >= 200 && buffered.getStatus() < 300)
                Alerts.append(request.getSession(), new Alerts.Alert(id, email, result.targetMinor()));
            buffered.copyBodyToResponse();
            return null;
        }
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
