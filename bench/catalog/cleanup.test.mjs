import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
test("Linux owned-container cleanup reaps detached descendants after their direct parent exits", { skip: process.env.CATALOG_DOCKER_TESTS !== "1", timeout: 180000 }, async () => {
  const id = `catalog-cleanup-${randomBytes(6).toString("hex")}`;
  const label = "run.corten.catalog.cleanup-test";
  const image = "node:24-bookworm-slim";
  const container = `${id}-check`;
  const observer = `${id}-observer`;
  const marker = `${id}-detached`;
  const active = new Set();
  const docker = (args, timeout = 20000) => {
    const result = spawnSync("docker", args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout });
    assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
  };
  const remove = (name) => {
    const info = JSON.parse(docker(["inspect", name]))[0];
    assert.equal(info.Config.Labels?.[label], id, "never remove an unrelated container");
    docker(["rm", "-f", info.Id]);
    active.delete(name);
  };
  try {
    if (spawnSync("docker", ["image", "inspect", image], { cwd: repo, stdio: "ignore", windowsHide: true, timeout: 20000 }).status !== 0) docker(["pull", image], 120000);
    const descendant = `process.title=${JSON.stringify(marker)};setInterval(()=>{},1000)`;
    const parent = `const{spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});fs.writeFileSync('/tmp/pids.json',JSON.stringify({parent:process.pid,detached:child.pid}));setInterval(()=>{},1000)`;
    const holder = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(parent)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`;
    active.add(container);
    docker(["run", "-d", "--name", container, "--label", `${label}=${id}`, "--network", "none", "--cpus", "1", "--memory", "128m", image, "node", "-e", holder]);
    let pids;
    const deadline = Date.now() + 10000;
    while (!pids && Date.now() < deadline) {
      const value = docker(["exec", container, "node", "-e", "const fs=require('fs');if(fs.existsSync('/tmp/pids.json'))console.log(fs.readFileSync('/tmp/pids.json','utf8'))"]);
      if (value) pids = JSON.parse(value);
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pids, "detached descendant started");
    // Reproduce the old Linux group-kill hole with an actual detached process:
    // the check-like direct child exits, but its detached browser-like child survives.
    docker(["exec", container, "node", "-e", `process.kill(-${pids.parent},'SIGTERM')`]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = JSON.parse(docker(["exec", container, "node", "-e", `const fs=require('fs');console.log(JSON.stringify({parentGone:!fs.existsSync('/proc/${pids.parent}'),detachedAlive:fs.existsSync('/proc/${pids.detached}')}))`]));
    assert.deepEqual(state, { parentGone: true, detachedAlive: true });
    const top = docker(["top", container, "-eo", "pid,args"]);
    const hostPid = top.split("\n").map((line) => line.trim()).find((line) => line.endsWith(` ${marker}`))?.split(/\s+/)[0];
    assert.match(hostPid ?? "", /^\d+$/, "identified only our marked detached process");
    // This is the runner's repaired strategy: removing the owned namespace/cgroup
    // is unconditional, independent of the client's or direct parent's exit status.
    remove(container);
    active.add(observer);
    const inspectProcess = `const fs=require('fs');let alive=false;try{alive=fs.readFileSync('/proc/${hostPid}/cmdline','utf8').replaceAll('\\0','').trim()===${JSON.stringify(marker)}}catch(e){if(e.code!=='ENOENT')throw e}console.log(JSON.stringify({ownedProcessSurvived:alive}))`;
    const observed = JSON.parse(docker(["run", "--name", observer, "--label", `${label}=${id}`, "--network", "none", "--pid", "host", "--cpus", "1", "--memory", "128m", image, "node", "-e", inspectProcess]));
    assert.deepEqual(observed, { ownedProcessSurvived: false });
    remove(observer);
    assert.equal(docker(["ps", "-a", "--filter", `label=${label}=${id}`, "--format", "{{.ID}}"]), "");
  } finally {
    for (const name of [...active].reverse()) remove(name);
  }
});
