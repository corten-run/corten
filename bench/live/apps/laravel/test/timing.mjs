// Diagnose real shared-runner attempts; never promote failed captures to evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { verifyRound } from '../../../verify.mjs';
import { negativeRequests } from '../../../admission.mjs';
import { scenarios } from '../../../native.mjs';

const directory = resolve(process.argv[2]);
const round = await verifyRound(directory);
const distribution = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { samples: values.length, meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1) };
};
for (const scenario of scenarios('recoverable-live')) {
  const artifact = JSON.parse(gunzipSync(await readFile(join(directory, `laravel-${scenario}.json.gz`))));
  assert.equal(artifact.profile, 'native-feed');
  assert.deepEqual(artifact.controls.map(control => control.request), negativeRequests(artifact.workload, 'native-feed'));
  assert.deepEqual(artifact.controls.map(control => control.status), [400, 400, 400, 400]);
  assert.ok(artifact.controls.every(control => typeof control.body === 'string' && control.body.length));
  const requests = artifact.network.filter(record => record.kind === 'request');
  const responses = new Map(artifact.network.filter(record => record.kind === 'response').map(record => [record.requestId, record]));
  const timings = new Map(artifact.network.filter(record => record.kind === 'native-http-timing').map(record => [record.requestId, record.timing]));
  const methods = {}, publications = [], nativeEvents = [], resumes = [];
  for (const request of requests) {
    let method = new URL(request.url).pathname;
    if (/\/livewire(?:\/|-).*update$/.test(method)) {
      method = JSON.parse(request.body).components.flatMap(component => component.calls.map(call => call.method)).join(',');
    }
    const row = methods[method] ??= { requests: 0, responses: 0, statuses: {}, durations: [] };
    row.requests++;
    const response = responses.get(request.requestId), timing = timings.get(request.requestId);
    if (response) { row.responses++; row.statuses[response.status] = (row.statuses[response.status] ?? 0) + 1; }
    if (timing?.responseEnd >= timing?.requestStart && timing.requestStart >= 0) row.durations.push(timing.responseEnd - timing.requestStart);
    if (method === '/parity/publish' && JSON.parse(request.body).event) publications.push(timing?.startTime);
  }
  for (const response of artifact.network.filter(record => record.kind === 'native-livewire-response' && record.body)) {
    for (const component of response.body.components) for (const dispatch of component.effects.dispatches ?? []) {
      if (dispatch.name !== 'parity') continue;
      const packet = dispatch.params.packet;
      if (packet.kind === 'event') nativeEvents.push({ seq: packet.event.seq, disposition: packet.disposition, through: packet.nativeThrough });
      if (packet.kind === 'ready') resumes.push({ from: packet.from, status: packet.status });
    }
  }
  const intervals = publications.slice(1).flatMap((at, index) => Number.isFinite(at) && Number.isFinite(publications[index]) ? [at - publications[index]] : []);
  console.log(JSON.stringify({ scenario, schema: artifact.schema, error: artifact.error,
    controls: artifact.controls, image: artifact.provenance.imageId, commit: artifact.provenance.commit,
    methods: Object.fromEntries(Object.entries(methods).map(([method, { durations, ...row }]) => [method, { ...row, requestTiming: distribution(durations) }])),
    observedPublicationIntervals: distribution(intervals), requiredMeanEventBudgetMs: 180000 / artifact.workload.eventCount,
    nativeEvents: nativeEvents.length, firstNative: nativeEvents[0], lastNative: nativeEvents.at(-1), resumes,
    summary: artifact.summary, browserErrors: artifact.failures }));
}
console.log(JSON.stringify({ qualification: round }));
