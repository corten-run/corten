set -eu
mkdir -p /m && tar -xf /root/cycles-1965.tar -C /m
nohup sh -c 'sh /m/1965/setup.sh > /root/setup-1965.log 2>&1 && sh /m/1965/run.sh > /m/1965/run.out 2>&1; echo ALL-DONE-WRAPPER >> /root/setup-1965.log' >/dev/null 2>&1 &
echo started