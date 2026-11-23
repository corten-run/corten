// Serialized into a captured production module by fleet-production.test.mjs.
// Only external boundaries are synthetic. Never import this from a CLI module.
export function syntheticDependencies(config, { fs, path, fork, providerTransport, bootstrapMarker, bootstrapReadScript, bootstrapWorkspaceScript,
  controlRegistration, EventEmitter, PassThrough, Writable, registration }) {
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const local = path.join(config.stateDir, "groups-r21");
  const state = () => JSON.parse(fs.readFileSync(path.join(local, "state.json")));
  const record = (event) => fs.appendFileSync(config.trace, `${JSON.stringify({ group: config.group, ...event })}\n`);
  const launchKey = "synthetic launch SSH host key\n", known = path.join(local, "known_hosts");
  const hostKeyFile = (argv, mode) => {
    const entry = argv.find((arg) => arg.startsWith("UserKnownHostsFile="));
    const file = /^UserKnownHostsFile="([^"]+)"$/.exec(entry)?.[1];
    if (!file || !argv.includes(`StrictHostKeyChecking=${mode}`) || !argv.includes("GlobalKnownHostsFile=none")
        || !argv.includes("UpdateHostKeys=no")) throw new Error("unexpected SSH host-key options");
    return path.normalize(file);
  };
  const requirePinnedKey = (argv) => {
    const file = hostKeyFile(argv, "yes");
    if (file === known || fs.readFileSync(file, "utf8") !== launchKey) throw new Error("SSH must use the pinned launch key");
  };
  let readiness = 0, installed = false, started = false, quietMs = 0;
  let earlyWake = config.mode === "short-clock";
  const requireDrained = () => {
    if (!started || quietMs !== 135000) throw new Error("observation before post-start drain and proof");
  };
  const spawn = (binary, argv, options) => {
    let input = options.input, reply = good;
    const readinessProbe = binary === "ssh" && argv.at(-1) === "/bin/bash -s";
    if (readinessProbe) {
      if (state().control.ledger.length || input !== "set -euo pipefail\ntrue\n") throw new Error("unexpected untracked SSH");
    } else if (["ssh", "sftp"].includes(binary)) {
      requirePinnedKey(argv);
      const request = state().control.ledger.at(-1).request, control = controlRegistration(request);
      if ((binary === "ssh" ? argv.at(-1) : argv.at(-2)) !== control.command) throw new Error("unregistered synthetic command");
      if (binary === "ssh") {
        if (!input.startsWith(control.inputPrefix)) throw new Error("guardian input differs");
        input = input.slice(control.inputPrefix.length);
      }
      const id = request.invocation.id;
      reply = (stdout = "", status = 0) => ({ ...good(stdout), status, stderr: `CORTEN_CONTROL ${id} ${"d".repeat(64)}\nCORTEN_RESULT ${id} ${status}\n` });
    }
    record({ boundary: binary, argv, ...(binary === "ssh" ? { quietMs } : {}), options: { cwd: options.cwd, shell: options.shell, windowsHide: options.windowsHide,
      timeout: options.timeout, maxBuffer: options.maxBuffer, input, stdio: options.stdio } });
    if (binary === "git") {
      if (argv[0] === "rev-parse") return good(argv[1] === "HEAD" ? config.commit : config.repo);
      if (argv[0] === "status" || argv[0] === "cat-file" || argv[0] === "fetch" || argv[0] === "merge-base") return good();
      if (argv[0] === "show") return good(fs.readFileSync(path.join(config.repo, argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n"));
      if (argv[0] === "ls-remote") return good(`${config.commit}\trefs/heads/${config.mode === "advertisement" ? "foreign" : "main"}\n`);
    }
    if (binary === "ssh") {
      const script = input.slice("set -euo pipefail\n".length, -1), saved = state();
      if (script === `systemctl start ${saved.unit}`) {
        if (!installed || started || saved.quietBootstrap !== "prelogin") throw new Error("unexpected benchmark start");
        started = true;
        return reply();
      }
      if (installed || script === bootstrapReadScript || script.startsWith("systemctl show")) requireDrained();
      if (readinessProbe) {
        const file = hostKeyFile(argv, "accept-new");
        if (file !== known) throw new Error("unexpected launch SSH host-key file");
        if (++readiness === 1 && config.mode === "ssh-late") return { ...good(), status: 255 };
        fs.writeFileSync(file, launchKey, { flag: "wx" });
        return good();
      }
      if (script === bootstrapReadScript) {
        const marker = bootstrapMarker(saved);
        if (config.mode === "marker") marker.commit = "b".repeat(40);
        record({ boundary: "bootstrap-marker", marker });
        return reply(`${JSON.stringify(marker)}\n`);
      }
      if (script.startsWith("systemctl show")) return reply(`Id=${saved.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${saved.unit}\nActiveState=active\nRestart=no\nMainPID=123\nExecMainCode=0\nExecMainStartTimestamp=Sun 2026-11-15 00:00:00 UTC\n`);
      if (script === bootstrapWorkspaceScript(saved, { launch: true })) return reply("", config.mode === "owner-capture-fail" ? 1 : 0);
      if (script.startsWith("bash -n /bench/job.sh")) {
        if (!script.includes("90-corten-benchmark.conf") || !script.endsWith("systemctl daemon-reload"))
          throw new Error("missing quiet handoff policy");
        installed = true;
        return reply();
      }
      if (script === "true" || script.includes("sha256sum --check --status") || script === ":") return reply();
    }
    if (binary === "sftp") {
      if (installed) requireDrained();
      const [, from, to] = /^put "([^"]+)" "(\/bench\/[a-z0-9.-]+)"\n$/.exec(input);
      record({ boundary: "upload", from, to, content: fs.readFileSync(from, "utf8") });
      return reply();
    }
    throw new Error(`unexpected synthetic boundary ${binary}`);
  };
  const streamSpawn = (binary, argv, options) => {
    if (binary !== "ssh" || options.shell !== false) throw new Error("unexpected monitor boundary");
    requireDrained();
    requirePinnedKey(argv);
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex"));
    record({ boundary: "monitor", argv, options: { shell: options.shell, windowsHide: options.windowsHide } });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let sequence = 0, challenge = 0, challengedAt = 0, closed = false;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1",
      sequence: ++sequence, id: expected.id, kind, payload }) + "\n");
    const close = (code) => { if (!closed) { closed = true; clearInterval(timer); child.emit("close", code, null); } };
    child.stdin = new Writable({ write(data, _, next) {
      if (JSON.parse(data).kind === "close") setImmediate(() => close(0)); next();
    } });
    child.stdin.on("close", () => setImmediate(() => close(255)));
    setImmediate(() => {
      record({ boundary: "monitor-registered" });
      frame("registered", { ...registration, ...expected, host: { ...registration.host, hostname: state().name } });
      frame("progress", { state: "active" });
      record({ boundary: "remote-active", id: state().id });
    });
    const independent = config.mode === "independent-overlap", held = independent || !!config.holdUntilGroup;
    // A real peer keeps answering its monitor while provisioning the next
    // group. Model that rather than letting a slow test machine expire it.
    const deadline = Date.now() + (independent ? 90000 : held ? 30000 : 5000), timer = setInterval(() => {
      const peer = independent ? fs.existsSync(path.join(path.dirname(config.hosts), "finish-" + config.group))
        : !config.holdUntilGroup || fs.existsSync(path.join(path.dirname(config.stateDir), config.holdUntilGroup, "groups-r21/monitor-registration.json"));
      if (peer && state().control.sealed.includes("bootstrap")) {
        clearInterval(timer); record({ boundary: "monitor-terminal" }); frame("terminal", { id: expected.id, nativeTerminal: true,
          campaign: `${expected.binding.round}-${expected.binding.token}`, sealSha256: "f".repeat(64) });
      } else if (Date.now() > deadline) close(255);
      else if (held && sequence && Date.now() - challengedAt >= 250) {
        frame("challenge", { nonce: "a".repeat(32), sequence: ++challenge }); challengedAt = Date.now();
      }
    }, 10);
    return child;
  };
  return { repo: config.repo, spawn, streamSpawn,
    sleep: async (ms) => {
      if (started && quietMs < 135000 && ms === 1000) {
        if (earlyWake) earlyWake = false;
        else quietMs += ms;
        return;
      }
      if (installed || config.mode !== "ssh-late" || readiness !== 1) throw new Error("unexpected synthetic sleep");
    },
    providerFactory: ({ interrupted, createMode }) => {
      record({ boundary: "provider-factory" });
      return providerTransport({ repo: config.repo, interrupted, createMode, launch(binary, argv, options) {
        if (binary !== fs.realpathSync(process.execPath) || argv[0] !== "--input-type=module" || argv[1] !== "-"
          || argv[2] !== path.join(config.repo, "bench/workloads/cloud-provider-worker.mjs")) throw new Error("fixed provider launch required");
        const child = fork(path.join(config.repo, "bench/workloads/fleet-provider-test-worker.mjs"),
          [["ssh-late", "short-clock", "owner-capture-fail", "independent-overlap"].includes(config.mode) ? "success" : config.mode, config.trace, config.hosts, config.stateDir, config.group, config.userId],
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
