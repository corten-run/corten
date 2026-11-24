I=httparena-corten:var
R=/root/work/httparena-gap/HttpArena
docker rm -f -v pcc-echo pcc-s >/dev/null 2>&1
docker run -d --name pcc-echo --network host --cpuset-cpus=40-47 -e ARENA_MODE=echo $I >/dev/null
sleep 1
for envs in "-e ARENA_MODE=default" "-e ARENA_MODE=default -e ARENA_DELAY=thread -e ARENA_TIMER=alt -e ARENA_LIFO=off -e ARENA_GQI=31 -e ARENA_EVI=31 -e ARENA_WORKERS=12 -e ARENA_POOL_KIND=main" "-e ARENA_MODE=percore-builtin -e ARENA_DELAY=thread -e ARENA_POOL_KIND=percore" "-e ARENA_MODE=percore-builtin -e ARENA_POOL_KIND=main -e ARENA_DELAY=none"; do
  docker run -d --name pcc-s --network host --cpuset-cpus=0-23 -v $R/data/dataset.json:/data/dataset.json:ro $envs $I >/dev/null
  sleep 1.5
  echo "== $envs"
  for u in "/baseline11?a=1&b=2" /delay/10 /sdelay/10 /pool /spool /delay/0; do
    printf '%s -> ' "$u"; curl -s -m 5 -w ' [%{http_code} %{time_total}s]\n' "http://localhost:8080$u"
  done
  docker logs pcc-s 2>&1 | tail -3
  ls /proc/$(docker inspect -f '{{.State.Pid}}' pcc-s)/task | wc -l
  docker rm -f -v pcc-s >/dev/null
done
docker rm -f -v pcc-echo >/dev/null
