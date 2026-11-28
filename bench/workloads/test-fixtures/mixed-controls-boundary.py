"""Bounded synthetic control join, not native host qualification.

Runs each exact emitted shell/callee, with only metadata/systemd responses and
cancellation's synthetic Git identity substituted. Real files, descriptor/link
guards, real Git source scanning and the production control hashes are used.
A trace stops immediately AFTER all control checks, before signal or capture.
Requires fresh, private /bench, /etc/systemd/system and /var/lib/cloud scratch.
"""
import hashlib, json, os, pathlib, subprocess, sys, tempfile
sys.dont_write_bytecode = True  # leave no __pycache__ beside the fixture
from mixed_controls_repo import fixture_env, make_repo

os.umask(0o077)
value = json.load(sys.stdin)
bench = pathlib.Path('/bench')
assert bench.is_dir() and not any(bench.iterdir())
env = fixture_env(os.environ)
commit, tree = make_repo(bench / 'repo', env)
historical, current = value['original']['files'], value['current']
unit = next(name for name in historical if name.endswith('.service'))
assert historical['job.sh'] != current['job.sh']
cloud = pathlib.Path('/var/lib/cloud')
assert cloud.is_dir() and not any(cloud.iterdir())
services = pathlib.Path('/etc/systemd/system')
assert services.is_dir() and not any(services.iterdir())
(cloud / 'instances' / '619664120').mkdir(parents=True)
(cloud / 'instances' / '619664120' / 'user-data.txt').write_bytes(b'')
(cloud / 'data').mkdir()
(cloud / 'data' / 'instance-id').write_text('619664120\n')
(cloud / 'instance').symlink_to('/var/lib/cloud/instances/619664120')

# Startup instrumentation is test-only and never part of a generated command.
startup = r'''
import json, os, subprocess, sys, urllib.request
from types import SimpleNamespace
with open(os.environ['CONTROL_BOUNDARY_CASE']) as f: case = json.load(f)
program = case['program']
lines = program.splitlines()
boundary = lines.index(case['boundary']) + 1
control_start = lines.index(case['controlStart']) + 1
control_active = False
def trace(frame, event, arg):
    global control_active
    if frame.f_code.co_filename == '<stdin>':
        if event == 'line' and frame.f_lineno == control_start: control_active = True
        if event == 'line' and frame.f_lineno == boundary:
            print('CONTROL_BOUNDARY_ACCEPTED', flush=True)
            os._exit(77)
        if event == 'exception' and control_active and issubclass(arg[0], (AssertionError, OSError)):
            print('CONTROL_FILE_REFUSAL', file=sys.stderr, flush=True)
    return trace
original_loads = json.loads
first = True
def loads(raw, *args, **kwargs):
    global first
    data = original_loads(raw, *args, **kwargs)
    if first:
        first = False
        if case['kind'] == 'cancel':
            data['commit'], data['tree'] = case['commit'], case['tree']
    return data
json.loads = loads
class Metadata:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, n): return b'619664120'
urllib.request.build_opener = lambda *args: SimpleNamespace(open=lambda *args, **kwargs: Metadata())
urllib.request.urlopen = lambda *args, **kwargs: Metadata()
original_run = subprocess.run
def run(args, **kwargs):
    if args[:2] == ['systemctl', 'show']:
        fields = dict(Id=case['unit'], LoadState='loaded', FragmentPath='/etc/systemd/system/' + case['unit'],
            ActiveState='failed', Restart='no', MainPID='0', Job='', ExecMainCode='1', ExecMainStatus='2', ExecMainStartTimestamp='synthetic-start')
        return SimpleNamespace(returncode=0, stdout=''.join(k + '=' + v + '\n' for k,v in fields.items()))
    if args[:2] == ['systemctl', 'list-jobs']: return SimpleNamespace(returncode=0, stdout='')
    if args[:2] == ['cloud-init', 'status']: return SimpleNamespace(returncode=0, stdout='{"status":"done"}')
    return original_run(args, **kwargs)
subprocess.run = run
sys.settrace(trace)
'''

with tempfile.TemporaryDirectory(prefix='mixed-controls-') as scratch:
    root = pathlib.Path(scratch)
    (root / 'sitecustomize.py').write_text(startup)
    modes = ['original', 'changed-job', 'changed-pack', 'changed-unit', 'current-template', 'symlink-job', 'hardlink-job', 'symlink-unit', 'hardlink-unit']
    for kind, script in [('cancel', value['cancelScript']), ('custody', value['custodyScript'])]:
        # Shell remains byte-identical to the actual caller's emitted command.
        program = script.split("\n", 1)[1].rsplit('\n', 1)[0]
        assert program == value['cancelProgram'].rstrip('\n') if kind == 'cancel' else program.startswith('import configparser,')
        for mode in modes:
            paths = {name: bench / name for name in historical}
            paths['service'] = pathlib.Path('/etc/systemd/system') / unit
            for path in paths.values():
                if os.path.lexists(path): path.unlink()
            alias = bench / 'alias'
            if os.path.lexists(alias): alias.unlink()
            service_alias = services / 'alias'
            if os.path.lexists(service_alias): service_alias.unlink()
            for name, data in historical.items(): paths[name].write_text(data)
            paths['service'].write_text(historical[unit])
            target = paths['job.sh'] if mode.endswith('job') else paths['pack.sh'] if mode.endswith('pack') else paths[unit]
            if mode.startswith('changed-'):
                target.write_bytes(target.read_bytes() + b'# altered\n')
                if mode == 'changed-unit': paths['service'].write_bytes(paths['service'].read_bytes() + b'# altered\n')
            elif mode == 'current-template': paths['job.sh'].write_text(current['job.sh'])
            elif mode.startswith(('symlink-', 'hardlink-')):
                alias.write_bytes(target.read_bytes())
                target.unlink()
                if mode.startswith('symlink-'): target.symlink_to(alias)
                else: os.link(alias, target)
                if mode.endswith('unit'):
                    paths['service'].unlink()
                    service_alias.write_text(historical[unit])
                    if mode.startswith('symlink-'): paths['service'].symlink_to(service_alias)
                    else: os.link(service_alias, paths['service'])
            case = dict(kind=kind, program=program, commit=commit, tree=tree, unit=unit,
                boundary='anchor = time.monotonic()' if kind == 'cancel' else "    for base in ['/etc/systemd/system', '/run/systemd/system']:",
                controlStart="for name, expected in c['files'].items():" if kind == 'cancel' else "    for name, expected in c['files'].items():")
            case_path = root / 'case.json'
            case_path.write_text(json.dumps(case))
            result = subprocess.run(['/bin/bash'], input=script, env=dict(env, PYTHONPATH=str(root), CONTROL_BOUNDARY_CASE=str(case_path)),
                capture_output=True, text=True, timeout=15)
            accepted = result.returncode == 77 and 'CONTROL_BOUNDARY_ACCEPTED' in result.stdout
            assert accepted == (mode == 'original'), (kind, mode, result.returncode, result.stdout, result.stderr)
            if not accepted: assert result.returncode != 0 and 'CONTROL_FILE_REFUSAL' in result.stderr, (kind, mode, result.stderr)
            assert not (bench / 'mixed-cancel-intent.json').exists()
            assert not list(bench.glob('failed-native*')) and not (bench / 'results.tgz').exists()
            print(json.dumps(dict(kind=kind, mode=mode, acceptedOriginal=accepted, exit=result.returncode,
                jobSha256=hashlib.sha256(historical['job.sh'].encode()).hexdigest(), noRemoteIntent=True, noSignal=True, noCapture=True)), flush=True)
