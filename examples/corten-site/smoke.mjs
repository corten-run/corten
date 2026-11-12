// Browser smoke test for Corten's own site, in Chromium, Firefox and WebKit: the page with its
// scripts, with them blocked by the page's own switch, and with scripting off in the browser; and
// on a touch screen, in Chromium, whose touches the test can send one at a time. The server says
// how much CPU and memory is in use: its machine's, or, with SITE_HELD=1, of the limits the
// container under test is held to on both (docker run --cpus 1 --memory 512m).
// Usage: node examples/corten-site/smoke.mjs http://localhost:18488 [chromium|firefox|webkit ...]
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
    check("the cuts mark no unchecked name", seams.every(([seam]) => !seam.startsWith("data:")));
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
    check("the unchecked name is marked in the whole files", (await page.locator("details pre [data-seam='data:reading']").count()) >= 2);
    await whole.click();

    // The wall: 1,000 samples the browser puts in order with no request.
    let requests = 0;
    const count = () => (requests += 1);
    page.on("request", count);
    const order = page.getByRole("link", { name: "Put them in order" });
    await order.scrollIntoViewIfNeeded();
    await order.click();
    await page.waitForFunction(() => {
      const readings = [...document.querySelectorAll("[data-reading]")].map((tile) => Number(tile.getAttribute("data-reading")));
      return readings.length === 1000 && readings.every((reading, at) => at === 0 || /** @type {number} */ (readings[at - 1]) <= reading);
    });
    check("the wall sorts in the browser with no request", requests === 0, `${requests} requests`);
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
      held ? /^of the [\d.]+ CPUs? this server is held to$/.test(cpu?.note ?? "") && /^of the [\d,.]+ MiB this server is held to$/.test(memory?.note ?? "") : /^this server: \d+%$/.test(cpu?.note ?? "") && /^of [\d,.]+ MiB$/.test(memory?.note ?? ""),
      `${cpu?.note} | ${memory?.note}`,
    );
    check("the readout says how many followed at most", /^[1-9][\d,]* at most$/.test(await page.evaluate(() => [...document.querySelectorAll("dl dt")].find((dt) => dt.textContent === "Pages following this stream")?.parentElement?.lastElementChild?.textContent ?? "")));
    check("the page says what serves it", (held ? /This server is held to [\d.]+ CPUs? and [\d,.]+ MiB of memory/ : /The machine serving you this has \d+ CPUs? and [\d,.]+ MiB of memory/).test(await page.locator("body").innerText()));

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
      server.machine_memory_used_bytes > 0 && server.machine_memory_used_bytes <= server.machine_memory_bytes && Number.isInteger(server.machine_cpu_used_percent) && server.machine_cpu_used_percent <= 100,
      JSON.stringify(server),
    );
    // On the machine itself this server's part is said, and is no more than the whole; under a
    // limit the count is the server's already.
    check(
      "and whose count that is",
      held
        ? server.machine_memory_limited === true && server.machine_cpu_limit > 0 && server.cpu_used_percent === null
        : server.machine_memory_limited === false && server.machine_cpu_limit === null && Number.isInteger(server.cpu_used_percent) && server.cpu_used_percent <= server.machine_cpu_used_percent,
      JSON.stringify(server),
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
      const readings = [...document.querySelectorAll("[data-reading]")].map((tile) => Number(tile.getAttribute("data-reading")));
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
