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
// Sonnet by default: answers start sooner than on Opus, which matters live.
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
// Compressing custom instructions happens once and must keep every fact.
export const MOST_CAPABLE_ANTHROPIC_MODEL = "claude-opus-5-5";

const LIST_TIMEOUT_MS = 15000;
const text = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("");

// Fetches with a timeout, still honouring the caller's signal.
function aborter(signal, ms = LIST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", relay);
    },
  };
}

// Turns thinking off at Quick effort where the model allows it. Sonnet's only
// way is "between_tools", which must be sent alone; Haiku takes "disabled".
// Opus can't disable thinking, so it keeps the default (undefined = omit it).
// think = true keeps thinking on (undefined = the API default): typed and
// screen-related questions need the extra reasoning, heard ones often don't.
export function thinkingFor(model, effort, think = false) {
  if (think) return undefined;
  if (effort !== "low") return undefined;
  if (model === "claude-sonnet-5-5") return { type: "between_tools" };
  if (model === "claude-haiku-5-5") return { type: "disabled" };
  return undefined;
}

// Effort (Depth) is accepted by Opus 4.5 and later, Sonnet 4.6 and later,
// Haiku 5.5 and later, and the Fable and Mythos models. Older models picked
// from the Models API (Haiku 4.5, Sonnet 4.5, Claude 3…) reject it with a 400,
// so it's left out for them and they answer at their normal depth.
export function supportsEffort(model) {
  return /^claude-(opus-(4-[5-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|haiku-[5-9]|fable|mythos)/.test(String(model || ""));
}
const effortFor = (model, effort) => (effort && supportsEffort(model) ? { output_config: { effort } } : {});

// anthropicBaseUrl: optional, for a proxy or gateway (and tests).
function anthropic({ apiKey, anthropicBaseUrl }) {
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(anthropicBaseUrl ? { baseURL: anthropicBaseUrl, maxRetries: 0 } : {}) });
  // Off for the session once the account turns out not to have the feature.
  let fallbackOk = true;
  // Display names learned from the Models API, for IDs outside the price table.
  const displayNames = new Map();
  const idOf = (model) => model || DEFAULT_ANTHROPIC_MODEL;
  const label = (model) => {
    const id = idOf(model);
    const known = ANTHROPIC_MODELS[id];
    return known ? `Claude ${known.name}` : displayNames.get(id) || id;
  };
  const usage = (u = {}) => ({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
  const result = (msg) => ({
    text: text(msg.content),
    usage: usage(msg.usage),
    stop: msg.stop_reason === "refusal" ? "refusal" : msg.stop_reason === "max_tokens" ? "max_tokens" : "end",
    refusal: msg.stop_details?.category || null,
  });
  const describe = (e, model) => {
    const name = label(model);
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
    if (e?.name === "AbortError" || e?.name === "TimeoutError") return "Anthropic took too long to answer. Check your connection and try again.";
    return null;
  };

  return {
    name: (model) => {
      const id = idOf(model);
      const known = ANTHROPIC_MODELS[id];
      return known ? `Claude ${known.name}` : displayNames.get(id) || id;
    },
    cost(u, model) {
      const known = ANTHROPIC_MODELS[idOf(model)];
      if (!known) return null; // prices unknown: show tokens only
      const p = known.price;
      return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
    },
    async listModels({ signal } = {}) {
      try {
        const models = [];
        for await (const item of client.models.list({}, { signal, timeout: LIST_TIMEOUT_MS, maxRetries: 0 })) {
          const id = String(item.id);
          const name = item.display_name || id;
          displayNames.set(id, name);
          models.push({ id, name });
        }
        return models.sort((a, b) => a.id.localeCompare(b.id));
      } catch (e) {
        throw new Error(describe(e) || String(e?.message || e));
      }
    },
    async testConnection(model) {
      const started = Date.now();
      try {
        // No effort or thinking settings: the smallest request every model accepts.
        await client.messages.create({ model: idOf(model), max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }, { timeout: LIST_TIMEOUT_MS, maxRetries: 0 });
        return { ok: true, ms: Date.now() - started };
      } catch (e) {
        throw new Error(describe(e, model) || String(e?.message || e));
      }
    },
    stream({ model, system, parts, maxTokens, effort, think, onText }) {
      model = idOf(model);
      const thinking = thinkingFor(model, effort, think);
      const content = parts.map((p) => (p.type === "image" ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.data } } : p));
      let current = null;
      let streamed = false;
      const start = () => {
        const useFallback = fallbackOk && !!ANTHROPIC_MODELS[model]?.fallback;
        current = client.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          // Server-side fallback re-runs a refused request on another model.
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
          ...effortFor(model, effort),
          ...(thinking ? { thinking } : {}),
          // Identical across questions until a setting changes, so cached:
          // 1-hour lifetime; repeats within an hour read it at 0.1x.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
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
      const msg = await client.messages.stream({ model: idOf(model), max_tokens: maxTokens, ...effortFor(idOf(model), effort), system, messages: [{ role: "user", content: user }] }).finalMessage();
      return result(msg);
    },
    // Writes the system-prompt cache before a question is asked. Not streamed:
    // max_tokens 0 is rejected with stream: true. There are no output tokens.
    async prewarm({ model, system, effort }) {
      model = idOf(model);
      const thinking = thinkingFor(model, effort);
      const msg = await client.messages.create({
        model,
        max_tokens: 0,
        ...effortFor(model, effort),
        ...(thinking ? { thinking } : {}),
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: "." }],
      });
      return usage(msg.usage);
    },
    describeError: describe,
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

// Models a /models list can include that can't answer a chat request
// (OpenAI's own list has embeddings, speech, transcription and image models),
// or not in real time (OpenRouter's ":batch" variants answer hours later).
const NOT_CHAT = /(^|[/:-])(text-)?embed|whisper|(^|[/-])tts|dall-e|moderation|transcribe|(^|[/-])gpt-image|realtime|(^|[/-])audio|(^|[/-])ocr|davinci-002|babbage-002|:batch$/i;

function openaiCompatible({ apiKey, baseUrl, model: defaultModel }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const url = `${root}/chat/completions`;
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const usage = (u = {}) => ({ input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: u.prompt_tokens_details?.cached_tokens || 0, cacheWrite: u.prompt_tokens_details?.cache_write_tokens || 0 });
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
  const openRouter = /(^|[/.])openrouter\.ai([/:]|$)/i.test(root);
  // OpenRouter caches OpenAI, DeepSeek and recent Gemini models by itself, but
  // Claude models (and older Gemini) only up to a cache_control breakpoint, set
  // here on the system message (résumé, job description, instructions).
  const cacheable = (model) => openRouter && /^(?:anthropic\/|google\/gemini)/i.test(String(model || defaultModel).replace(/^~/, ""));
  // Claude keeps it an hour, as on Anthropic's own API (pauses in an interview
  // often run past 5 minutes); Gemini takes the plain 5-minute marker.
  const cacheMark = (model) => (/^~?anthropic\//.test(String(model || defaultModel)) ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
  const messages = (system, content, model) => [{ role: "system", content: cacheable(model) ? [{ type: "text", text: system, cache_control: cacheMark(model) }] : system }, { role: "user", content }];
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
  // Depth -> reasoning level. OpenRouter takes reasoning: { effort }, other
  // servers reasoning_effort. Quick tries "none", then "minimal" (fastest on GPT-5 models),
  // then "low"; a 400 about it steps down the ladder, ending with no parameter
  // (models that don't reason). What worked is remembered per provider.
  // Quick: "none" (GPT-5.1 and later), then "minimal" (GPT-5), then "low".
  const LADDERS = { low: ["none", "minimal", "low"], medium: ["medium"], high: ["high"] };
  const reasoningStep = {};
  const REASONING_ERROR = /reasoning|effort|minimal|unsupported (?:parameter|value)|unrecognized (?:request )?argument/i;
  const sendReasoned = async (body, effort, maxTokens, signal) => {
    const ladder = LADDERS[effort];
    if (!ladder) return sendLimited(body, maxTokens, signal);
    for (;;) {
      const level = ladder[reasoningStep[effort] || 0];
      const withLevel = level ? { ...body, ...(openRouter ? { reasoning: { effort: level } } : { reasoning_effort: level }) } : body;
      try {
        return await sendLimited(withLevel, maxTokens, signal);
      } catch (e) {
        if (!level || !(e instanceof HttpError) || e.status !== 400 || !REASONING_ERROR.test(e.message)) throw e;
        reasoningStep[effort] = (reasoningStep[effort] || 0) + 1;
      }
    }
  };
  const describe = (e, model) => {
    const host = (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return baseUrl || "the server";
      }
    })();
    if (e instanceof TypeError && /fetch|url/i.test(String(e.message))) return `Can't reach ${host}. Check the base URL in Settings > Answers > AI provider, and your connection.`;
    if (e?.name === "AbortError" || e?.name === "TimeoutError") return `Timed out waiting for ${host}. Check the base URL in Settings > Answers > AI provider, and your connection.`;
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
  };

  return {
    name: (model) => model || defaultModel,
    cost: () => null,
    async listModels({ signal } = {}) {
      const abort = aborter(signal);
      try {
        const res = await fetch(`${root}/models`, { method: "GET", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: abort.signal });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          let message = detail;
          try {
            message = JSON.parse(detail).error?.message || detail;
          } catch {}
          throw new HttpError(res.status, message.slice(0, 300) || res.statusText);
        }
        const json = await res.json();
        const items = Array.isArray(json?.data) ? json.data : [];
        // Gemini's OpenAI-compatible endpoint lists "models/gemini-2.5-flash",
        // but chat requests name the model without that prefix.
        const gemini = /generativelanguage\.googleapis\.com/i.test(root);
        return items
          .map((item) => {
            const id = String(item.id ?? "").replace(gemini ? /^models\// : /^$/, "");
            return { id, name: item.name || item.display_name || id };
          })
          .filter((item) => item.id && !NOT_CHAT.test(item.id))
          .sort((a, b) => a.id.localeCompare(b.id));
      } catch (e) {
        throw new Error(describe(e) || String(e?.message || e));
      } finally {
        abort.done();
      }
    },
    async testConnection(model) {
      const started = Date.now();
      const abort = aborter();
      try {
        await sendLimited({ model: model || defaultModel, messages: [{ role: "user", content: "Hi" }] }, 1, abort.signal);
        return { ok: true, ms: Date.now() - started };
      } catch (e) {
        throw new Error(describe(e, model) || String(e?.message || e));
      } finally {
        abort.done();
      }
    },
    stream({ model, system, parts, maxTokens, effort, onText }) {
      const controller = new AbortController();
      const content = parts.map((p) => (p.type === "image" ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${p.data}` } } : p));
      const done = (async () => {
        const res = await sendReasoned({ model: model || defaultModel, stream: true, stream_options: { include_usage: true }, messages: messages(system, content, model) }, effort, maxTokens, controller.signal);
        let out = "";
        let stop = "end";
        let used = usage();
        let buffer = "";
        const decoder = new TextDecoder();
        // Server-sent events: one "data: {json}" per line, "[DONE]" at the end.
        const handle = (line) => {
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            return;
          }
          const choice = event.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            out += delta;
            onText(delta);
          }
          if (choice?.finish_reason) stop = stopOf(choice.finish_reason);
          if (event.usage) used = usage(event.usage);
        };
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handle(buffer.slice(0, nl).trim());
            buffer = buffer.slice(nl + 1);
          }
        }
        // Some servers end the last event without a newline.
        handle((buffer + decoder.decode()).trim());
        return { text: out, usage: used, stop, refusal: null };
      })().catch((e) => {
        if (e?.name === "AbortError") e.aborted = true;
        throw e;
      });
      return { done, abort: () => controller.abort() };
    },
    async complete({ model, system, user, maxTokens }) {
      const res = await sendLimited({ model: model || defaultModel, messages: messages(system, user, model) }, maxTokens);
      const json = await res.json();
      const choice = json.choices?.[0];
      return { text: choice?.message?.content || "", usage: usage(json.usage), stop: stopOf(choice?.finish_reason), refusal: null };
    },
    // Only OpenRouter's Claude and Gemini models have a cache to warm: the
    // system message is the cached prefix, byte-identical to stream's. Others
    // cache by themselves or not at all (null). Not streamed, and max_tokens 1
    // since OpenRouter rejects 0. No reasoning level: thinking needs a budget
    // above max_tokens, and the system prompt's cache doesn't depend on it.
    async prewarm({ model, system } = {}) {
      if (!cacheable(model)) return null;
      const res = await sendLimited({ model: model || defaultModel, messages: messages(system, ".", model) }, 1);
      const json = await res.json();
      return usage(json.usage);
    },
    describeError: describe,
  };
}

export const PROVIDERS = {
  anthropic: { label: "Anthropic", create: anthropic },
  openai: { label: "OpenAI-compatible", create: openaiCompatible },
};

export function createProvider(settings) {
  return (PROVIDERS[settings.provider] || PROVIDERS.anthropic).create(settings);
}

// True when the error is a user abort, from either provider. The Anthropic
// SDK's abort error doesn't set its name, so it's matched by class.
export function isAbort(e) {
  return e instanceof Anthropic.APIUserAbortError || e?.name === "APIUserAbortError" || e?.name === "AbortError" || e?.aborted === true;
}
