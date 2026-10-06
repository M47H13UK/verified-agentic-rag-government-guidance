import { useEffect, useState } from "react";
import type { RunResponse } from "../../src/server/types";
import type { Setup } from "../../src/types";
import { getSetups } from "./api";
import { Ask } from "./views/Ask";
import { Results } from "./views/Results";
import { Trace } from "./views/Trace";

type Tab = "ask" | "trace" | "results";

const TABS: { id: Tab; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "trace", label: "Trace" },
  { id: "results", label: "Results" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("ask");
  const [setups, setSetups] = useState<Setup[]>([]);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run on screen. The Ask view sets it, the Trace view shows it and can load another one by ID.
  const [current, setCurrent] = useState<RunResponse | null>(null);

  // Runs once, when the page first appears. The empty array means "no values to watch".
  useEffect(() => {
    getSetups()
      .then((response) => {
        setSetups(response.setups);
        setMock(response.mock);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      {mock && (
        <p className="mock-banner" role="note">
          <strong>Mock mode.</strong> Every answer and every number on this page is made up for
          testing. None of it is a real result.
        </p>
      )}

      <div className="page">
        <header>
          <h1>UK visa guidance assistant</h1>
          <p className="tagline">
            Unofficial. Answers UK student and graduate visa questions from GOV.UK pages, with a
            quoted source for every claim.
          </p>
          <nav aria-label="Views" className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {/* All three views stay mounted and the tabs only hide them.
            An answer that is still loading is not lost when you look at another tab. */}
        <main>
          <section hidden={tab !== "ask"} aria-label="Ask">
            <Ask
              setups={setups}
              current={current}
              onRun={setCurrent}
              onShowTrace={() => setTab("trace")}
            />
          </section>
          <section hidden={tab !== "trace"} aria-label="Trace">
            <Trace current={current} onRun={setCurrent} />
          </section>
          <section hidden={tab !== "results"} aria-label="Results">
            <Results />
          </section>
        </main>

        <footer>
          <p>
            Unofficial. Not affiliated with GOV.UK or the Home Office. General information, not
            legal advice. Always check GOV.UK.
          </p>
          <p>
            Contains public sector information licensed under the{" "}
            <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">
              Open Government Licence v3.0
            </a>
            .
          </p>
        </footer>
      </div>
    </>
  );
}
