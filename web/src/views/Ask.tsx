import { useState } from "react";
import type { SubmitEvent } from "react";
import type { RunResponse } from "../../../src/server/types";
import type { Setup } from "../../../src/types";
import { ask } from "../api";
import { Answer } from "../components/Answer";
import { EXAMPLE_GROUPS } from "../examples";
import { setupLabel } from "../format";

type Props = {
  setups: Setup[];
  /** The run shown under the form. Null before the first answer. */
  current: RunResponse | null;
  onRun: (response: RunResponse) => void;
  onShowTrace: () => void;
};

export function Ask({ setups, current, onRun, onShowTrace }: Props) {
  const [question, setQuestion] = useState("");
  // The same default as the API.
  const [setupId, setSetupId] = useState("OM1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    // A form reloads the page when it is submitted. This stops that.
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      onRun(await ask(question, setupId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="question">Your question</label>
        <textarea
          id="question"
          rows={3}
          maxLength={500}
          required
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <p className="hint">
          At most 500 characters. Questions are saved with their answers, so leave out personal
          details.
        </p>

        <label htmlFor="setup">Model setup</label>
        <select id="setup" value={setupId} onChange={(e) => setSetupId(e.target.value)}>
          {setups.map((setup) => (
            <option key={setup.id} value={setup.id}>
              {setupLabel(setup)}
            </option>
          ))}
        </select>

        <button type="submit" className="primary" disabled={loading}>
          {loading ? "Working" : "Ask"}
        </button>
      </form>

      {/* This element is always on the page, so a screen reader announces the text when it changes. */}
      <div role="status">
        {loading && <p className="loading">Working on it. An answer can take up to a minute.</p>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {current && !loading && <Answer response={current} onShowTrace={onShowTrace} />}

      <section className="card" aria-labelledby="examples-heading">
        <h2 id="examples-heading">Example questions</h2>
        <p className="hint">
          Pick one to copy it into the box above. It is not sent until you press Ask.
        </p>
        {EXAMPLE_GROUPS.map((group) => (
          <div key={group.persona} className="example-group">
            <h3>{group.persona}</h3>
            <ul className="examples">
              {group.questions.map((text) => (
                <li key={text}>
                  <button type="button" onClick={() => setQuestion(text)}>
                    {text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
