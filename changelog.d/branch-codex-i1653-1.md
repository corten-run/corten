- The cluster relay closes its reply inbox after each patch or reload-marker batch, so retrying
  a batch without acknowledgements does not accumulate reply registrations in the NATS client.
