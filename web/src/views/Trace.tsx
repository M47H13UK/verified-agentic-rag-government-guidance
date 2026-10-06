import { useState } from "react";
import type { SubmitEvent } from "react";
import type { RunResponse } from "../../../src/server/types";
import type { ClaimVerdict, Run, ToolCallTrace, Usage } from "../../../src/types";
import { getRun } from "../api";
import {
  formatDateTime,
  formatNumber,
  formatSeconds,
  formatTime,
  formatUsd,
  setupLabel,
} from "../format";

type Props = {
  /** The last run that was asked or loaded. Null before the first one. */
  current: RunResponse | null;
  onRun: (response: RunResponse) => void;
};

export function Trace({ current, onRun }: Props) {
  const [runId, setRunId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      onRun(await getRun(runId.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="run-id">Load a run by its ID</label>
        <div className="input-row">
          <input
            id="run-id"
            required
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="primary" disabled={loading}>
            {loading ? "Loading" : "Load"}
          </button>
        </div>
        <p className="hint">The last run you asked is shown below without typing anything.</p>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {current ? (
        <RunTrace run={current.run} />
      ) : (
        <p className="card empty">No run yet. Ask a question first, or load a run by its ID.</p>
      )}
    </>
  );
}

function RunTrace({ run }: { run: Run }) {
  return (
    <>
      <section className="card" aria-labelledby="run-heading">
        <h2 id="run-heading">Run</h2>
        <dl className="facts">
          <dt>Run ID</dt>
          <dd>
            <code>{run._id}</code>
          </dd>
          <dt>Question</dt>
          <dd>{run.question}</dd>
          <dt>Setup</dt>
          <dd>{setupLabel(run.setup)}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(run.created_at)}</dd>
          <dt>Agent turns</dt>
          <dd>{run.draft.numTurns}</dd>
        </dl>
        {run.draft.error && (
          <p className="error" role="alert">
            The agent reported an error. {run.draft.error}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="calls-heading">
        <h2 id="calls-heading">Tool calls</h2>
        {run.draft.trace.length === 0 ? (
          <p className="empty">No tool calls were recorded.</p>
        ) : (
          <ol className="timeline">
            {run.draft.trace.map((call) => (
              <ToolCall key={call.tool_use_id} call={call} />
            ))}
          </ol>
        )}
      </section>

      <Verification run={run} />
      <UsageTable run={run} />
    </>
  );
}

function ToolCall({ call }: { call: ToolCallTrace }) {
  return (
    <li>
      <p className="call-name">
        <code>{call.tool}</code>{" "}
        <span className={call.ok ? "badge badge-supported" : "badge badge-not_supported"}>
          {call.ok ? "Succeeded" : "Failed"}
        </span>
      </p>
      <dl className="facts">
        <dt>Started</dt>
        <dd>{formatTime(call.started_at)}</dd>
        <dt>Input</dt>
        <dd>
          <code>{JSON.stringify(call.input)}</code>
        </dd>
        <dt>Result size</dt>
        <dd>{formatNumber(call.result_chars)} characters</dd>
        <dt>Duration</dt>
        <dd>
          {call.duration_ms === null ? "Not reported" : `${formatNumber(call.duration_ms)} ms`}
        </dd>
        <dt>Passages returned</dt>
        <dd>
          {call.passage_ids.length === 0 ? (
            "None"
          ) : (
            <details>
              <summary>{call.passage_ids.length}</summary>
              <ul className="plain-list">
                {call.passage_ids.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </dd>
        {call.error && (
          <>
            <dt>Error</dt>
            <dd>{call.error}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

function Verification({ run }: { run: Run }) {
  const record = run.verification;
  return (
    <section className="card" aria-labelledby="verification-heading">
      <h2 id="verification-heading">Verification</h2>
      {record === null ? (
        <p className="empty">The verifier was off for this setup.</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Claims before</dt>
            <dd>{record.claims_before}</dd>
            <dt>Dropped by the quote check</dt>
            <dd>{record.dropped_by_quote_check}</dd>
            <dt>Dropped by the verifier</dt>
            <dd>{record.dropped_by_verifier}</dd>
            <dt>Repair ran</dt>
            <dd>{record.repair_ran ? "Yes" : "No"}</dd>
            <dt>Claims after repair</dt>
            <dd>{record.claims_after_repair ?? "Repair did not run"}</dd>
            <dt>Claims shown to the user</dt>
            <dd>{record.claims_final}</dd>
          </dl>

          {record.unconfirmed.length > 0 && (
            <>
              <h3>Could not be confirmed</h3>
              <ul>
                {record.unconfirmed.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </>
          )}

          <VerdictList title="First pass verdicts" verdicts={record.first_pass} />
          {record.second_pass && (
            <VerdictList title="Verdicts after repair" verdicts={record.second_pass} />
          )}
        </>
      )}
    </section>
  );
}

function VerdictList({ title, verdicts }: { title: string; verdicts: ClaimVerdict[] }) {
  if (verdicts.length === 0) {
    return null;
  }
  return (
    <details>
      <summary>
        {title} ({verdicts.length})
      </summary>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={title}>
        <table>
          <thead>
            <tr>
              <th scope="col">Claim</th>
              <th scope="col">Verdict</th>
              <th scope="col">Checked by</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {verdicts.map((v) => (
              <tr key={v.claim_index}>
                <td className="number">{v.claim_index + 1}</td>
                <td>{v.verdict.replaceAll("_", " ")}</td>
                <td>{v.checked_by.replaceAll("_", " ")}</td>
                <td>{v.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function UsageTable({ run }: { run: Run }) {
  return (
    <section className="card" aria-labelledby="usage-heading">
      <h2 id="usage-heading">Tokens, cost and latency</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="usage-heading">
        <table>
          <thead>
            <tr>
              <th scope="col">Part</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
              <th scope="col">Estimated cost</th>
              <th scope="col">Latency</th>
            </tr>
          </thead>
          <tbody>
            <UsageRow name="Draft answer" usage={run.draft.usage} latencyMs={run.draft.latencyMs} />
            {run.verification && (
              <UsageRow
                name="Verifier and repair"
                usage={run.verification.extra_usage}
                latencyMs={run.verification.extra_latency_ms}
              />
            )}
            <UsageRow name="Total" usage={run.total_usage} latencyMs={run.total_latency_ms} />
          </tbody>
        </table>
      </div>
      <p className="hint">
        The cost is an estimate at list prices, worked out from the token counts. It is not a
        charge.
      </p>
    </section>
  );
}

function UsageRow(props: { name: string; usage: Usage; latencyMs: number }) {
  const { name, usage, latencyMs } = props;
  return (
    <tr>
      <th scope="row">{name}</th>
      <td className="number">{formatNumber(usage.inputTokens)}</td>
      <td className="number">{formatNumber(usage.outputTokens)}</td>
      <td className="number">{formatNumber(usage.cacheReadTokens)}</td>
      <td className="number">{formatNumber(usage.cacheCreationTokens)}</td>
      <td className="number">{formatUsd(usage.costUsd)}</td>
      <td className="number">{formatSeconds(latencyMs)}</td>
    </tr>
  );
}
