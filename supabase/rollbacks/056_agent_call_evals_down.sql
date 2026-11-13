-- Rollback for 056_agent_call_evals.sql. Removes the agent scorer's objects. Nothing else
-- references them: canoe_calls, the call scorer, Scores/Insights/flags and the digest are untouched.
-- Revert scripts/agent_eval.js and its workflow steps first (or with it); the page hides the agent
-- quality UI when agent_call_evals / agent_eval_metrics() are missing.
-- Loses: every agent evaluation (re-creatable by re-running the scorer, ~$11 per 30 days) and the
-- reviewers' "AI got this wrong" marks in call_reviews.eval_disagree (not re-creatable).

drop function if exists agent_eval_metrics(timestamptz, timestamptz);
drop function if exists agent_eval_pending(timestamptz, int);
alter table call_reviews drop column if exists eval_disagree;
drop table if exists agent_eval_jobs;
drop table if exists agent_call_evals;
