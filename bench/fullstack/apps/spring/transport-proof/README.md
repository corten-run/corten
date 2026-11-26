# Spring HTTP/1.1 disconnect probe

Transport proof for [#1302 Benchmark parity: Spring Boot in approved workload groups](https://github.com/corten-run/corten/issues/1302).
This is not a marketplace port, a Mixed qualification result, or a deployment
choice. The original Spring build and benchmark selection still use MVC/Tomcat.

From the repository root on a POSIX host with JDK 27, Maven 3.10 (the app image's;
`.mvn/maven.config` needs 3.9.2 or later for `${session.rootDirectory}`) and `timeout`
from coreutils, explicitly opt in to both probes:

```sh
spring=bench/fullstack/apps/spring
evidence=$(mktemp -d)
sh "$spring/transport-proof/run.sh" "$spring" "$evidence"
```

Use a new empty evidence directory for each run. The runner refuses a nonempty
directory before starting either probe and does not remove any existing reports.
Both copies take the app's `.mvn`, so their Maven reaches Maven Central through Google's
mirror of it with strict checksums, as the image's does
([#1763 Catalog CI: Spring image build could not resolve the pinned Maven parent POM](https://github.com/corten-run/corten/issues/1763)).
Each Maven run is sent SIGTERM at 270 seconds and killed if it is still running 10 seconds
later, so with the app's per-request retries (`.mvn/maven.config`) both runs fit hosted CI's
12-minute step, 9m20s with their kill grace, which leaves a nominal 2m40s for setup and the
reports, which run outside those limits. A run stopped before Surefire starts writes no
report, and the proof then fails.

The timed Dockerfile copies only the ordinary `pom.xml`, `.mvn` and `src` and still
runs `package -DskipTests`. That flag skips execution, not compilation, so **all**
probe sources live in this separate tree. The runner adds the MVC probe and its
fixture only to a disposable copy of the real MVC project; the WebFlux POM pins
the same Spring Boot 4.1.2 parent and uses its own test classpath. Hosted CI
checks the clean package's test classes before running either proof.

The runner prints the WebFlux test dependency tree and exports only the two
selected Surefire suites, as bounded names and outcomes in `$evidence` (including
`mvcCallerAbortLeavesUpstreamPending`). It never exports raw XML, properties,
logs, failure details, or other Maven output. The fixture
uses ephemeral IPv4 loopback ports. It sends the complete keep-alive GET and
checks the exact upstream method, path and trace before waiting 50 ms for no
downstream bytes. The fixture never releases the held exchange on a timer.

| Route and control | Required observation |
| --- | --- |
| Real matched MVC marketplace page on Tomcat, caller closes | Upstream stays pending at 500 ms, before fixture teardown. This is an asserted negative, not a deliberately failing test. |
| Test-only WebFlux route on Reactor Netty, caller closes | Upstream EOF or peer reset within 500 ms, before fixture teardown, for held headers and for a partial body already received by WebClient. Other socket errors fail. |
| Caller stays connected on either stack | Upstream is still pending at 500 ms, and caller sees no response until explicit release, then receives a native 200 with the expected marker. |

The WebFlux route returns the exchange and full body consumption in one request
subscription, with no retry, redirect, response timeout or interim output. It has
no application rendering, middleware, session or write behavior. A local pass
would establish only this loopback HTTP/1.1 behavior, not a specific native Netty
transport. The unchanged Mixed driver, all locales, and production qualification
still need separate evidence.
