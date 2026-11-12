// Browser smoke test for Corten's own site, in Chromium, Firefox and WebKit: the page with its
// scripts, with them blocked by the page's own switch, and with scripting off in the browser; and
// on a touch screen, in Chromium, whose touches the test can send one at a time; and the plate
// behind the page, built and drawn by Chromium's software renderer, and read. The server says
// how much CPU and memory is in use: its machine's, or, with SITE_HELD=1, of the limits the
// container under test is held to on both (docker run --cpus 1 --memory 512m).
// Usage: node examples/corten-site/smoke.mjs http://localhost:18488 [chromium|firefox|webkit ...]
import { readFileSync } from "node:fs";
import { chromium, devices, firefox, webkit } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { stall } from "../../scripts/stall.mjs";

const base = process.argv[2];
if (!base) throw new Error("usage: node examples/corten-site/smoke.mjs <base url> [chromium|firefox|webkit ...]");
const kinds = { chromium, firefox, webkit };
const engines = /** @type {(keyof typeof kinds)[]} */ (process.argv.slice(3));
if (engines.length === 0) engines.push("chromium", "firefox", "webkit");
const held = process.env.SITE_HELD === "1";
/** What each of the last two gauges is called: of a limit the server is held to, or the machine's. */
const called = held ? ["CPU in use", "Memory in use"] : ["CPU this machine is using", "Memory this machine is using"];
/** The engine the checks are running in. @type {keyof typeof kinds} */
let engine = "chromium";
const failures = [];
const seen = stall(5);
const check = (name, ok, detail = "") => {
  seen(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${engine}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${engine}: ${name}`);
};

/** The elements a selector matches that are not behind a closed disclosure, as page source. @param {string} selector */
const shown = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => !el.closest("details:not([open])"))`;
const sideways = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;

/** @type {import("@playwright/test").Browser} */
let browser;

/**
 * A page of the site in a context of its own, with what its console said was wrong.
 * @param {import("@playwright/test").BrowserContextOptions} options @param {string} [path]
 */
async function open(options, path = "/") {
  const context = await browser.newContext({ reducedMotion: "reduce", ...options });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + path, { waitUntil: "load" });
  return { context, page, errors };
}

for (engine of engines) {
  if (!(engine in kinds)) throw new Error(`no engine ${engine}`);
  browser = steady(await kinds[engine].launch({ headless: true }));
  try {
  // With its scripts, on a desktop.
  {
    const { context, page, errors } = await open({ viewport: { width: 1440, height: 900 } });
    const body = await page.locator("body").innerText();
    const counted = /(\d+) components\. (\d+) have a script/i.exec(body);
    check("the page counts its components and scripts", counted !== null, counted?.[0]);
    check("no sideways scroll", (await page.evaluate(sideways)) === 0);

    // The component taken apart: one name lit by the server, the rest followed by the script.
    const lit = () => page.evaluate(`${shown("[data-seam][data-lit]")}.map((el) => el.dataset.seam + "@" + el.closest("pre").getAttribute("aria-label"))`);
    const first = /** @type {string[]} */ (await lit());
    check("one name is lit at load, in two files", first.length === 2 && new Set(first).size === 2 && first.every((name) => name.startsWith("call:order@")), first.join(" "));
    const seams = /** @type {[string, number][]} */ (
      await page.evaluate(
        `(() => { const by = {}; for (const el of ${shown("[data-seam]")}) (by[el.dataset.seam] ??= new Set()).add(el.closest("pre").getAttribute("aria-label")); return Object.entries(by).map(([seam, files]) => [seam, files.size]); })()`,
      )
    );
    check("every marked name in the cuts is in two files", seams.length >= 4 && seams.every(([, files]) => files >= 2), JSON.stringify(seams));
    for (const [label, seam] of [
      ["ref={grid}", "ref:grid"],
      ["class={Grid}", "class:grid"],
      ["js::order(..)", "call:order"],
    ]) {
      const button = page.locator("section button", { hasText: label });
      await button.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      await button.click();
      await page.waitForFunction(`${shown("[data-seam][data-lit]")}.every((el) => el.dataset.seam === ${JSON.stringify(seam)})`);
      const now = /** @type {string[]} */ (await lit());
      check(`the button ${label} follows its name`, now.length >= 2 && now.every((name) => name.startsWith(`${seam}@`)), String(now.length));
      check(`the button ${label} leaves the window where it is`, (await page.evaluate(() => scrollY)) === before);
    }
    const name = page.locator("pre [data-seam='ref:readout']").first();
    await name.scrollIntoViewIfNeeded();
    await name.hover();
    await page.waitForFunction(`${shown("[data-seam][data-lit]")}.every((el) => el.dataset.seam === "ref:readout")`);
    check("pointing at a name follows it", true);
    const whole = page.locator("summary", { hasText: "in full" });
    await whole.click();
    check("the whole files open at their tops", (await page.evaluate(() => [...document.querySelectorAll("details pre")].every((pane) => pane.scrollTop === 0 && pane.scrollLeft === 0))) === true);
    check("a class the cuts leave out is marked in the whole files", (await page.locator("details pre [data-seam='class:heat0']").count()) >= 2);
    await whole.click();

    // The wall: 1,000 samples the browser puts in order with no request.
    let requests = 0;
    const count = () => (requests += 1);
    page.on("request", count);
    const order = page.getByRole("link", { name: "Put them in order" });
    await order.scrollIntoViewIfNeeded();
    await order.click();
    await page.waitForFunction(() => {
      const readings = [...document.querySelectorAll("[data-ref='tiles']")].map((tile) => Number(tile.getAttribute("data-key")));
      return readings.length === 1000 && readings.every((reading, at) => at === 0 || /** @type {number} */ (readings[at - 1]) <= reading);
    });
    check("the wall sorts in the browser with no request", requests === 0, `${requests} requests`);
    // The readout says what that took.
    const readout = page.locator("output", { hasText: "samples put in order" });
    await readout.waitFor();
    const took = /^1,000 samples put in order: ([\d.,]+) ms of script, ([\d.,]+) ms from the click to the next frame drawn\. Requests sent: 0\.$/.exec(await readout.innerText());
    check("the readout says what the sort took", took !== null, await readout.innerText());
    // A second and a third click are handed every tile too.
    const keys = () => page.evaluate(() => [...document.querySelectorAll("[data-ref='tiles']")].map((tile) => Number(tile.getAttribute("data-key"))));
    await page.getByRole("link", { name: "Scatter them" }).click();
    await page.locator("output", { hasText: "samples scattered" }).waitFor();
    const scattered = await keys();
    check("scattering keeps every tile and puts them out of order", new Set(scattered).size === 1000 && scattered.some((key, at) => key !== at), `${new Set(scattered).size} tiles`);
    const pressed = Date.now();
    await order.click();
    await page.locator("output", { hasText: "samples put in order" }).waitFor();
    const waited = Date.now() - pressed;
    const again = await keys();
    check("and they are put in order again", again.length === 1000 && again.every((key, at) => key === at), `${again.length} tiles`);
    // The frame's time counts from the click: it cannot be longer than this test waited for it.
    const frame = Number(/, ([\d,]+) ms from the click/.exec(await readout.innerText())?.[1]?.replace(/,/g, ""));
    check("the time it gives from the click is no longer than the click took", frame >= 0 && frame <= waited + 50, `${frame} ms said, ${waited} ms waited`);
    check("all of it with no request", requests === 0, `${requests} requests`);
    page.off("request", count);

    // The seam's breaks need no script: a radio button picks the compiler's answer.
    check("five breaks are offered", (await page.locator("fieldset input[type=radio]").count()) === 5);
    await page.locator("fieldset label", { hasText: "Hand a handler the wrong element" }).click();
    check("a break shows what the compiler said", await page.getByText("the handler takes an HTMLDivElement").first().isVisible());

    // The strip along the bottom is the browser's own count: the server's time for this page
    // (Server-Timing), what the load cost, and every request since. A request counts as the
    // load's until a second after it, so the strike below waits that out.
    const strip = (/** @type {string} */ label) =>
      page.evaluate(
        (label) => [...document.querySelectorAll("aside p")].find((cell) => cell.firstElementChild?.textContent === label)?.querySelector("output")?.textContent ?? "",
        label,
      );
    await page.waitForFunction(() => {
      const [loaded] = performance.getEntriesByType("navigation");
      return loaded instanceof PerformanceNavigationTiming && loaded.loadEventEnd > 0 && performance.now() > loaded.loadEventEnd + 1200;
    });
    check("the strip has the server's time for this page", /^[\d,]+ µs for this page$/.test(await strip("Server took")), await strip("Server took"));
    check("the strip counts the load", /^\d+ requests, [\d.,]+ KB, ready in [\d,]+ ms$/.test(await strip("To load")), await strip("To load"));
    const since = async () => Number.parseInt(await strip("Since"), 10);
    const settled = await since();

    // Striking a plate is one patch, and the plate tells the page around it: the typed event
    // reaches the element whose handler strikes the plate behind the page. The page says the
    // patch is about a kilobyte and that the first strike loads two small files beside it.
    await page.evaluate(() => {
      const world = document.querySelector("canvas[aria-hidden=true]")?.parentElement;
      world?.addEventListener("plate-struck", (event) => {
        document.documentElement.dataset.struck = String(/** @type {Event & { number?: number }} */ (event).number);
      });
    });
    /** @type {string[]} */
    const asked = [];
    const note = (/** @type {import("@playwright/test").Request} */ req) => asked.push(`${req.method()} ${new URL(req.url()).pathname}`);
    page.on("request", note);
    const patch = page.waitForResponse((res) => res.request().method() === "POST" && res.url().endsWith("/strike"));
    await page.locator("input[name=name]").fill("Smoke Shop");
    await page.getByRole("button", { name: "Strike the plate" }).click();
    const answer = await patch;
    check("a strike is answered with a patch", answer.status() === 200 && (answer.headers()["content-type"] ?? "").includes("html"), `${answer.status()}`);
    await page.getByText("smoke-shop").first().waitFor();
    check("the patch lands on the plate", true);
    check("the page did not reload for it", new URL(page.url()).search === "");
    const patched = (await answer.body()).length;
    check("the patch is about a kilobyte", patched > 500 && patched < 2048, `${patched} B`);
    await page.waitForLoadState("networkidle");
    page.off("request", note);
    check("the first strike sends the form and loads two files", asked.length === 3 && asked[0] === "POST /strike" && asked.slice(1).every((ask) => ask.startsWith("GET ") && ask.endsWith(".js")), asked.join(", "));
    const struck = await page.evaluate(() => document.documentElement.dataset.struck ?? "");
    check("the plate tells the page around it that it was struck", Number(struck) >= 1, struck);
    // A count that never gets there is the check's to report, not a timeout's.
    await page
      .waitForFunction(
        (was) => Number.parseInt([...document.querySelectorAll("aside p")].find((cell) => cell.firstElementChild?.textContent === "Since")?.querySelector("output")?.textContent ?? "", 10) >= was + 3,
        settled,
        { timeout: 10_000 },
      )
      .catch(() => {});
    check("the strip counts the strike's three requests", (await since()) === settled + 3, `${settled} before, then ${await strip("Since")}`);
    check("the strip names the last request", /^\/\S+: [\d.,]+ KB in [\d,]+ ms$/.test(await strip("Last request")), await strip("Last request"));

    // The server's readings arrive as a live stream; in the image it reads its own memory too.
    // Each reading replaces its element, so they are read from the page rather than held as locators.
    const reading = (label) =>
      page.evaluate((label) => [...document.querySelectorAll("dl dt")].find((dt) => dt.textContent.includes(label))?.nextElementSibling?.textContent ?? "", label);
    await page.evaluate(() => [...document.querySelectorAll("dl")].find((dl) => dl.textContent?.includes("Up for"))?.scrollIntoView());
    const before = await reading("Up for");
    await page.waitForFunction((was) => [...document.querySelectorAll("dl dt")].find((dt) => dt.textContent.includes("Up for"))?.nextElementSibling?.textContent !== was, before);
    check("the readings stream", before !== "");
    // A size is written with its thousands apart: "1,024.0 MiB".
    const size = (/** @type {string} */ text) => Number.parseFloat(text.replaceAll(",", ""));
    const mib = size(await reading("Memory this server holds"));
    check("the server reads the memory it holds", mib > 0 && mib < 512, `${mib} MiB`);
    // The CPU is counted between two readings, so its meter comes with the second. Each gauge is
    // read in one look at the page: the next reading replaces all of them.
    await page.waitForFunction(() => document.querySelectorAll("dl meter").length === 2, null, { timeout: 10_000 }).catch(() => {});
    const gauges = /** @type {{ label: string, figure: string, value: number, high: number, said: string, note: string, width: number, height: number }[]} */ (
      await page.evaluate(() =>
        [...document.querySelectorAll("dl meter")].map((meter) => {
          const gauge = meter.closest("div");
          const box = meter.getBoundingClientRect();
          return {
            label: document.getElementById(meter.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
            figure: gauge?.querySelector("dd")?.textContent ?? "",
            value: /** @type {HTMLMeterElement} */ (meter).value,
            high: /** @type {HTMLMeterElement} */ (meter).high,
            said: meter.getAttribute("aria-valuetext") ?? "",
            note: gauge?.lastElementChild?.textContent ?? "",
            width: box.width,
            height: box.height,
          };
        }),
      )
    );
    const [cpu, memory] = gauges;
    check("the server reads the CPU in use, and says whose", gauges.length === 2 && cpu?.label === called[0] && /^\d+%$/.test(cpu.figure) && cpu.value <= 100, JSON.stringify(cpu));
    check("its meter is at the figure", cpu !== undefined && cpu.value === Number.parseInt(cpu.figure, 10) && cpu.high === 80, JSON.stringify(cpu));
    check("and the memory in use, and says whose", memory?.label === called[1] && size(memory.figure) > 0, JSON.stringify(memory));
    check("its meter is read as the sizes", memory !== undefined && memory.said.startsWith(`${memory.figure.replace(" MiB", "")} of `) && memory.value > 0 && memory.value <= 100, JSON.stringify(memory));
    check("each meter is a thin bar across its gauge", gauges.length === 2 && gauges.every((gauge) => gauge.height >= 4 && gauge.height <= 8 && gauge.width > 200), JSON.stringify(gauges.map((gauge) => [gauge.width, gauge.height])));
    check(
      "each says what it is a part of",
      held ? cpu?.note === "of a limit of 1 CPU" && memory?.note === "of a limit of 512.0 MiB" : /^this server: \d+%$/.test(cpu?.note ?? "") && /^of [\d,.]+ MiB$/.test(memory?.note ?? ""),
      `${cpu?.note} | ${memory?.note}`,
    );
    check("the readout says how many followed at most", /^[1-9][\d,]* at most$/.test(await page.evaluate(() => [...document.querySelectorAll("dl dt")].find((dt) => dt.textContent === "Pages following this stream")?.parentElement?.lastElementChild?.textContent ?? "")));
    // A machine that gives a container fewer CPUs than it has is one the page says so of, so
    // only a limit of memory is held to being absent with no limit set.
    const hosted = (await page.locator("body").innerText()).match(/The machine serving you this has (\d+) CPUs? and ([\d,.]+) MiB of memory, by the system's count.*/)?.map(String) ?? [];
    check("the page says what serves it", hosted.length === 3 && (held ? /\. This server is held to 1 CPU and 512\.0 MiB of memory\./.test(hosted[0]) : !/This server is held to .*MiB/.test(hosted[0])), hosted[0]);
    check(
      "a meter under a limit is read as of that limit",
      held ? cpu?.said === `${cpu?.value}% of a limit of 1 CPU` && / of a limit of 512\.0 MiB$/.test(memory?.said ?? "") : cpu?.said === "" && !/limit/.test(memory?.said ?? ""),
      `${cpu?.said} | ${memory?.said}`,
    );

    // The response read back, and the same address as JSON. A header the response lacked is
    // written in as that, in words, so every value is held to being a header's.
    const etag = page.locator("dd[data-header=etag]");
    await etag.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => (document.querySelector("dd[data-header=etag]")?.textContent ?? "").length > 2);
    const sent = /** @type {Record<string, string>} */ (
      await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("dd[data-header]")].map((dd) => [dd.getAttribute("data-header"), dd.textContent ?? ""])))
    );
    const lacking = Object.entries(sent).filter(([, value]) => value === "" || /not sent/.test(value)).map(([name]) => name);
    check("each header the page lists was sent", Object.keys(sent).length === 9 && lacking.length === 0, lacking.join(" "));
    check("the page was sent compressed, with a validator", /^(zstd|br|gzip)$/.test(sent["content-encoding"] ?? "") && /^(W\/)?"/.test(sent.etag ?? ""), `${sent["content-encoding"]} ${sent.etag}`);
    check("its policy and its timing are the server's", /script-src/.test(sent["content-security-policy"] ?? "") && /^app;dur=/.test(sent["server-timing"] ?? ""));
    check("the status is written in", (await page.locator("figure output").first().innerText()) === "HTTP 200");
    const json = await page.request.get(`${base}/`, { headers: { accept: "application/json" } });
    const sheet = (await json.json()).data;
    check("the same address answers JSON", json.ok() && sheet?.name === "Corten" && sheet.server.memory_held_bytes > 0 && sheet.server.machine_cpus > 0, JSON.stringify(sheet?.server));
    const server = sheet?.server ?? {};
    check(
      "with how much is in use",
      server.machine_memory_used_bytes > 0 && server.machine_memory_used_bytes <= (server.machine_memory_limit_bytes ?? server.machine_memory_bytes) && Number.isInteger(server.machine_cpu_used_percent) && server.machine_cpu_used_percent <= 100,
      JSON.stringify(server),
    );
    // On the machine itself this server's part is said, and is no more than the whole; under a
    // limit the count is the server's group's already.
    check(
      "and whose count that is",
      held
        ? server.machine_memory_limit_bytes === 512 * 1048576 && server.machine_cpu_limit === 1 && server.cpu_used_percent === null
        : server.machine_memory_limit_bytes === null && server.machine_cpu_limit === null && Number.isInteger(server.cpu_used_percent) && server.cpu_used_percent <= server.machine_cpu_used_percent,
      JSON.stringify(server),
    );
    // The page's sentence and its JSON say the same machine: a size is written to a tenth of a MiB.
    check(
      "and the machine is the one the page says",
      Number(hosted[1]) === server.machine_cpus && size(hosted[2] ?? "") === Math.round(server.machine_memory_bytes / 104857.6) / 10 && server.server_cpus > 0 && (!held || server.server_cpus === 1),
      `${hosted[0]} | ${JSON.stringify(server)}`,
    );
    // With no limit, a server given fewer CPUs than the machine has is said to be held to
    // them, and the gauges are then not pointed at; one given them all is pointed at its gauges.
    const some = !held && server.server_cpus < server.machine_cpus;
    check(
      "and what it says of the CPUs follows the counts",
      / This server is held to \d[\d.]* CPUs?[ .]/.test(hosted[0] ?? "") === (held || some) && / The readings above say how much of each is in use\.$/.test(hosted[0] ?? "") === !some,
      `${hosted[0]} | ${JSON.stringify(server)}`,
    );

    // Counted before the page is left: a browser may log the live stream the next load cuts off.
    check("no console errors", errors.length === 0, errors.join(" | "));

    // The bar's links to the page are the browser's to follow (`data-reload`): the lockup loads
    // the page afresh, so nothing a script left on the window is still there.
    await page.evaluate(() => Reflect.set(window, "smokeWasHere", true));
    const loaded = page.waitForEvent("load", { timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    await page.locator("a[aria-label=Corten]").first().click();
    check("the lockup loads the page in full", (await loaded) && (await page.evaluate(() => Reflect.has(window, "smokeWasHere"))) === false);
    await context.close();
  }

  // The plate. A browser under test has no GPU, and the page then keeps its flat layers by its
  // own choice (it asks for a context that fails where drawing would be slow), so nothing above
  // runs the shader. Here that choice is taken away, in Chromium, whose software renderer can
  // build it (Playwright starts Chromium with the switch that allows that renderer): the
  // program builds, a frame is drawn, and what is drawn under the steel section's type is no
  // brighter than that type can stand. The drawing is kept after each frame so it can be read.
  if (engine === "chromium") {
    const context = await browser.newContext({ viewport: { width: 1280, height: 360 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    /** @type {string[]} */
    const said = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && said.push(m.text()));
    page.on("pageerror", (e) => said.push(`thrown: ${e.message}`));
    await page.addInitScript(() => {
      const ask = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, options) {
        return ask.call(this, kind, kind === "webgl2" ? { ...options, failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: true } : options);
      };
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    const state = await page.waitForSelector("[data-forged], [data-flat]", { state: "attached", timeout: 45_000 }).then(
      (world) => world.evaluate((el) => ("forged" in /** @type {HTMLElement} */ (el).dataset ? "forged" : "flat")),
      () => "neither forged nor flat in 45 s",
    );
    const able = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
    // The software renderer has warnings of its own (a stall on a read, say). The page's own, a
    // call WebGL refused and anything thrown all count.
    const wrong = () => said.filter((text) => /^corten\.run:|^thrown:|INVALID_|GL ERROR/.test(text));
    check(
      "the plate's shader builds and a frame is drawn",
      state === "forged" && wrong().length === 0,
      [state === "forged" ? "" : `${state}; ${able ? "the browser has" : "this browser gave no"} WebGL 2 context`, ...wrong()].filter(Boolean).join(" | ").slice(0, 400),
    );
    if (state === "forged") {
      // With reduced motion the light stays where it starts, 68% across the window and 30% down.
      // The section's two ends are read, from where its type may begin: a window's height from
      // as far inside each as the shader holds its light from (its INSET, 48px), where another
      // layer's rust reaches in. Nearer its ends than that the light is not held, so the
      // section's padding must keep its type further in.
      const inset = Number(/^const float INSET = ([0-9.]+);/m.exec(readFileSync(new URL("./src/world.js", import.meta.url), "utf8"))?.[1]);
      /** @type {{ most: number, mean: number, error: number, padding: number, ember: string }[]} */
      const read = [];
      for (const end of ["top", "end"]) {
        read.push(
          await page.evaluate(async ([end, inset]) => {
            const steel = /** @type {HTMLElement} */ (document.getElementById("steel"));
            const box = steel.getBoundingClientRect();
            const top = box.top + window.scrollY;
            window.scrollTo(0, end === "top" ? top + inset : top + box.height - inset - window.innerHeight);
            for (let n = 0; n < 3; n++) await new Promise((next) => requestAnimationFrame(next));
            const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("canvas"));
            const gl = /** @type {WebGL2RenderingContext} */ (canvas.getContext("webgl2"));
            const px = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const linear = (/** @type {number} */ v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            let [most, sum] = [0, 0];
            for (let n = 0; n < px.length; n += 4) {
              const light = 0.2126 * linear(px[n] / 255) + 0.7152 * linear(px[n + 1] / 255) + 0.0722 * linear(px[n + 2] / 255);
              most = Math.max(most, light);
              sum += light;
            }
            const style = getComputedStyle(steel);
            const padding = Math.min(parseFloat(style.paddingTop), parseFloat(style.paddingBottom));
            const ember = getComputedStyle(document.documentElement).getPropertyValue("--ember").trim();
            return { most, mean: sum / (px.length / 4), error: gl.getError(), padding, ember };
          }, /** @type {const} */ ([end, inset])),
        );
      }
      // The amber of the page's code (--ember, #f2a44b) is the dimmest small type set straight
      // on the plate there: what it keeps 4.5 to 1 over is the bound (0.06319).
      const linear = (/** @type {number} */ v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const [red, green, blue] = (/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(read[0]?.ember ?? "") ?? []).slice(1).map((hex) => linear(parseInt(hex, 16) / 255));
      const amber = 0.2126 * (red ?? NaN) + 0.7152 * (green ?? NaN) + 0.0722 * (blue ?? NaN);
      const bound = (amber + 0.05) / 4.5 - 0.05;
      check(
        "what is drawn under the steel's type is lit, and no brighter than its dimmest type can stand",
        read.every(({ most, mean, error }) => error === 0 && mean > 0.01 && most <= bound) && wrong().length === 0,
        [`bound ${bound.toFixed(5)} for ${read[0]?.ember}`, ...read.map(({ most, mean, error }) => `brightest ${most.toFixed(4)}, mean ${mean.toFixed(4)}${error ? `, error ${error}` : ""}`), ...wrong()].join(" | ").slice(0, 400),
      );
      check(
        "and the section's padding keeps its type further in than the light is held from",
        read.every(({ padding }) => padding >= inset),
        `${read[0]?.padding}px, held from ${inset}px`,
      );
    }
    await context.close();
  }

  // Above a phone the gauges are three to a row. They are narrowest just above a phone, and
  // again just above the width where the readout moves beside its text (62rem): nothing in one
  // is wider than it at either.
  {
    const { context, page } = await open({ viewport: { width: 1000, height: 800 }, javaScriptEnabled: false });
    for (const width of [1000, 580]) {
      await page.setViewportSize({ width, height: 800 });
      // A part too wide for its gauge is as wide as what it holds, so it is measured against the gauge.
      const over = await page.evaluate(() =>
        [...document.querySelectorAll("#readout dt, #readout dd")]
          .filter((part) => {
            const gauge = /** @type {HTMLElement} */ (part.parentElement);
            return part.getBoundingClientRect().right > gauge.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(gauge).paddingRight) + 1;
          })
          .map((part) => part.textContent),
      );
      check(`at ${width} px no reading is wider than its gauge`, over.length === 0, over.join(" | "));
    }
    await context.close();
  }

  // With every script blocked by the page's own switch: one more policy, which the browser enforces.
  {
    const { context, page, errors } = await open({ viewport: { width: 1440, height: 900 } }, "/?scripts=off");
    check("blocked: the notes keep the names, as text", (await page.locator("section button", { hasText: "ref={grid}" }).count()) === 0 && (await page.locator("p code", { hasText: "ref={grid}" }).count()) === 1);
    check("blocked: a name is lit by the server", (await page.evaluate(`${shown("[data-seam][data-lit]")}.length`)) === 2);
    check("blocked: nothing offers what only a script does", !(await page.locator("body").innerText()).includes("Point at another name"));
    await page.getByRole("link", { name: "Put them in order" }).click();
    await page.waitForURL(/wall=sorted/);
    const sorted = await page.evaluate(() => {
      const readings = [...document.querySelectorAll("[data-ref='tiles']")].map((tile) => Number(tile.getAttribute("data-key")));
      return readings.length === 1000 && readings.every((reading, at) => at === 0 || /** @type {number} */ (readings[at - 1]) <= reading);
    });
    check("blocked: the server sorts the wall", sorted && new URL(page.url()).searchParams.get("scripts") === "off");
    await page.locator("input[name=name]").fill("Smoke Shop");
    await page.getByRole("button", { name: "Strike the plate" }).click();
    await page.waitForURL(/plate=smoke-shop/);
    check("blocked: the form posts and the page comes back struck", (await page.getByText("smoke-shop").count()) > 0 && new URL(page.url()).searchParams.get("scripts") === "off");
    // What the console holds is the browser refusing the page's scripts, which is the policy at work.
    const other = errors.filter((e) => !/Content[- ]Security[- ]Policy/i.test(e));
    check("blocked: the browser refused the scripts, and nothing else went wrong", (engine !== "chromium" || errors.length > 0) && other.length === 0, other.join(" | "));
    await context.close();
  }

  // With scripting off in the browser, on a phone.
  {
    const { context, page } = await open({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const follow = page.locator("section button", { hasText: "ref={grid}" });
    const style = await follow.evaluate((button) => ({ events: getComputedStyle(button).pointerEvents, border: getComputedStyle(button).borderTopWidth }));
    check("no script: a follow button is the name as text", style.events === "none" && style.border === "0px", JSON.stringify(style));
    check("no script: a name is lit", (await page.locator("pre [data-seam][data-lit]").count()) >= 2);
    check("no script: no sideways scroll", (await page.evaluate(sideways)) === 0);
    await page.locator("summary", { hasText: "in full" }).click();
    check("no script: the whole files open", await page.locator("details pre").first().isVisible());
    // Playwright's text selectors pass over <noscript>, so the command is found by its element.
    check("no script: the page says how to read its headers", (await page.locator("noscript code", { hasText: "curl -sI --compressed" }).count()) === 1);
    await context.close();
  }

  // On a touch screen: a tap follows a name, a swipe over one does not.
  if (engine === "chromium") {
    const { context, page, errors } = await open({ ...devices["Pixel 7"] });
    const lit = () => page.evaluate(`[...new Set(${shown("[data-seam][data-lit]")}.map((el) => el.dataset.seam))].join(" ")`);
    const button = page.locator("section button", { hasText: "class={Grid}" });
    await button.scrollIntoViewIfNeeded();
    await button.tap();
    await page.waitForFunction(`${shown("[data-seam][data-lit]")}.every((el) => el.dataset.seam === "class:grid")`);
    check("touch: a button follows its name", true);
    const name = page.locator("pre [data-seam='ref:readout']").first();
    await name.scrollIntoViewIfNeeded();
    await name.tap();
    await page.waitForFunction(`${shown("[data-seam][data-lit]")}.every((el) => el.dataset.seam === "ref:readout")`);
    check("touch: a tap on a name follows it", true);
    const box = await page.locator("pre [data-seam='ref:grid']").first().boundingBox();
    if (!box) throw new Error("the grid's name has no box");
    const client = await context.newCDPSession(page);
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    for (let step = 1; step <= 6; step += 1) await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x, y: at.y - step * 25 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    check("touch: a swipe over a name does not follow it", (await lit()) === "ref:readout", String(await lit()));
    check("touch: no sideways scroll", (await page.evaluate(sideways)) === 0);
    check("touch: no console errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  } finally {
    await browser.close();
  }
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
