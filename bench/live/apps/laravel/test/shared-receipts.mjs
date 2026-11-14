import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { verifyArtifact } from '../../../parity.mjs';
import { verifyRound } from '../../../verify.mjs';

const directory = resolve(process.argv[2]);
const round = await verifyRound(directory);
assert.deepEqual(round.passed, ['laravel']);
assert.equal(round.readyForLoad, false, 'a partial diagnostic cannot qualify the group');
const read = async scenario => JSON.parse(gunzipSync(await readFile(join(directory, `laravel-${scenario}.json.gz`))));
const check = artifact => verifyArtifact(artifact, { app: artifact.app, group: artifact.group, scenario: artifact.scenario });
const original = await read('normal');
const mutations = [
  ['borrowed HTTP origin', a => { a.network.find(r => r.kind === 'native-livewire-response').url = 'http://wrong.example/livewire/update'; }],
  ['borrowed socket origin', a => { a.network.find(r => r.kind === 'native-websocket-created').url = 'ws://wrong.example/app/key'; }],
  ['missing original socket', a => { a.network = a.network.filter(r => r.kind !== 'native-websocket-created'); }],
  ['missing native request', a => { const id = a.network.find(r => r.kind === 'native-livewire-response').requestId; a.network = a.network.filter(r => r.kind !== 'request' || r.requestId !== id); }],
  ['changed Reverb event', a => { const frame = a.network.find(r => r.kind === 'native-websocket-received' && r.response.payloadData.includes('delivery')); const body = JSON.parse(frame.response.payloadData); const data = JSON.parse(body.data); data.packet.event.effectId = 'forged'; body.data = JSON.stringify(data); frame.response.payloadData = JSON.stringify(body); }],
  ['changed native effect count', a => { a.network.find(r => r.kind === 'native-livewire-response' && r.body.components.some(c => c.effects.dispatches?.some(d => d.params?.packet?.kind === 'event'))).body.components[0].effects.dispatches.find(d => d.params.packet.kind === 'event').params.packet.nativeCount++; }],
  ['changed DOM row', a => { a.capture.records.find(r => r.kind === 'event').state[0].priceCents++; }],
  ['changed native resources', a => { a.capture.records.find(r => r.kind === 'resources').inventory.nativeSocketBufferBytes = 0; }],
  ['borrowed inspected container', a => { const instance = JSON.parse(a.provenance.instance.stdout); instance.Image = 'sha256:' + '0'.repeat(64); a.provenance.instance.stdout = JSON.stringify(instance); }],
];
for (const [name, mutate] of mutations) {
  const copy = structuredClone(original); mutate(copy); assert.throws(() => check(copy), name);
  console.log('Laravel shared real-capture mutation rejected: ' + name);
}
for (const scenario of ['normal', 'disconnect', 'missed-updates', 'expired-cursor', 'gap', 'slow-reader']) {
  const artifact = await read(scenario); check(artifact);
  const text = JSON.stringify(artifact);
  assert.doesNotMatch(text, /"(?:checksum|_token|csrf|set-cookie)"\s*:/i, 'reusable credentials retained');
  assert.doesNotMatch(artifact.html, /wire:snapshot=|name="csrf-token"|livewireScriptConfig/i);
  console.log(JSON.stringify({ scenario, profile: artifact.profile, image: artifact.provenance.imageId, sourceCommit: artifact.provenance.commit, summary: artifact.summary }));
}
