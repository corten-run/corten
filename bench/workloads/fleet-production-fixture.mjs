// Serialized into a captured production module by fleet-production.test.mjs.
// Only external boundaries are synthetic. Never import this from a CLI module.
export function syntheticDependencies(config, { fs, path, fork, providerTransport, bootstrapMarker, bootstrapReadScript }) {
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const local = path.join(config.stateDir, "groups-r21");
  const state = () => JSON.parse(fs.readFileSync(path.join(local, "state.json")));
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
      return providerTransport({ repo: config.repo, interrupted, launch(binary, argv, options) {
        if (binary !== fs.realpathSync(process.execPath) || argv[0] !== "--input-type=module" || argv[1] !== "-"
          || argv[2] !== path.join(config.repo, "bench/workloads/cloud-provider-worker.mjs")) throw new Error("fixed provider launch required");
        const child = fork(path.join(config.repo, "bench/workloads/fleet-provider-test-worker.mjs"),
          [config.mode, config.trace, config.hosts, config.stateDir, config.group, config.userId],
          { ...options, execArgv: [], env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=64 --max-semi-space-size=4" } });
        record({ boundary: "provider-child-start", pid: child.pid });
        const observe = (direction, message) => record({ boundary: "provider-ipc", direction,
          schema: message?.schema, tokenIPC: JSON.stringify(message).includes("SYNTHETIC_FLEET_CREDENTIAL") });
        child.on("message", (message) => observe("from-child", message));
        const send = child.send.bind(child);
        child.send = (message, ...rest) => { observe("to-child", message); return send(message, ...rest); };
        child.once("exit", (code, signal) => record({ boundary: "provider-child-exit", pid: child.pid, code, signal,
          terminal: child.exitCode !== null || child.signalCode !== null,
          fleetLock: fs.existsSync(path.join(path.dirname(config.stateDir), ".fleet-operation.lock")),
          launchLock: fs.existsSync(path.join(config.stateDir, ".groups-launch.lock")),
          operationLock: fs.existsSync(path.join(local, "operation.lock")) }));
        return child;
      } });
    } };
}
