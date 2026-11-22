set -eu
mkdir -p /m && tar -xf /root/cycles-1923.tar -C /m
nohup sh -c 'sh /m/1923/setup.sh > /root/setup-1923.log 2>&1 && sh /m/1923/run.sh > /m/1923/run.out 2>&1; echo ALL-DONE-WRAPPER >> /root/setup-1923.log' >/dev/null 2>&1 &
echo started
