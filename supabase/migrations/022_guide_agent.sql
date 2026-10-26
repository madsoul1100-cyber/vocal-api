-- The help voice agent records its runs as agent 'guide'.
ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_agent_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_agent_check CHECK (agent IN (
  'structuring','verification_call','resolution','content','follow_up',
  'escalation','translation','response_summary','routing','guide'
));
