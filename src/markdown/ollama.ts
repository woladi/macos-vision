export interface OllamaOptions {
  /** Base URL of the Ollama server. Default: `http://localhost:11434` */
  baseUrl: string;
  /** Model name to use for generation. Default: `mistral-nemo` */
  model: string;
}

/**
 * Verify that the Ollama server is reachable.
 * Throws {@link OllamaUnavailableError} if the server cannot be contacted.
 */
export async function ping(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new OllamaUnavailableError(baseUrl);
  }
}

/**
 * Send a chat request to the Ollama /api/chat endpoint.
 * Separating system and user roles significantly reduces hallucination compared
 * to /api/generate where both are concatenated into a single completion string.
 * Uses `stream: false` so the full response arrives in one shot.
 */
export async function chat(
  opts: OllamaOptions,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: false,
      options: {
        temperature: 0,  // deterministic — no creative token selection
        top_p: 1,        // full vocabulary considered; determinism comes from temperature=0
        num_predict: -1, // no output truncation
      },
    }),
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { message: { content: string } };
  return data.message.content.trim();
}

export class OllamaUnavailableError extends Error {
  constructor(url: string) {
    super(
      `Ollama is not reachable at ${url}. ` +
        `Make sure Ollama is running (e.g. \`ollama serve\`) and the URL is correct.`,
    );
    this.name = 'OllamaUnavailableError';
  }
}
