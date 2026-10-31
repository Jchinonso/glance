// LLM providers behind one interface, so Glance isn't tied to one vendor.
// Adding one means adding an entry here; prompts and features don't change.
//
//   stream({ model, system, parts, maxTokens, effort, onText }) -> { done, abort }
//   complete({ model, system, user, maxTokens, effort }) -> Promise<result>
//
// parts: [{ type: "image", data: <base64 jpeg> } | { type: "text", text }]
// result: { text, usage: { input, output, cacheRead, cacheWrite }, stop, refusal }
//   stop: "end" | "refusal" | "max_tokens"
import Anthropic from "@anthropic-ai/sdk";

// List prices in USD per million tokens. Haiku's apply to prompts up to 100K
// tokens, far above Glance's. A refusal fallback may bill at another model's
// rates, so costs shown are estimates. Haiku has no server-side fallback.
export const ANTHROPIC_MODELS = {
  "claude-opus-5-5": { name: "Opus 5.5", fallback: true, price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", fallback: true, price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  "claude-haiku-5-5": { name: "Haiku 5.5", fallback: false, price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } },
};
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

const text = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("");

// anthropicBaseUrl: optional, for a proxy or gateway (and tests).
function anthropic({ apiKey, anthropicBaseUrl }) {
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(anthropicBaseUrl ? { baseURL: anthropicBaseUrl, maxRetries: 0 } : {}) });
  // Off for the session once the account turns out not to have the feature.
  let fallbackOk = true;
  const known = (model) => (model in ANTHROPIC_MODELS ? model : DEFAULT_ANTHROPIC_MODEL);
  const usage = (u = {}) => ({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
  const result = (msg) => ({
    text: text(msg.content),
    usage: usage(msg.usage),
    stop: msg.stop_reason === "refusal" ? "refusal" : msg.stop_reason === "max_tokens" ? "max_tokens" : "end",
    refusal: msg.stop_details?.category || null,
  });

  return {
    name: (model) => `Claude ${ANTHROPIC_MODELS[known(model)].name}`,
    cost(u, model) {
      const p = ANTHROPIC_MODELS[known(model)].price;
      return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
    },
    stream({ model, system, parts, maxTokens, effort, onText }) {
      model = known(model);
      const content = parts.map((p) => (p.type === "image" ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.data } } : p));
      let current = null;
      let streamed = false;
      const start = () => {
        const useFallback = fallbackOk && ANTHROPIC_MODELS[model].fallback;
        current = client.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          // Server-side fallback re-runs a refused request on another model.
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
          output_config: { effort },
          // Identical across questions until a setting changes, so cached:
          // repeats within 5 minutes pay 0.1x for this part.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content }],
        });
        current.on("text", (t) => {
          streamed = true;
          onText(t);
        });
        return current.finalMessage();
      };
      const done = start()
        .catch((e) => {
          // The account can't use the refusal fallback: retry once without it.
          if (streamed || !fallbackOk || !(e instanceof Anthropic.BadRequestError) || !/fallback/i.test(String(e?.message))) throw e;
          fallbackOk = false;
          return start();
        })
        .then(result);
      return { done, abort: () => current?.abort() };
    },
    async complete({ model, system, user, maxTokens, effort }) {
      // Streamed even though only the end result is used: the SDK prefers
      // streaming for long outputs.
      const msg = await client.messages.stream({ model: known(model), max_tokens: maxTokens, output_config: { effort }, system, messages: [{ role: "user", content: user }] }).finalMessage();
      return result(msg);
    },
    describeError(e, model) {
      const name = `Claude ${ANTHROPIC_MODELS[known(model)].name}`;
      const t = String(e?.message || e);
      if (e instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings > Answers > AI provider.";
      if (e instanceof Anthropic.PermissionDeniedError) return `This API key isn't allowed to use ${name}. Check its workspace permissions in the Anthropic console.`;
      if (e instanceof Anthropic.NotFoundError) return `${name} isn't available to this API key's organization. Try another model in Settings > Answers.`;
      if (e instanceof Anthropic.RateLimitError) return "Too many requests right now. Wait a few seconds and ask again.";
      if (e?.status === 402 || /credit balance/i.test(t)) return "Your Anthropic account is out of credit. Add some at console.anthropic.com > Billing.";
      if (e?.status === 413) return "This question was too large to send. Remove some screenshots and try again.";
      if (e instanceof Anthropic.BadRequestError) return `Claude couldn't process this request: ${e.error?.error?.message || t}`;
      if (e instanceof Anthropic.InternalServerError) return "Anthropic's service is busy or having trouble. Try again in a moment.";
      if (e instanceof Anthropic.APIConnectionError) return "Can't reach Anthropic. Check your internet connection.";
      return null;
    },
  };
}

