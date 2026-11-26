import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.xml.sax.helpers.DefaultHandler;

class SurefireEvidence {
    private static final int RAW_LIMIT = 256 * 1024;

    public static void main(String[] args) {
        try {
            project(args[0], Path.of(args[1]), Path.of(args[2]));
        } catch (Exception failure) {
            // Parser errors, properties, stdout and failures can all contain private data.
            System.err.println("Missing or invalid scoped Spring Surefire report");
            System.exit(1);
        }
    }

    private static void project(String mode, Path reports, Path output) throws Exception {
        String suite;
        List<String> expected;
        switch (mode) {
            case "mvc" -> {
                suite = "bench.itempage.MarketplaceDisconnectHttpTest";
                expected = List.of("mvcCallerAbortLeavesUpstreamPending", "mvcConnectedCallerWaitsForRelease");
            }
            case "webflux" -> {
                suite = "bench.itempage.transport.WebFluxDisconnectHttpTest";
                expected = List.of("abortClosesHeldHeaders", "abortClosesPartialBody",
                        "connectedCallerKeepsHeldHeadersPending", "connectedCallerKeepsPartialBodyPending",
                        "onlyEofOrPeerResetCountsAsClose");
            }
            default -> throw new IOException();
        }

        var factory = DocumentBuilderFactory.newDefaultInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        var parser = factory.newDocumentBuilder();
        parser.setErrorHandler(new DefaultHandler());
        byte[] bytes;
        try (var input = Files.newInputStream(reports.resolve("TEST-" + suite + ".xml"))) {
            bytes = input.readNBytes(RAW_LIMIT + 1);
        }
        if (bytes.length > RAW_LIMIT) throw new IOException();

        Element root = parser.parse(new ByteArrayInputStream(bytes)).getDocumentElement();
        if (!root.getTagName().equals("testsuite") || !root.getAttribute("name").equals(suite)) throw new IOException();
        var results = new HashMap<String, String>();
        for (var node = root.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element test) || !test.getTagName().equals("testcase")) continue;
            String name = test.getAttribute("name");
            if (!suite.equals(test.getAttribute("classname")) || !expected.contains(name)) throw new IOException();
            String outcome = "passed";
            for (var child = test.getFirstChild(); child != null; child = child.getNextSibling()) {
                String tag = child.getNodeName();
                if (List.of("failure", "error", "skipped").contains(tag)) {
                    if (!outcome.equals("passed")) throw new IOException();
                    outcome = tag;
                }
            }
            if (results.put(name, outcome) != null) throw new IOException();
        }
        if (results.size() != expected.size() || !root.getAttribute("tests").equals("" + expected.size()))
            throw new IOException();
        // Emit only known identifiers and a fixed status vocabulary, not strings from the report.
        var text = new StringBuilder("Surefire cases: ").append(suite).append('\n');
        for (String name : expected) text.append(name).append('\t').append(results.get(name)).append('\n');
        Files.writeString(output, text);
        if (results.values().stream().anyMatch(outcome -> !outcome.equals("passed"))) System.exit(1);
    }
}
