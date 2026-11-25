# Spring HTTP/1.1 disconnect probe

Transport proof for [#1302 Benchmark parity: Spring Boot in approved workload groups](https://github.com/corten-run/corten/issues/1302).
This is not a marketplace port, a Mixed qualification result, or a deployment
choice. The original Spring build and benchmark selection still use MVC/Tomcat.

From the repository root, on a host with JDK 27 and Maven (the app image uses
Maven 3.10), run the two test projects separately:

```sh
mvn -B -f bench/fullstack/apps/spring/pom.xml -Dtest=MarketplaceDisconnectHttpTest test
mvn -B -f bench/fullstack/apps/spring/transport-proof/pom.xml -Dtest=WebFluxDisconnectHttpTest test
mvn -B -f bench/fullstack/apps/spring/transport-proof/pom.xml dependency:tree -Dscope=test
```

The isolated test POM pins the same Spring Boot 4.1.2 parent as MVC. Retain the
resolved dependency tree and Surefire reports with any native result. The fixture
uses ephemeral IPv4 loopback ports. It sends the complete keep-alive GET and
checks the exact upstream method, path and trace before waiting 50 ms for no
downstream bytes. The fixture never releases the held exchange on a timer.

| Route and control | Required observation |
| --- | --- |
| Real matched MVC marketplace page on Tomcat, caller closes | Upstream stays pending at 500 ms, before fixture teardown. This is an asserted negative, not a deliberately failing test. |
| Test-only WebFlux route on Reactor Netty, caller closes | Upstream EOF or reset within 500 ms, before fixture teardown, for held headers and for a partial body already received by WebClient. |
| Caller stays connected on either stack | Upstream is still pending at 500 ms, and caller sees no response until explicit release, then receives a native 200 with the expected marker. |

The WebFlux route returns the exchange and full body consumption in one request
subscription, with no retry, redirect, response timeout or interim output. It has
no application rendering, middleware, session or write behavior. A local pass
would establish only this loopback socket behavior; the unchanged Mixed driver,
all locales, and production qualification still need separate evidence.
