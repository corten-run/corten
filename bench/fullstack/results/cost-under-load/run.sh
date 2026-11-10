set -e
cd /bench
docker network create rustbench >/dev/null 2>&1 || true
export BENCH_APP_CPUS=1 BENCH_LOAD_CPUS=4-7 AB_ROUNDS=3
bash bench/fullstack/cost-under-load.sh
cp -r bench/fullstack/results/cost-under-load /bench/out/
node bench/fullstack/cost-under-load.mjs /bench/out/cost-under-load/summary.json > /bench/out/costs.tsv
echo done
