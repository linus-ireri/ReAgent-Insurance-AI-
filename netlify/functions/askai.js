// --- Constants ---
import { cleanLlmAnswer } from "../../lib/clean-llm-answer.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "qwen/qwen3.8-27b";

async function fetchWithTimeout(url, { method = "GET", headers = {}, body, timeout = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.responseText = text;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}
const GREETING_RESPONSES = {
  "who are you": "I am ReAgent AI, a decision-support agent for Kenya Reinsurance Corporation (Kenya Re). I help assess reinsurance claims and underwriting questions using policy documents, treaties, claim forms, and investigation reports. Final decisions always stay with a human reviewer. How can I assist you today?",
  "hello": "Hello! Welcome to ReAgent AI. Ask me about treaty referral thresholds, coverage and exclusions, claim documentation, or underwriting guidelines for Kenya Re.",
  "hi": "Hi there! You're chatting with ReAgent AI. How can I help with a reinsurance claim or underwriting question today?",
  "hey": "Hello! This is ReAgent AI — I can help with policy coverage, treaty clauses, claim referral conditions, and investigation findings for Kenya Re.",
  "how are you": "I'm ready to help with reinsurance claims and underwriting — what would you like to review: coverage, exclusions, referral rules, or a specific claim?",
  "good morning": "Good morning! ReAgent AI at your service — ask about claim referral thresholds, coverage checks, or treaty conditions.",
  "good afternoon": "Good afternoon! ReAgent AI can help with policy coverage, treaty referral clauses, claim forms, and investigation reports.",
  "good evening": "Good evening! Ask me about Kenya Re treaty clauses, claim coverage, exclusions, or escalation conditions."
};

const COMMON_QUERIES = {
  "what do you do": "I support reinsurance claims assessment and underwriting for Kenya Re: retrieve relevant policy/treaty clauses, check coverage and exclusions, flag anomalies, apply escalation/referral rules, and produce a cited recommendation for human review.",
  "how can you help": "I can retrieve treaty and policy clauses, check whether a claim appears covered or excluded, flag missing documents or anomalies, and highlight referral conditions that require human escalation. Try asking: \"What does the treaty say about claim referral thresholds?\"",
  "what information do you have": "I work from the knowledge base of policy wording, the reinsurance treaty, claim forms, fire investigation reports, and related claims context for Kenya Re decision support.",
  "help": "Ask about coverage, exclusions, treaty retention/capacity, claim referral thresholds (e.g. Article 6), missing documentation, or whether a claim should be escalated to a human reviewer."
};

// --- System prompt (hard-coded)
// Decision-support agent for Kenya Re reinsurance claims and underwriting.
const SYSTEM_PROMPT = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re).
Your role is to support reinsurance claims assessment and underwriting by reasoning over policy documents, reinsurance treaties, claim forms, and investigation reports.
Specifically: read claim documents; retrieve relevant policy/treaty clauses; check coverage and exclusions; flag anomalies and missing documentation; apply escalation rules (including treaty referral conditions such as Article 6); and produce a recommendation with cited evidence.
Always defer final decisions to a human reviewer — never auto-approve or auto-deny claims.
Use a concise, professional tone. Stay within reinsurance/insurance claims and underwriting topics; for unrelated questions, politely redirect to those topics.
Never identify yourself as an AI model or mention model providers.`;

// --- Helper Functions ---

/**
 * Normalizes a string by converting it to lowercase, removing special characters, and trimming whitespace.
 * @param {string} text - The text to normalize.
 * @returns {string} The normalized text.
 */
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildRuleBasedContextBlock() {
  const greetingLines = Object.entries(GREETING_RESPONSES).map(
    ([intent, text]) => `- When the user means "${intent}": ${text}`
  );
  const queryLines = Object.entries(COMMON_QUERIES).map(
    ([intent, text]) => `- When the user asks about "${intent}": ${text}`
  );
  return [
    "Official reference snippets for common greetings and queries (match intent; you may paraphrase naturally while keeping the same facts and ReAgent AI / Kenya Re focus):",
    "",
    "Greetings / identity:",
    ...greetingLines,
    "",
    "Common queries:",
    ...queryLines,
  ].join("\n");
}

function ragAskUrl() {
  const raw = process.env.RAG_SERVER_URL;
  if (!raw || !String(raw).trim()) return null;
  const t = String(raw).replace(/\/$/, "");
  if (/\/ask$/i.test(t)) return t;
  return `${t}/ask`;
}

function ragBaseUrl() {
  const ask = ragAskUrl();
  if (!ask) return null;
  return ask.replace(/\/ask$/i, "");
}

/**
 * Handles rule-based responses for common greetings.
 * @param {string} normalizedMessage - The normalized user message.
 * @returns {object|null} A response object or null if no greeting is matched.
 */
function getGreetingResponse(normalizedMessage) {
  if (GREETING_RESPONSES[normalizedMessage]) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: GREETING_RESPONSES[normalizedMessage],
        context: [],
        source: "rule-based"
      }),
    };
  }
  return null;
}

/**
 * Queries the RAG server for an answer.
 * @param {string} userMessage - The user's message.
 * @returns {Promise<object|null>} The RAG server's response or null on error.
 */
async function queryRagServer(userMessage) {
  try {
    const ragUrl = ragAskUrl();
    if (!ragUrl) {
      return null;
    }
    console.log("Querying RAG server at:", ragUrl);
    return await fetchWithTimeout(ragUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: userMessage }),
      timeout: 5000,
    });
  } catch (error) {
    console.error("RAG server error:", error.message);
    return null;
  }
}

/**
 * Queries the LLM with context from the RAG server.
 * @param {string} userMessage - The user's message.
 * @param {Array<string>} context - The context from the RAG server.
 * @returns {Promise<object>} The LLM's response.
 */
async function queryLlmWithContext(userMessage, context) {
  if (!GROQ_API_KEY) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "The AI service is not configured yet. I can still help with basic ReAgent AI greetings and common claims/underwriting questions, but full AI responses are currently unavailable.",
        context: context,
        source: "config-missing"
      }),
    };
  }

  const systemPrompt = SYSTEM_PROMPT + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n2. Cite specific documents or sources from the context when referenced (e.g. policy sections, treaty articles, claim form fields, investigation findings).\n
  3. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base. A human reviewer should obtain the missing documentation or confirm with Kenya Re underwriting/claims."\n
  4. For questions unrelated to reinsurance claims or underwriting, politely redirect: "I appreciate your question, but I'm specifically designed to assist with Kenya Re claims assessment and underwriting. How can I help with a claim or treaty question?"\n
  5. Avoid speculation; if coverage, exclusions, or referral triggers are uncertain, say so and recommend human review.\n
  6. Respond to greetings politely. Keep answers concise and practical. End recommendations with a clear note that final decisions require a human reviewer.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Retrieved context: ${context.join(" ")}` },
    { role: "user", content: userMessage }
  ];

  try {
    const response = await fetchWithTimeout(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages }),
      timeout: 4000
    });
    const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: answer || "Sorry, I do not have official information on that topic.",
        context: context,
        source: "rag+llm"
      }),
    };
  } catch (error) {
    console.error("LLM with context error:", error.message);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "Sorry, I do not have official information on that topic.",
        context: context,
        source: "rag+llm-fallback"
      }),
    };
  }
}


