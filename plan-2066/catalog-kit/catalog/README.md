# The catalog's item page and item JSON

Scratch for one measurement, not repository documentation. The plan's section "The catalog's
`page` and `json`" declares everything here; these scripts do around the repository's
`bench/fullstack/count.mjs`, which is run as it is from the head's tree, the three things the rule
asks that are not the script's to do: comparing the two builds' answers before measuring,
alternating the builds, and working out the paired bound.

They are the catalog scripts of the Host check's gated kit, which ran them on a measuring host
(corten-run/corten pull request 2037), with the changes the plan's section lists: `commits.env`
names this plan's commits, `run.sh` names its rounds `p2066-`, `report.mjs` has this plan's
heading, and `setup.sh` takes a Debian 13 host the placement kit's `setup.sh` prepared. `build.sh`,
`verify.mjs`, `capture.mjs`, `../ask.mjs` and `../stats.mjs` are that kit's bytes.

On the plan's host (Debian 13 x64, 8 dedicated CPUs, root), after its last placement part has
ended, with the repository cloned at `/m/corten` and this tag fetched:

```sh
mkdir -p /m/hc/tree-base /m/hc/tree-head
git -C /m/corten archive evidence/shutdown-poll-plan plan-2066/catalog-kit | tar -x --strip-components=2 -C /m/hc
git -C /m/corten archive c6e9be955bedd2766795eab240e061c1b14ee5d0 | tar -x -C /m/hc/tree-base
git -C /m/corten archive 415cef7026e326c89c1bda2edd7aa580b1bb93ab | tar -x -C /m/hc/tree-head
echo c6e9be955bedd2766795eab240e061c1b14ee5d0 >/m/hc/tree-base.commit
echo 415cef7026e326c89c1bda2edd7aa580b1bb93ab >/m/hc/tree-head.commit
cp <items.json> /m/hc/tree-head/bench/fullstack/fixtures/items.json   # the copy whose SHA-256 the plan gives

sh /m/hc/catalog/setup.sh                                  # ends SETUP-DONE
sh /m/hc/catalog/build.sh base                             # cb-corten-base
DRYRUN=1 node /m/hc/catalog/verify.mjs                     # the base alone; ends VERIFY-OK (DRYRUN)
DRYRUN=1 sh /m/hc/catalog/run.sh                           # the base alone; ends DRYRUN-DONE

sh /m/hc/catalog/build.sh head                             # cb-corten-head
node /m/hc/catalog/verify.mjs                              # ends VERIFY-OK
nohup sh /m/hc/catalog/run.sh >/m/hc/catalog.out 2>&1 &    # over when catalog.out ends with ALL-DONE
node /m/hc/catalog/report.mjs /m/hc/tree-head/bench/fullstack/results
```

1. `setup.sh`: the host as `bench/fullstack/droplet.mjs` provisions one for `count.mjs`, the
   checks of what `count.mjs` needs, the items' digest, the host's record, and a unit that starts
   `run.sh` again after a restart of the host.
2. `build.sh <side>`: the side's image, and what the build used.
3. `verify.mjs`: `perf` on CPU 1, the bytes k6 sends (`capture.mjs`), and the answers.
4. `run.sh`: the invocations in the plan's order. None is run again.
5. `report.mjs`: the pairs and the bound. It compares the bound with +1% and prints nothing about
   the default band; the plan's reading is worked from the bound it prints.

State and records are under `/m/hc/catalog-state/`; `count.mjs`'s own output is under
`tree-head/bench/fullstack/results/<round>/`.
