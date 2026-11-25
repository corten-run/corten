#!/bin/sh
set -eu

app=$(cd "$1" && pwd -P)
evidence=$(cd "$2" && pwd -P)
if [ ! -r "$evidence" ]; then
    echo "Spring proof cannot check the evidence directory; use mktemp -d for each run." >&2
    exit 1
fi
for entry in "$evidence"/* "$evidence"/.[!.]* "$evidence"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
        echo "Spring proof requires an empty evidence directory; use mktemp -d for each run." >&2
        exit 1
    fi
done
proof=$(cd "$(dirname "$0")" && pwd -P)
scratch=$(cd "${TMPDIR:-/tmp}" && pwd -P)
work=$(mktemp -d "$scratch/spring-transport-proof.XXXXXXXX")
case "$work" in "$scratch"/spring-transport-proof.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM

# Extend a disposable copy, not the timed project or its existing test classpath.
mkdir "$work/mvc" "$work/webflux"
cp "$app/pom.xml" "$work/mvc/"
cp -R "$app/.mvn" "$work/mvc/"
cp -R "$app/src" "$work/mvc/"
java_tests="$work/mvc/src/test/java/bench/itempage"
mkdir -p "$java_tests/transport"
cp "$proof/mvc/MarketplaceDisconnectHttpTest.java" "$java_tests/"
cp "$proof/src/test/java/bench/itempage/transport/DisconnectSockets.java" "$java_tests/transport/"
cp "$proof/pom.xml" "$work/webflux/"
cp -R "$app/.mvn" "$work/webflux/"
cp -R "$proof/src" "$work/webflux/"

# Each copy has the app's .mvn, so it reaches Maven Central through the same mirror, with strict
# checksums, as the image does (#1763). Each Maven run has a fixed budget: with .mvn/maven.config's
# per-request retries it ends well inside hosted CI's 12-minute step, which leaves time to write both
# reports. Maven logs each transfer, so a run stopped here names the one in flight.
maven_seconds=270

run_probe() {
    mode=$1
    suite=$2
    shift 2
    project="$work/$mode"
    status=0
    timeout --verbose --kill-after=10s "$maven_seconds" mvn -B -f "$project/pom.xml" "-Dtest=$suite" -DfailIfNoTests=true test "$@" || status=1
    java "$proof/SurefireEvidence.java" "$mode" "$project/target/surefire-reports" "$evidence/$mode-surefire.txt" || status=1
    return "$status"
}

result=0
run_probe mvc MarketplaceDisconnectHttpTest || result=1
run_probe webflux WebFluxDisconnectHttpTest -Dscope=test dependency:tree || result=1
exit "$result"
