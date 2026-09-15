-- Correlate local answer feedback and runs with the Langfuse trace for that turn.
ALTER TABLE answers ADD COLUMN langfuse_trace_id TEXT;

