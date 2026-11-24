/* clockstep.c: moves a process's monotonic clock forward once, so an answer the process has
 * just kept is 10,005 seconds old to it without waiting two hours and three quarters.
 *
 * Preloaded (LD_PRELOAD) beside the allocator, it stands in front of the C library's
 * clock_gettime: every call is passed on, and a reading of CLOCK_MONOTONIC (the clock Rust's
 * Instant reads, and so the one a kept answer's age is taken from) has `step` seconds added.
 * `step` is 0 until the process is sent SIGUSR1, and CLOCKSTEP_SECONDS (the environment, read
 * once when the library loads) from then on. No other clock is changed: CLOCK_REALTIME, which
 * the Date header is written from, reads as it did.
 *
 * What it costs the measured request: each clock_gettime the server makes passes through this
 * function, one call more and a load of `step`, on both builds alike.
 *
 * Build: cc -O2 -fPIC -shared -o clockstep.so clockstep.c
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdlib.h>
#include <time.h>

static int (*real)(clockid_t, struct timespec *);
static long seconds;
static volatile long step;

static void stepped(int sig) {
    (void)sig;
    step = seconds;
}

__attribute__((constructor)) static void clockstep_init(void) {
    const char *asked = getenv("CLOCKSTEP_SECONDS");
    struct sigaction act = {0};
    real = (int (*)(clockid_t, struct timespec *))dlsym(RTLD_NEXT, "clock_gettime");
    seconds = asked ? strtol(asked, NULL, 10) : 0;
    act.sa_handler = stepped;
    act.sa_flags = SA_RESTART;
    sigemptyset(&act.sa_mask);
    sigaction(SIGUSR1, &act, NULL);
}

int clock_gettime(clockid_t id, struct timespec *ts) {
    int r;
    if (!real) real = (int (*)(clockid_t, struct timespec *))dlsym(RTLD_NEXT, "clock_gettime");
    r = real(id, ts);
    if (r == 0 && id == CLOCK_MONOTONIC) ts->tv_sec += step;
    return r;
}
