const EXTERNAL =
  /\b(latest|documentation|docs|error code|cve|changelog|release notes|tavily|internet|online|library)\b|\bweb search\b/i;

export function needsExternalFact(text: string, graphPack: string): boolean {
  if (graphPack.trim()) {
    return false;
  }
  return EXTERNAL.test(text);
}

export function tavilyQuery(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export type TavilyPack = {
  text: string;
  urls: string[];
};

export async function fetchTavilyPack(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TavilyPack> {
  const response = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      topic: "general",
      max_results: 3,
      include_answer: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Tavily returned ${response.status}`);
  }
  const body = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const urls: string[] = [];
  const blocks: string[] = [];
  for (const item of body.results ?? []) {
    const url = item.url ?? "";
    if (!url) {
      continue;
    }
    urls.push(url);
    const content = (item.content ?? "").slice(0, 700);
    blocks.push(`[${urls.length}] ${item.title || url}\n${url}\n${content}`);
  }
  return { text: blocks.join("\n\n"), urls };
}
