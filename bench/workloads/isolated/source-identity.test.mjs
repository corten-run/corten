import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
test("private replacement refs plus hidden matching working bytes cannot bind another source to current HEAD", { timeout: 300000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-source-identity-")), checkout = join(temporary, "repo");
  const git = (args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    // Replacement refs are repository-wide: never create them in a shared worktree.
    git(["clone", "--shared", "--no-checkout", "--no-hardlinks", repo, checkout]);
    execFileSync("git", ["checkout", "--detach", git(["rev-parse", "HEAD"])], { cwd: checkout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import cp from 'node:child_process'; import crypto from 'node:crypto';
      import {bindExecution,validateBinding} from './bench/workloads/isolated/contract.mjs';
      import {verifyWorkingSources} from './bench/workloads/isolated/worker.mjs';
      const env={...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}; delete env.GIT_NO_REPLACE_OBJECTS;
      delete process.env.GIT_NO_REPLACE_OBJECTS; process.env.GIT_NO_LAZY_FETCH='1';
      const git=(args,input)=>cp.execFileSync('git',args,{encoding:'utf8',input,env}).trim();
      const commit=git(['rev-parse','HEAD']),file='bench/catalog/fixtures.mjs',original=fs.readFileSync(file);
      const blob=git(['rev-parse',commit+':'+file]);
      const canonical=cp.execFileSync('git',['cat-file','blob',blob],{env});
      const bytes=Buffer.concat([original,Buffer.from('\\n// hostile replacement fixture\\n')]);
      const replacement=git(['hash-object','-w','--stdin'],bytes);
      try {
        git(['replace',blob,replacement]); git(['update-index','--assume-unchanged',file]); fs.writeFileSync(file,bytes);
        const b=bindExecution({group:'catalog-page',round:'c987654322',commit,recipe:'native-defaults',review:null});
        validateBinding(b);
        let workingRejected=false; try {verifyWorkingSources(b);} catch(error) {workingRejected=/executed working source differs/.test(error.message);}
        const actual=b.sources.files.find(f=>f.path===file).sha256;
        console.log(JSON.stringify({clean:git(['status','--porcelain'])==='',workingRejected,
          boundOriginal:actual===crypto.createHash('sha256').update(canonical).digest('hex'),
          poisoned:actual===crypto.createHash('sha256').update(bytes).digest('hex')}));
      } finally {fs.writeFileSync(file,original);git(['update-index','--no-assume-unchanged',file]);git(['replace','-d',blob]);}
    `], { cwd: checkout, windowsHide: true, encoding: "utf8", timeout: 240000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(output.trim()), { clean: true, workingRejected: true, boundOriginal: true, poisoned: false });
  } finally {
    assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}\\`) || resolve(temporary).startsWith(`${resolve(tmpdir())}/`));
    assert.equal(realpathSync(temporary), resolve(temporary)); rmSync(temporary, { recursive: true, force: true });
  }
});
