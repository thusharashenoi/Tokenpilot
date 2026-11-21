export function Success({ submission, onAnother }) {
  return (
    <section className="card success">
      <p className="eyebrow">Submission received</p>
      <h2>{submission.teamName} is in.</h2>
      <p className="hint">
        {submission.theme}. Judges can open the repository and the demo from this record.
      </p>
      <dl>
        <div>
          <dt>Team leader</dt>
          <dd>{submission.leaderName}</dd>
        </div>
        <div>
          <dt>Team members</dt>
          <dd>{submission.memberCount}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>
            <a href={submission.githubUrl}>{submission.githubUrl}</a>
          </dd>
        </div>
        <div>
          <dt>Demo</dt>
          <dd>
            <a href={submission.demoUrl}>{submission.demoUrl}</a>
          </dd>
        </div>
      </dl>
      <button className="submit ghost" type="button" onClick={onAnother}>
        Submit another team
      </button>
    </section>
  );
}
