set -eu
mkdir -p /m && tar -xf /root/cycles-1846r2.tar -C /m
nohup sh -c 'sh /m/1846r2/setup.sh > /root/setup-1846r2.log 2>&1 && sh /m/1846r2/run.sh > /m/1846r2/run.out 2>&1; echo ALL-DONE-WRAPPER >> /root/setup-1846r2.log' >/dev/null 2>&1 &
echo started