/**
 * Queries the LLM as a fallback when the RAG server fails.
 * @param {string} userMessage - The user's message.
 * @returns {Promise<object>} The LLM's response.
 */
async function queryLlmFallback(userMessage) {
  if (!GROQ_API_KEY) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "The AI service is not configured yet. I can still help with basic ReAgent AI greetings and common claims/underwriting questions, but full AI responses are temporarily unavailable.",
        context: [],
        source: "config-missing"
      }),
    };
  }

  const ruleContext = buildRuleBasedContextBlock();
  const systemPrompt =
    SYSTEM_PROMPT +
    `\nDocument RAG is unavailable. Use the reference snippets in the next message when they match the user's intent; for other reinsurance claims/underwriting topics answer carefully or recommend human review with Kenya Re claims/underwriting. For unrelated questions, politely redirect to claims and underwriting topics.`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Reference:\n${ruleContext}\n\nUser message: ${userMessage}`,
    },
  ];

  try {
    console.log("Making LLM fallback call for:", userMessage.substring(0, 100) + "...");
    const response = await fetchWithTimeout(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages }),
      timeout: 8000
    });
    const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
    console.log("LLM fallback response received, length:", answer?.length || 0);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: answer || "Sorry, I do not have official information on that topic.",
        context: [],
        source: "llm-fallback"
      }),
    };
  } catch (error) {
    console.error("LLM fallback error:", error.message);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!",
        context: [],
        source: "rule-fallback"
      }),
    };
  }
}

// --- Main Handler ---

export const handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST instead." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const userMessage = body.message?.trim();

    if (!userMessage || typeof userMessage !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid request format. Expected a 'message' field with text." }),
      };
    }

    const normalizedMessage = normalize(userMessage);

    let ragIsHealthy = false;
    const base = ragBaseUrl();
    try {
      if (base) {
        await fetchWithTimeout(`${base}/health`, { timeout: 1000 });
        ragIsHealthy = true;
        console.log("RAG server is healthy");
      } else {
        console.log("RAG_SERVER_URL not set; using LLM with rule-based reference context");
      }
    } catch (healthError) {
      console.log("RAG server health check failed, will use LLM fallback with rule context");
      ragIsHealthy = false;
    }

    if (!ragIsHealthy) {
      return await queryLlmFallback(userMessage);
    }

    const greetingResponse = getGreetingResponse(normalizedMessage);
    if (greetingResponse) {
      return greetingResponse;
    }

    // Query RAG server at /ask
    const ragData = await queryRagServer(userMessage);
    if (ragData) {
      if (ragData.answer) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: cleanLlmAnswer(ragData.answer), context: ragData.context || [], source: "rag" }),
        };
      }
      if (ragData.context && Array.isArray(ragData.context) && ragData.context.length > 0) {
        // 4) LLM with context if no direct answer
        return await queryLlmWithContext(userMessage, ragData.context);
      }
    }

    // 5) Fallback LLM without context
    return await queryLlmFallback(userMessage);

  } catch (error) {
    console.error("Unexpected error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Unexpected error", details: error.message }),
    };
  }
};
