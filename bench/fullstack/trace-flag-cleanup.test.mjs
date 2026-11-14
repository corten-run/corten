import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

for (const app of ['gin', 'drogon', 'topcoat']) for (const primary of [true, false]) {
  test(app + ' probe retains ' + (primary ? 'startup and all cleanup errors' : 'all cleanup-only errors'), async () => {
    const target = new URL('./apps/' + app + '/check-trace-flags.mjs', import.meta.url).href;
    const fixture = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import fs from 'node:fs';
      import http from 'node:http';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      import {fileURLToPath} from 'node:url';
      import {syncBuiltinESMExports} from 'node:module';
      const primary=${primary}, target=${JSON.stringify(target)};
      const attempted=[], create=http.createServer;
      let server, labels, container;
      const id='1'.repeat(64), temp=join(tmpdir(),'row7-cleanup-test');
      fs.mkdtempSync=()=>temp; fs.mkdirSync=()=>{};
      fs.writeFileSync=()=>{}; fs.appendFileSync=()=>{};
      fs.rmSync=(path)=>{assert.equal(path,temp);attempted.push('temp');throw new Error('temp cleanup');};
      http.createServer=(...args)=>{
        server=create(...args); const close=server.close.bind(server), connections=server.closeAllConnections.bind(server);
        server.closeAllConnections=()=>{attempted.push('connections');connections();throw new Error('connections cleanup');};
        server.close=callback=>{attempted.push('server');return close(()=>callback(new Error('server cleanup')));};
        return server;
      };
      const remove=key=>{attempted.push('container');assert.equal(key,id);throw new Error('container cleanup');};
      cp.execFileSync=(file,args)=>{
        assert.equal(file,'docker');
        if(args[0]==='image') return 'image-id';
        if(args[0]==='run'||args[0]==='create') {
          labels=Object.fromEntries(args.flatMap((value,index)=>value==='--label'?[args[index+1].split('=')]:[]));
          container=args[args.indexOf('--name')+1];return id;
        }
        if(args[0]==='inspect') return JSON.stringify({Id:id,Name:'/'+container,Config:{Labels:labels}});
        if(args[0]==='start') return id;
        if(args[0]==='port') throw new Error('startup failed');
        if(args[0]==='rm') {assert.ok(args.includes('-f')&&args.includes('-v'));return remove(args.at(-1));}
        throw new Error('unexpected docker call '+args);
      };
      syncBuiltinESMExports();
      process.argv=[process.execPath,primary?fileURLToPath(target):'fixture','mock'];
      try {
        let error;
        try {
          const module=await import(target);
          assert.equal(typeof module.cleanupProbe,'function');
          if(!primary) {
            const upstream=http.createServer();
            await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
            await module.cleanupProbe(new Set([id]),remove,upstream,temp);
          }
        } catch(failure) {error=failure;}
        assert.ok(error instanceof AggregateError, 'cleanup must aggregate, not mask: '+error);
        assert.deepEqual(error.errors.map(error=>error.message),[
          ...(primary?['startup failed']:[]),'container cleanup','connections cleanup','server cleanup','temp cleanup']);
        assert.equal(error.cause?.message,primary?'startup failed':undefined);
        assert.deepEqual(attempted,['container','connections','server','temp']);
        assert.equal(server.listening,false,'upstream must close despite removal failure');
      } finally {
        if(server?.listening) {
          // Independent teardown must not call the injected failing methods.
          http.Server.prototype.closeAllConnections.call(server);
          await new Promise(resolve=>http.Server.prototype.close.call(server,resolve));
        }
      }
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', fixture], { timeout: 15_000 });
  });
}
