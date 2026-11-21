import { useEffect, useState } from "react";
import { fetchSubmissions, fetchThemes, submitBuild } from "./api";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { SubmissionForm } from "./components/SubmissionForm";
import { Success } from "./components/Success";
import "./styles.css";

export function App() {
  const [themes, setThemes] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [saved, setSaved] = useState(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([fetchThemes(), fetchSubmissions()])
      .then(([nextThemes, nextSubmissions]) => {
        if (!active) {
          return;
        }
        setThemes(nextThemes);
        setSubmissions(nextSubmissions);
      })
      .catch(() => {
        if (active) {
          setLoadError("The submission desk is unavailable. Refresh and try again.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(payload) {
    const submission = await submitBuild(payload);
    setSaved(submission);
    setSubmissions((current) => [submission, ...current].slice(0, 8));
  }

  return (
    <div className="page">
      <Header />
      <Hero />
      <main className="sheet" id="submit">
        {loadError ? <p className="banner">{loadError}</p> : null}
        {saved ? (
          <Success submission={saved} onAnother={() => setSaved(null)} />
        ) : (
          <SubmissionForm themes={themes} onSubmit={handleSubmit} />
        )}
        <Recent submissions={submissions} />
      </main>
      <footer className="footer">
        <span>HackCulturee</span>
        <span>AWFIS Coworking, Residency Road, Bengaluru</span>
      </footer>
    </div>
  );
}

function Recent({ submissions }) {
  if (submissions.length === 0) {
    return null;
  }
  return (
    <section className="recent">
      <h2>Latest submissions</h2>
      <ul>
        {submissions.map((item) => (
          <li key={item.id}>
            <strong>{item.teamName}</strong>
            <span>{item.theme}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
