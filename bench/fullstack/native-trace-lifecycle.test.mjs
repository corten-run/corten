import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const native = process.env.NATIVE_TRACE_COST_CLEANUP === '1';
const cost = new URL('./native-trace-cost.mjs', import.meta.url).href;

function fixture(mode, real = false) {
  return `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import http from 'node:http';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const mode = ${JSON.stringify(mode)}, real = ${real};
    const read = fs.readFileSync, exec = cp.execFileSync, create = http.createServer;
    const docker = (...args) => exec('docker', args, {encoding:'utf8',timeout:30000}).trim();
    const app = create((req,res) => res.end('same body'));
    await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
    const live = new Map(), removals = [], volumes = [], servers = [app];
    let foreign, controls = 0, serial = 0;
    const manifest = {runtimeImage:'mock',apps:{gin:{before:'virtual-before',after:'virtual-after'}}};
    fs.readFileSync = (path,...args) => String(path)==='/virtual/manifest.json' ? JSON.stringify(manifest)
      : /[\\\\/]server$/.test(String(path)) ? Buffer.from('binary') : read(path,...args);
    fs.mkdirSync = () => {}; fs.readdirSync = () => [];
    fs.writeFileSync = () => {}; fs.appendFileSync = () => {};
    http.createServer = (...args) => {
      const server = create(...args); servers.push(server);
      server.on('close',()=>console.log('UPSTREAM_CLOSED')); return server;
    };
    function allocate(name, labels) {
      const id = real ? docker('create','--pull=never','--name',name,'--network','none',
        '--label','agent.owner=codex','--label','agent.task=native-trace-lifecycle-test',
        '--label','test.pid='+process.pid,'--label','test.run=row7-lifecycle',...labels.flatMap(label=>['--label',label]),
        '-v','/owned-test-volume','alpine:3','sleep','120') : (++serial).toString(16).padStart(64,'0');
      live.set(id,{Id:id,Name:'/'+name,Config:{Labels:Object.fromEntries(labels.map(label=>label.split('=')))}});
      if(real) {
        volumes.push(...JSON.parse(docker('inspect','--format','{{json .Mounts}}',id)).map(m=>m.Name).filter(Boolean));
        docker('start',id);
      }
      return id;
    }
    cp.execFileSync = (file,args) => {
      assert.equal(file,'docker');
      const command=args[0], name=args[args.indexOf('--name')+1];
      if(command==='image') return 'image-id';
      if(command==='create'||command==='run') {
        const labels=args.flatMap((value,index)=>value==='--label'?[args[index+1]]:[]);
        if(mode==='collision') {
          foreign=allocate(name,['agent.owner=codex','agent.task=native-trace-cost','agent.run=foreign']);
          if(real) return docker('create','--name',name,'--label','agent.owner=codex',
            '--label','agent.task=native-trace-lifecycle-test','alpine:3','sleep','120');
          throw new Error('Conflict: foreign container');
        }
        const id=allocate(name,labels);
        if(mode==='partial') throw new Error('partial create failure');
        return id;
      }
      if(command==='inspect') {
        if(real) return docker(...args);
        const key=args.at(-1), value=live.get(key)??[...live.values()].find(row=>row.Name==='/'+key);
        if(!value) throw new Error('No such container');
        return args.includes('{{.State.Running}}')?'true':JSON.stringify(value);
      }
      if(command==='start') { if(mode==='start') throw new Error('start failure'); return args[1]; }
      if(command==='port') return '127.0.0.1:'+app.address().port;
      if(command==='logs') return '';
      if(command==='rm') {
        const key=args.at(-1); removals.push(key); console.log('REMOVE_ATTEMPT '+key);
        assert.ok(args.includes('-f')&&args.includes('-v'));
        if(mode==='signal-fail'&&removals.length===1) throw new Error('first removal failed');
        const row=live.get(key)??[...live.values()].find(row=>row.Name==='/'+key);
        if(real) docker('rm','-f','-v',key);
        if(row) live.delete(row.Id);
        return key;
      }
      throw new Error('unexpected docker call '+args);
    };
    cp.spawn = () => {
      const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough();
      child.kill=()=>{child.emit('exit',1);return true;};
      const index=++controls;
      if(index<=2) queueMicrotask(()=>child.emit('exit',0));
      else if(mode.startsWith('signal')) console.log('READY');
      else queueMicrotask(()=>child.emit('error',new Error('controller failure')));
      return child;
    };
    syncBuiltinESMExports();
    const target=${JSON.stringify(cost)};
    process.argv=[process.execPath,'fixture','/virtual/manifest.json','/virtual/output','gin'];
    try {
      const module=await import(target);
      // Older heads run on import; preserve that path for a genuine red-before result.
      if(module.run) await module.run();
      else { process.argv[1]=fileURLToPath(target); await import(target+'?run'); }
      assert.fail('operation must fail');
    } catch(error) {
      if(mode==='collision') {
        assert.match(error.message,/Conflict|already in use/);
        assert.ok(live.has(foreign),'foreign container must survive a name collision');
        assert.equal(removals.length,0,'must never attempt foreign removal');
        if(real) assert.equal(docker('inspect','--format','{{.Id}}',foreign),foreign);
      } else if(!mode.startsWith('signal')) {
        assert.match(error.message,mode==='partial'?/partial create failure/:/start failure/);
        assert.equal(live.size,0,'partial create/start must be cleaned');
        assert.equal(removals.length,1);
        assert.match(removals[0],/^[0-9a-f]{64}$/,'remove immutable owned IDs, not names');
      } else {
        assert.equal(removals.length,2,'signal must attempt both removals');
        assert.equal(live.size,mode==='signal-fail'?1:0);
        assert.equal(servers[1].listening,false);
        if(mode==='signal-fail') {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0],error.cause);
          assert.equal(error.errors[1].message,'first removal failed');
        }
        console.log('SIGNAL_ERROR '+(error.cause??error).message);
      }
      if(real&&mode!=='collision'&&mode!=='signal-fail') for(const volume of volumes) {
        assert.throws(()=>docker('volume','inspect',volume),'anonymous volume must be removed');
      }
    } finally {
      for(const id of live.keys()) if(real) docker('rm','-f','-v',id);
      for(const server of servers) if(server.listening) {
        server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
      }
      if(real) for(const volume of volumes) assert.throws(()=>docker('volume','inspect',volume));
    }
  `;
}

