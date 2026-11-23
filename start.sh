set -eu
mkdir -p /m && tar -xf /root/cycles-1983.tar -C /m
nohup sh -c 'sh /m/1983/setup.sh > /root/setup-1983.log 2>&1 && sh /m/1983/run.sh > /m/1983/run.out 2>&1; echo ALL-DONE-WRAPPER >> /root/setup-1983.log' >/dev/null 2>&1 &
echo started
