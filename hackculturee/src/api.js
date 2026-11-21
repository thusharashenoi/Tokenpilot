export async function fetchThemes() {
  const response = await fetch("/api/themes");
  if (!response.ok) {
    throw new Error("Themes could not be loaded.");
  }
  const body = await response.json();
  return body.themes;
}

export async function fetchSubmissions() {
  const response = await fetch("/api/submissions");
  if (!response.ok) {
    throw new Error("Submissions could not be loaded.");
  }
  const body = await response.json();
  return body.submissions;
}

export async function submitBuild(payload) {
  const response = await fetch("/api/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Check the form and try again.");
    error.fields = body.errors ?? {};
    throw error;
  }
  return body.submission;
}
