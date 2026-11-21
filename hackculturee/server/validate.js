import { THEMES } from "../shared/themes.js";

const GITHUB = /^https:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/i;

export function validateSubmission(body) {
  const leaderName = text(body.leaderName);
  const memberCount = wholeNumber(body.memberCount);
  const teamName = text(body.teamName);
  const theme = text(body.theme);
  const summary = text(body.summary);
  const githubUrl = text(body.githubUrl);
  const demoUrl = text(body.demoUrl);
  const errors = {};

  if (leaderName.length < 2 || leaderName.length > 80) {
    errors.leaderName = "Enter the team leader's name.";
  }
  if (memberCount < 1 || memberCount > 50) {
    errors.memberCount = "Enter how many people are on the team.";
  }
  if (teamName.length < 2 || teamName.length > 80) {
    errors.teamName = "Enter a team name.";
  }
  if (!THEMES.includes(theme)) {
    errors.theme = "Choose a theme.";
  }
  if (summary.length < 12 || summary.length > 600) {
    errors.summary = "Describe the build in a sentence or two.";
  }
  if (!GITHUB.test(githubUrl)) {
    errors.githubUrl = "Use a GitHub link, like https://github.com/org/repo.";
  }
  if (!httpsUrl(demoUrl)) {
    errors.demoUrl = "Use an https link to the demo video.";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { leaderName, memberCount, teamName, theme, summary, githubUrl, demoUrl },
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function wholeNumber(value) {
  const raw = text(value);
  if (!/^[1-9]\d*$/.test(raw)) {
    return 0;
  }
  return Number(raw);
}

function httpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
