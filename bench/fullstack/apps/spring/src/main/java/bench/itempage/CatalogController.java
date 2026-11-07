package bench.itempage;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
public class CatalogController {
    private final CatalogSource catalog;
    public CatalogController(CatalogSource catalog) { this.catalog = catalog; }

    @GetMapping("/catalog/{id}")
    public String show(@PathVariable String id, @RequestParam(defaultValue = "") String field, Model model, HttpServletResponse res) {
        var record = catalog.get(id);
        if (record == null) { res.setStatus(404); return "not-found"; }
        model.addAttribute("catalog", record);
        model.addAttribute("pageTitle", record.title());
        model.addAttribute("catalogPage", true);
        model.addAttribute("prefix", field);
        model.addAttribute("fields", record.fields().stream().filter(f -> f.name().startsWith(field)).toList());
        return "catalog";
    }

    @GetMapping("/api/catalog/{id}")
    @ResponseBody
    public ResponseEntity<CatalogRecord> json(@PathVariable String id) {
        var record = catalog.get(id);
        return record == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(record);
    }
}