async function execute(code, signal, real = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (signal && !sent && stdout.includes('READY')) { sent = true; child.kill(signal); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), real ? 90_000 : 30_000);
  let result;
  try { result = await once(child, 'exit'); }
  finally {
    clearTimeout(timer);
    if (real) {
      const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=test.run=row7-lifecycle',
        '--filter', 'label=test.pid=' + child.pid], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
      for (const id of ids) execFileSync('docker', ['rm', '-f', '-v', id]);
    }
  }
  assert.deepEqual(result, [signal ? (signal === 'SIGINT' ? 130 : 143) : 0, null], stderr + stdout);
  if (signal) {
    assert.equal(sent, true);
    assert.equal((stdout.match(/^REMOVE_ATTEMPT /gm) ?? []).length, 2, stdout);
    assert.match(stdout, /UPSTREAM_CLOSED/);
    assert.match(stdout, new RegExp('SIGNAL_ERROR.*' + signal));
  }
}

for (const mode of ['collision', 'partial', 'start']) {
  test('cost driver preserves ownership on ' + mode, () => execute(fixture(mode)));
  test('native cost ownership on ' + mode, { skip: !native, timeout: 120_000 }, () => execute(fixture(mode, true), undefined, true));
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const mode of ['signal', 'signal-fail']) {
    test('Linux driver attempts both allocations on ' + signal + '/' + mode,
      { skip: process.platform !== 'linux' }, () => execute(fixture(mode), signal));
    test('native Linux driver attempts two containers/volumes on ' + signal + '/' + mode,
      { skip: !native || process.platform !== 'linux', timeout: 120_000 }, () => execute(fixture(mode, true), signal, true));
  }
}
