// Serialized into a captured production module by fleet-production.test.mjs.
// Only external boundaries are synthetic. Never import this from a CLI module.
export function syntheticDependencies(config, { fs, path, createProviderEngine, bootstrapMarker, bootstrapReadScript }) {
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const local = path.join(config.stateDir, "groups-r21");
  const state = () => JSON.parse(fs.readFileSync(path.join(local, "state.json")));
  const hosts = () => fs.existsSync(config.hosts) ? JSON.parse(fs.readFileSync(config.hosts)) : [];
  const record = (event) => fs.appendFileSync(config.trace, `${JSON.stringify({ group: config.group, ...event })}\n`);
  const spawn = (binary, argv, options) => {
    record({ boundary: binary, argv, options: { cwd: options.cwd, shell: options.shell, windowsHide: options.windowsHide,
      timeout: options.timeout, maxBuffer: options.maxBuffer, input: options.input, stdio: options.stdio } });
    if (binary === "git") {
      if (argv[0] === "rev-parse") return good(argv[1] === "HEAD" ? config.commit : config.repo);
      if (argv[0] === "status" || argv[0] === "cat-file" || argv[0] === "fetch" || argv[0] === "merge-base") return good();
      if (argv[0] === "show") return good(fs.readFileSync(path.join(config.repo, argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n"));
      if (argv[0] === "ls-remote") return good(`${config.commit}\trefs/heads/${config.mode === "advertisement" ? "foreign" : "main"}\n`);
    }
    if (binary === "ssh") {
      const script = options.input.slice("set -euo pipefail\n".length, -1), saved = state();
      if (script === bootstrapReadScript) {
        const marker = bootstrapMarker(saved);
        if (config.mode === "marker") marker.commit = "b".repeat(40);
        record({ boundary: "bootstrap-marker", marker });
        return good(`${JSON.stringify(marker)}\n`);
      }
      if (script.startsWith("systemctl show")) return good(`Id=${saved.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${saved.unit}\nActiveState=active\nRestart=no\nMainPID=123\nExecMainCode=0\nExecMainStartTimestamp=Sun 2026-11-15 00:00:00 UTC\n`);
      if (script === "true" || script === "mkdir -m 700 /bench && touch /bench/run.log"
        || script.includes("sha256sum --check --status") || script.startsWith("bash -n /bench/job.sh")
        || script === `systemctl start ${saved.unit}`) return good();
    }
    if (binary === "scp") {
      const from = argv.at(-2);
      record({ boundary: "upload", from, to: argv.at(-1), content: fs.readFileSync(from, "utf8") });
      return good();
    }
    throw new Error(`unexpected synthetic boundary ${binary}`);
  };
  return { repo: config.repo, spawn,
    sleep: async () => { throw new Error("unexpected synthetic sleep"); },
    providerFactory: ({ interrupted }) => {
      record({ boundary: "provider-factory" });
      const run = createProviderEngine({ repo: config.repo, interrupted,
        spawn: (binary, argv) => {
          record({ boundary: "synthetic-credential", binary, argv });
          if (binary !== "doctl" || argv[0] !== "auth" || argv[1] !== "token") throw new Error("synthetic credential boundary only");
          return good("SYNTHETIC_FLEET_CREDENTIAL\n");
        },
        request: async ({ method, path: endpoint, body, credential }) => {
          if (credential !== "SYNTHETIC_FLEET_CREDENTIAL") throw new Error("not a synthetic credential");
          record({ boundary: "provider", method, path: endpoint, body });
          if (endpoint === "/v2/account") return config.mode.startsWith("provider-failure")
            ? { status: 403, value: null } : { status: 200, value: { account: { uuid: config.userId, droplet_limit: 20 } } };
          if (method === "GET" && endpoint.startsWith("/v2/droplets?")) {
            const droplets = hosts(); return { status: 200, value: { droplets, meta: { total: droplets.length }, links: {} } };
          }
          if (method === "POST" && endpoint === "/v2/droplets") {
            const saved = state();
            if (saved.status !== "creating" || !saved.createIntentAt) throw new Error("create must follow durable intent");
            const droplets = hosts(), id = droplets.length + 101;
            const droplet = { id, name: body.name, tags: body.tags, size_slug: body.size, region: { slug: body.region },
              networks: { v4: [{ type: "public", ip_address: `192.0.2.${id - 100}` }] } };
            fs.writeFileSync(config.hosts, JSON.stringify([...droplets, droplet]));
            return { status: 202, value: { droplet, links: { actions: [{ id: id + 1000, rel: "create", href: `https://api.digitalocean.com/v2/actions/${id + 1000}` }] } } };
          }
          if (method === "GET" && /^\/v2\/droplets\/\d+$/.test(endpoint)) {
            return { status: 200, value: { droplet: hosts().find((row) => row.id === Number(endpoint.split("/").at(-1))) } };
          }
          if (method === "GET" && /^\/v2\/actions\/\d+$/.test(endpoint)) {
            const id = Number(endpoint.split("/").at(-1));
            return { status: 200, value: { action: { id, type: "create", resource_id: id - 1000, resource_type: "droplet", status: "completed" } } };
          }
          throw new Error("unexpected synthetic REST operation");
        } });
      let closing;
      run.close = () => closing ??= (async () => {
        record({ boundary: "settlement-enter" });
        if (config.mode === "provider-failure-unsettled") throw Object.assign(new Error("synthetic unsettled provider"), { controlUncertain: true });
        record({ boundary: "settlement-complete" });
      })();
      return run;
    } };
}
