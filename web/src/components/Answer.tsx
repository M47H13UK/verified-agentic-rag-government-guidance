import type { CitedPassage, RunResponse } from "../../../src/server/types";
import type { Citation, ClaimVerdict, Run, StructuredAnswer } from "../../../src/types";
import { formatDate, formatSeconds, formatUsd, setupLabel } from "../format";

type Props = {
  response: RunResponse;
  onShowTrace: () => void;
};

/** Shows what the user sees for one run. The answer, its sources, and what the verifier removed. */
export function Answer({ response, onShowTrace }: Props) {
  const { run, passages } = response;
  const answer = run.final_answer;
  const unconfirmed = run.verification?.unconfirmed ?? [];

  return (
    <article className="card" aria-labelledby="answer-heading">
      <h2 id="answer-heading">Answer</h2>
      <p className="asked">
        <span className="field-name">Question</span> {run.question}
      </p>

      {answer === null && (
        <p className="error" role="alert">
          The agent did not produce a valid answer. {run.draft.error}
        </p>
      )}

      {answer?.status === "declined" && (
        <div className="notice">
          <h3>This question was not answered</h3>
          <p>{answer.summary}</p>
          <p>
            <span className="field-name">Reason</span>{" "}
            {answer.declined_reason ?? "No reason was given."}
          </p>
        </div>
      )}

      {answer?.status === "needs_clarification" && (
        <div className="notice">
          <h3>More detail is needed</h3>
          <p>{answer.summary}</p>
          <p>
            <span className="field-name">Please say</span>{" "}
            {answer.clarifying_question ?? "No question was given."}
          </p>
        </div>
      )}

      {answer?.status === "answered" && (
        <Claims answer={answer} verdicts={run.final_verdicts} passages={passages} />
      )}

      {answer?.status === "answered" && run.verification === null && (
        <p className="hint">The verifier was off for this setup, so the claims were not checked.</p>
      )}

      {unconfirmed.length > 0 && (
        <section className="unconfirmed" aria-labelledby="unconfirmed-heading">
          <h3 id="unconfirmed-heading">Could not be confirmed</h3>
          <p>
            These statements were in the first draft. The verifier could not confirm them from the
            cited pages, so they were removed from the answer.
          </p>
          <ul>
            {unconfirmed.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      )}

      <RunFacts run={run} onShowTrace={onShowTrace} />
    </article>
  );
}

function Claims(props: {
  answer: StructuredAnswer;
  verdicts: ClaimVerdict[];
  passages: CitedPassage[];
}) {
  // Citations are numbered across the whole answer, so [3] means one thing on the page.
  let number = 0;

  return (
    <>
      <p className="summary">{props.answer.summary}</p>
      <ol className="claims">
        {props.answer.claims.map((claim, claimIndex) => {
          // `final_verdicts` is in the same order as the claims. It is empty when the verifier is off.
          const verdict = props.verdicts[claimIndex];
          return (
            <li key={claimIndex}>
              <p className="claim-text">{claim.text}</p>
              <VerdictBadge verdict={verdict} />
              {verdict?.verdict === "partially_supported" && (
                <p className="hint">{verdict.reason}</p>
              )}
              <ul className="citations">
                {claim.citations.map((citation) => {
                  number += 1;
                  return (
                    <CitationItem
                      key={number}
                      number={number}
                      citation={citation}
                      passage={props.passages.find((p) => p.id === citation.passage_id)}
                    />
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </>
  );
}

const VERDICT_LABELS = {
  supported: "Supported",
  partially_supported: "Partially supported",
  not_supported: "Not supported",
};

/** The label says the verdict in words. The coloured dot only repeats it. */
function VerdictBadge({ verdict }: { verdict: ClaimVerdict | undefined }) {
  if (!verdict) {
    return <span className="badge badge-unchecked">Not checked</span>;
  }
  return (
    <span className={`badge badge-${verdict.verdict}`}>{VERDICT_LABELS[verdict.verdict]}</span>
  );
}

function CitationItem(props: {
  number: number;
  citation: Citation;
  passage: CitedPassage | undefined;
}) {
  const { number, citation, passage } = props;
  return (
    <li className="citation">
      <span className="citation-number">[{number}]</span>
      <div>
        <blockquote>{citation.quote}</blockquote>
        {passage ? (
          <p className="source">
            {passage.title}.{" "}
            <a href={passage.url} target="_blank" rel="noreferrer">
              {passage.url.replace("https://", "")} (opens in a new tab)
            </a>
            . Last updated {formatDate(passage.updated)}.
          </p>
        ) : (
          <p className="source">The source page for this quote was not found.</p>
        )}
      </div>
    </li>
  );
}

function RunFacts({ run, onShowTrace }: { run: Run; onShowTrace: () => void }) {
  return (
    <p className="run-facts">
      Setup {setupLabel(run.setup)}. Took {formatSeconds(run.total_latency_ms)}. Estimated cost{" "}
      {formatUsd(run.total_usage.costUsd)} at list prices.{" "}
      <button type="button" className="link-button" onClick={onShowTrace}>
        Show the trace
      </button>
    </p>
  );
}
