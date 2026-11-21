import { useState } from "react";

const EMPTY = {
  leaderName: "",
  memberCount: "",
  teamName: "",
  theme: "",
  summary: "",
  githubUrl: "",
  demoUrl: "",
};

export function SubmissionForm({ themes, onSubmit }) {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState("");

  function update(field) {
    return (event) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    };
  }

  function handleClear() {
    setValues(EMPTY);
    setErrors({});
    setFormError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setPending(true);
    setFormError("");
    setErrors({});
    try {
      await onSubmit(values);
      setValues(EMPTY);
    } catch (error) {
      setErrors(error.fields ?? {});
      setFormError(error.fields ? "" : error.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <p className="eyebrow">For innovators</p>
      <h2>Submit your hackathon build</h2>
      <p className="hint">One form. Team, theme, and the links judges will open.</p>
      <Field label="Team Leader's name" error={errors.leaderName}>
        <input
          name="leaderName"
          value={values.leaderName}
          onChange={update("leaderName")}
          placeholder="Asha Rao"
        />
      </Field>
      <Field label="Number of members on the team" error={errors.memberCount}>
        <input
          name="memberCount"
          type="number"
          min="1"
          max="50"
          step="1"
          value={values.memberCount}
          onChange={update("memberCount")}
          placeholder="4"
        />
      </Field>
      <Field label="Team name" error={errors.teamName}>
        <input name="teamName" value={values.teamName} onChange={update("teamName")} placeholder="Northwind" />
      </Field>
      <Field label="Theme" error={errors.theme}>
        <select name="theme" value={values.theme} onChange={update("theme")}>
          <option value="">Select a theme</option>
          {themes.map((theme) => (
            <option key={theme} value={theme}>
              {theme}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What are you building?" error={errors.summary}>
        <textarea
          name="summary"
          rows="4"
          value={values.summary}
          onChange={update("summary")}
          placeholder="A short summary of the product and who it is for."
        />
      </Field>
      <Field label="GitHub repository" error={errors.githubUrl}>
        <input
          name="githubUrl"
          value={values.githubUrl}
          onChange={update("githubUrl")}
          placeholder="https://github.com/org/repo"
        />
      </Field>
      <Field label="Demo video" error={errors.demoUrl}>
        <input
          name="demoUrl"
          value={values.demoUrl}
          onChange={update("demoUrl")}
          placeholder="https://www.youtube.com/watch?v=..."
        />
      </Field>
      {formError ? <p className="field-error">{formError}</p> : null}
      <div className="actions">
        <button className="submit" type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit"}
        </button>
        <button className="submit ghost" type="button" onClick={handleClear} disabled={pending}>
          Clear
        </button>
      </div>
    </form>
  );
}

function Field({ label, error, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  );
}