// Any server speaking OpenAI's chat completions API: OpenAI, Google Gemini's
// OpenAI endpoint, OpenRouter, Groq, Mistral, Together, or a local Ollama or
// LM Studio. Prices differ per vendor and model, so cost is unknown (null).
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function openaiCompatible({ apiKey, baseUrl, model: defaultModel }) {
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}/chat/completions`;
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const usage = (u = {}) => ({ input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: u.prompt_tokens_details?.cached_tokens || 0, cacheWrite: 0 });
  const stopOf = (reason) => (reason === "length" ? "max_tokens" : reason === "content_filter" ? "refusal" : "end");
  const send = async (body, signal) => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let message = detail;
      try {
        message = JSON.parse(detail).error?.message || detail;
      } catch {}
      throw new HttpError(res.status, message.slice(0, 300) || res.statusText);
    }
    return res;
  };
  const messages = (system, content) => [{ role: "system", content: system }, { role: "user", content }];
  // Newer OpenAI models take max_completion_tokens instead of max_tokens, and
  // some servers (Groq, small local models) cap output below Glance's limit.
  // Learned from the first refusal and kept for the session; null = no limit sent.
  let limitParam = "max_tokens";
  const sendLimited = async (body, maxTokens, signal) => {
    const withLimit = () => send(limitParam ? { ...body, [limitParam]: maxTokens } : body, signal);
    try {
      return await withLimit();
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || !limitParam || !/max_(?:completion_)?tokens/i.test(e.message)) throw e;
      limitParam = limitParam === "max_tokens" && /max_completion_tokens/i.test(e.message) ? "max_completion_tokens" : null;
      return withLimit();
    }
  };

  return {
    name: (model) => model || defaultModel,
    cost: () => null,
    stream({ model, system, parts, maxTokens, onText }) {
      const controller = new AbortController();
      const content = parts.map((p) => (p.type === "image" ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${p.data}` } } : p));
      const done = (async () => {
        const res = await sendLimited({ model: model || defaultModel, stream: true, stream_options: { include_usage: true }, messages: messages(system, content) }, maxTokens, controller.signal);
        let out = "";
        let stop = "end";
        let used = usage();
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          // Server-sent events: one "data: {json}" per line, "[DONE]" at the end.
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            const choice = event.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) {
              out += delta;
              onText(delta);
            }
            if (choice?.finish_reason) stop = stopOf(choice.finish_reason);
            if (event.usage) used = usage(event.usage);
          }
        }
        return { text: out, usage: used, stop, refusal: null };
      })().catch((e) => {
        if (e?.name === "AbortError") e.aborted = true;
        throw e;
      });
      return { done, abort: () => controller.abort() };
    },
    async complete({ model, system, user, maxTokens }) {
      const res = await sendLimited({ model: model || defaultModel, messages: messages(system, user) }, maxTokens);
      const json = await res.json();
      const choice = json.choices?.[0];
      return { text: choice?.message?.content || "", usage: usage(json.usage), stop: stopOf(choice?.finish_reason), refusal: null };
    },
    describeError(e, model) {
      const host = (() => {
        try {
          return new URL(baseUrl).host;
        } catch {
          return baseUrl || "the server";
        }
      })();
      if (e instanceof TypeError && /fetch|url/i.test(String(e.message))) return `Can't reach ${host}. Check the base URL in Settings > Answers > AI provider, and your connection.`;
      if (!(e instanceof HttpError)) return null;
      if (e.status === 401) return `${host} rejected the API key. Check it in Settings > Answers > AI provider.`;
      if (e.status === 403) return `This API key isn't allowed to use ${model || defaultModel} on ${host}.`;
      if (e.status === 404) return `${host} doesn't have a model called "${model || defaultModel}", or the base URL is wrong. Check both in Settings > Answers > AI provider.`;
      if (e.status === 429) return `${host} is rate limiting or out of quota. Wait a moment, or check your plan.`;
      if (e.status === 413) return "This question was too large to send. Remove some screenshots and try again.";
      // Text-only models refuse screenshots.
      if (e.status === 400 && /image|vision|multimodal/i.test(e.message)) return `${model || defaultModel} can't read screenshots. Turn off Settings > Answers > Screenshot every question, or use a model that reads images.`;
      if (e.status >= 500) return `${host} is having trouble (${e.status}). Try again in a moment.`;
      return `${host} couldn't process this request: ${e.message}`;
    },
  };
}

export const PROVIDERS = {
  anthropic: { label: "Anthropic", create: anthropic },
  openai: { label: "OpenAI-compatible", create: openaiCompatible },
};

export function createProvider(settings) {
  return (PROVIDERS[settings.provider] || PROVIDERS.anthropic).create(settings);
}

// True when the error is a user abort, from either provider.
export function isAbort(e) {
  return e?.name === "APIUserAbortError" || e?.name === "AbortError" || e?.aborted === true;
}
