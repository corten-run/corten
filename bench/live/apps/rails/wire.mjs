// Lossless extraction from native Action Cable JSON frames, never application observations.
function messages(network) {
  return network.filter(record => record.kind === 'native-websocket-received').flatMap(record => {
    if (record.response?.opcode !== 1) return [];
    const frame = JSON.parse(record.response.payloadData);
    return frame.message ? [frame.message] : [];
  });
}
export const wireEvents = network => messages(network).filter(message => message.kind === 'event').map(message => message.event);
export const wireSnapshots = network => messages(network).filter(message => message.kind === 'snapshot').map(message => message.snapshot);
