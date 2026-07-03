// Pluggable web-search grounding for recipe discovery.
// Provider is selected by WEB_SEARCH_PROVIDER: "none" | "tavily".
// Swap in Azure AI Agent Service "grounding with Bing" here without touching callers.

export async function webSearch(queryText: string): Promise<string | undefined> {
  const provider = process.env.WEB_SEARCH_PROVIDER ?? "none";
  if (provider === "none") return undefined;

  if (provider === "tavily") {
    const key = process.env.TAVILY_API_KEY;
    if (!key) return undefined;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: queryText,
        max_results: 4,
        include_answer: true,
      }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { answer?: string; results?: { title: string; content: string }[] };
    if (data.answer) return data.answer;
    return (data.results ?? []).map((r) => `${r.title}: ${r.content}`).join("\n");
  }

  return undefined;
}
