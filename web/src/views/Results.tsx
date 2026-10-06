import { useEffect, useState } from "react";
import type { EvalSummary, JudgeAuditSummary, SetupSummary } from "../../../src/eval/types";
import { getResults } from "../api";
import { CostChart } from "../components/CostChart";
import { categoryLabel, formatDateTime, formatPercent, formatUsd } from "../format";

export function Results() {
  const [loading, setLoading] = useState(true);
  // Null after loading means the eval has not been run yet.
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getResults()
      .then(setSummary)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="card empty">Loading the results.</p>;
  }
  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (!summary) {
    return (
      <div className="card empty">
        <h2>No results yet</h2>
        <p>The eval has not been run, so there is nothing to show here.</p>
      </div>
    );
  }

  const { gold_set, frontier } = summary;
  return (
    <>
      <section className="card" aria-labelledby="headline-heading">
        <h2 id="headline-heading">Results by setup</h2>
        <p className="hint">
          {gold_set.questions} questions, {gold_set.verified} checked by hand. Judge model{" "}
          {summary.judge_model}. Verifier model {summary.verifier_model}. Built{" "}
          {formatDateTime(summary.generated_at)}. All runs together cost an estimated{" "}
          {formatUsd(summary.total_cost_usd)} at list prices.
        </p>
        <HeadlineTable setups={summary.setups} frontier={frontier.pareto} />
        <RepeatsNote setups={summary.setups} />
        <JudgeAuditNote audit={summary.judge_audit} />
      </section>

      <section className="card" aria-labelledby="chart-heading">
        <h2 id="chart-heading">Correctness against cost per answer</h2>
        {frontier.most_accurate && frontier.cheapest_accurate && frontier.cost_ratio !== null && (
          <p>
            The most accurate setup is <strong>{frontier.most_accurate}</strong>. The cheapest
            accurate setup is <strong>{frontier.cheapest_accurate}</strong>. The most accurate one
            costs <strong>{frontier.cost_ratio.toFixed(1)} times</strong> as much per answer.
          </p>
        )}
        <CostChart setups={summary.setups} frontier={frontier.pareto} />
      </section>

      <PerQuestion summary={summary} />
    </>
  );
}

function HeadlineTable({ setups, frontier }: { setups: SetupSummary[]; frontier: string[] }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="headline-heading">
      <table>
        <thead>
          <tr>
            <th scope="col">Setup</th>
            <th scope="col">Model</th>
            <th scope="col">Verifier</th>
            <th scope="col">Correctness</th>
            <th scope="col">Unsupported claims</th>
            <th scope="col">Behaviour accuracy</th>
            <th scope="col">Retrieval hit rate</th>
            <th scope="col">Cost per answer</th>
            <th scope="col">Latency p50</th>
            <th scope="col">Latency p95</th>
            <th scope="col">Frontier</th>
          </tr>
        </thead>
        <tbody>
          {setups.map((s) => (
            <tr key={s.setup.id}>
              {/* The smaller lines in this row only say something when there is more than one repeat. */}
              <th scope="row">
                {s.setup.id}
                {s.repeats > 1 && <span className="range nowrap">{s.repeats} repeats</span>}
              </th>
              <td className="nowrap">
                {s.setup.model}
                {s.setup.effort && <span className="range">{s.setup.effort} effort</span>}
              </td>
              <td>{s.setup.verifier ? "On" : "Off"}</td>
              <td className="number">
                {formatPercent(s.correctness)}
                {s.repeats > 1 && (
                  <span className="range">
                    {formatPercent(s.correctness_min)} to {formatPercent(s.correctness_max)}
                  </span>
                )}
              </td>
              <td className="number">
                {formatPercent(s.unsupported_claim_rate, 1)}
                {s.repeats > 1 && (
                  <span className="range">
                    {formatPercent(s.unsupported_claim_rate_min, 1)} to{" "}
                    {formatPercent(s.unsupported_claim_rate_max, 1)}
                  </span>
                )}
              </td>
              <td className="number">{formatPercent(s.behaviour_accuracy)}</td>
              <td className="number">{formatPercent(s.retrieval_hit_rate)}</td>
              <td className="number">{formatUsd(s.cost_per_answer_usd)}</td>
              <td className="number">{s.latency_p50_s.toFixed(0)} s</td>
              <td className="number">{s.latency_p95_s.toFixed(0)} s</td>
              <td>{frontier.includes(s.setup.id) ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Explains the smaller lines in the table. Shows nothing when every setup ran once. */
function RepeatsNote({ setups }: { setups: SetupSummary[] }) {
  if (!setups.some((s) => s.repeats > 1)) {
    return null;
  }
  // The eval repeats only some setups by design, so a mix is normal and not a fault.
  const someRanOnce = setups.some((s) => s.repeats === 1);
  return (
    <p className="hint">
      A setup that ran more than once shows its number of repeats under its name. Under its
      correctness and its unsupported claims it shows the lowest and the highest repeat.
      {someRanOnce && " The other setups ran once."}
    </p>
  );
}

/** One sentence on how often the judge agreed with a person, or that nobody has measured it. */
function JudgeAuditNote({ audit }: { audit: JudgeAuditSummary | null }) {
  // A summary written before the audit existed has no such field, so this also covers undefined.
  if (!audit) {
    return (
      <p className="hint">How often the judge agrees with a person has not been measured yet.</p>
    );
  }
  return (
    <p className="hint">
      A person labelled {audit.labelled} of the judge's decisions without seeing them and agreed
      with the judge on {audit.agreed}, which is {formatPercent(audit.agreement_rate)}.
    </p>
  );
}

function PerQuestion({ summary }: { summary: EvalSummary }) {
  const [setupId, setSetupId] = useState("all");
  const [category, setCategory] = useState("all");

  const categories = [...new Set(summary.per_question.map((row) => row.category))];
  const rows = summary.per_question.filter(
    (row) =>
      (setupId === "all" || row.setup_id === setupId) &&
      (category === "all" || row.category === category),
  );

  return (
    <section className="card" aria-labelledby="questions-heading">
      <h2 id="questions-heading">Each question</h2>
      <div className="filters">
        <div>
          <label htmlFor="filter-setup">Setup</label>
          <select id="filter-setup" value={setupId} onChange={(e) => setSetupId(e.target.value)}>
            <option value="all">All setups</option>
            {summary.setups.map((s) => (
              <option key={s.setup.id} value={s.setup.id}>
                {s.setup.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-category">Category</label>
          <select
            id="filter-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="hint" role="status">
        Showing {rows.length} of {summary.per_question.length} rows.
      </p>

      <div
        className="table-scroll table-tall"
        tabIndex={0}
        role="region"
        aria-labelledby="questions-heading"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Category</th>
              <th scope="col">Setup</th>
              <th scope="col">Correctness</th>
              <th scope="col">Behaviour correct</th>
              <th scope="col">Unsupported claims</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.question_id} ${row.setup_id}`}>
                <td>{row.question_id}</td>
                <td>{categoryLabel(row.category)}</td>
                <td>{row.setup_id}</td>
                <td className="number">{formatPercent(row.correctness)}</td>
                <td>{row.behaviour_correct ? "Yes" : "No"}</td>
                <td className="number">
                  {row.unsupported_claims} of {row.total_claims}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
