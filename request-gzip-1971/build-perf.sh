#!/usr/bin/env bash
export DOCKER_CONFIG=/root/work/httparena-gap/docker-config
docker build -q -t httparena-gap-perf:gap -f /root/kit/perf.Dockerfile /root/work/httparena-gap/empty 2>&1 | tail -5
docker run --rm --privileged --pid=host httparena-gap-perf:gap sh -c 'perf --version; perf stat -e task-clock,cycles,instructions -a sleep 0.2 2>&1 | tail -12'
