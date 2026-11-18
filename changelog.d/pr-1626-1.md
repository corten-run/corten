- Make the benchmark CI startup-deadline test deterministic by expiring the deadline only after the
  sample open is pending, without changing the benchmark supervisor.
