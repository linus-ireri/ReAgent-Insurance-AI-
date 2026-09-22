import { cleanLlmAnswer } from "../../lib/clean-llm-answer.js";

const greetingResponses = {
  "who are you": "I am ReAgent AI, a decision-support agent for Kenya Reinsurance Corporation (Kenya Re). I help assess reinsurance claims and underwriting questions using policy documents, treaties, claim forms, and investigation reports. Final decisions always stay with a human reviewer. How can I assist you today?",
  "hello": "Hello! Welcome to ReAgent AI. Ask me about treaty referral thresholds, coverage and exclusions, claim documentation, or underwriting guidelines for Kenya Re.",
  "hi": "Hi there! You're chatting with ReAgent AI. How can I help with a reinsurance claim or underwriting question today?",
  "hey": "Hello! This is ReAgent AI — I can help with policy coverage, treaty clauses, claim referral conditions, and investigation findings for Kenya Re.",
  "how are you": "I'm ready to help with reinsurance claims and underwriting — what would you like to review: coverage, exclusions, referral rules, or a specific claim?",
  "good morning": "Good morning! ReAgent AI at your service — ask about claim referral thresholds, coverage checks, or treaty conditions.",
  "good afternoon": "Good afternoon! ReAgent AI can help with policy coverage, treaty referral clauses, claim forms, and investigation reports.",
  "good evening": "Good evening! Ask me about Kenya Re treaty clauses, claim coverage, exclusions, or escalation conditions."
};

const commonQueries = {
  "what do you do": "I support reinsurance claims assessment and underwriting for Kenya Re: retrieve relevant policy/treaty clauses, check coverage and exclusions, flag anomalies, apply escalation/referral rules, and produce a cited recommendation for human review.",
  "how can you help": "I can retrieve treaty and policy clauses, check whether a claim appears covered or excluded, flag missing documents or anomalies, and highlight referral conditions that require human escalation. Try asking: \"What does the treaty say about claim referral thresholds?\"",
  "what information do you have": "I work from the knowledge base of policy wording, the reinsurance treaty, claim forms, fire investigation reports, and related claims context for Kenya Re decision support.",
  "help": "Ask about coverage, exclusions, treaty retention/capacity, claim referral thresholds (e.g. Article 6), missing documentation, or whether a claim should be escalated to a human reviewer."
};

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getCannedReply(userMessage) {
  const normalized = normalize(userMessage);
  if (greetingResponses[normalized]) {
    return greetingResponses[normalized];
  }
  for (const [key, reply] of Object.entries(commonQueries)) {
    if (normalized.includes(normalize(key))) {
      return reply;
    }
  }
  return null;
}


/** Structured snippets for the LLM when RAG is unavailable (not used as final canned text). */
function buildRuleBasedContextBlock() {
  const greetingLines = Object.entries(greetingResponses).map(
    ([intent, text]) => `- When the user means "${intent}": ${text}`
  );
  const queryLines = Object.entries(commonQueries).map(
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

function ragBaseAndAsk() {
  const raw = process.env.RAG_SERVER_URL;
  if (!raw || !String(raw).trim()) return { base: null, askUrl: null };
  const trimmed = String(raw).replace(/\/$/, "");
  if (/\/ask$/i.test(trimmed)) {
    const base = trimmed.replace(/\/ask$/i, "");
    return { base: base || trimmed, askUrl: trimmed };
  }
  return { base: trimmed, askUrl: `${trimmed}/ask` };
}

async function llmWithRuleContext(userMessage) {
  const ruleContext = buildRuleBasedContextBlock();
  const systemContent = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Support reinsurance claims assessment and underwriting by reasoning over policy documents, reinsurance treaties, claim forms, and investigation reports. Check coverage and exclusions, flag anomalies, apply escalation/referral rules, and produce recommendations with cited evidence. Always defer final decisions to a human reviewer — never auto-approve or auto-deny claims. Be concise and professional. Document RAG is offline: use the reference snippets in the next message when they match the user's intent; for other claims/underwriting topics use careful general reasoning or recommend human review; for unrelated topics, politely redirect.`;
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('Missing GROQ_API_KEY');
  const apiUrl = "https://api.groq.com/openai/v1/chat/completions";
  const model = "qwen/qwen3.8-27b";

  const llmRes = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `Reference:\n${ruleContext}\n\nUser message: ${userMessage}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!llmRes.ok) {
    const errorText = await llmRes.text();
    console.error(`LLM HTTP error ${llmRes.status}:`, errorText);
    return {
      reply:
        "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
      source: "llm-fallback-error",
    };
  }
  const llmData = await llmRes.json();
  const answer = cleanLlmAnswer(llmData?.choices?.[0]?.message?.content) || "Sorry, I do not have official information on that topic.";
  return { reply: answer, source: "llm-fallback" };
}

export const handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed. Use POST instead." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const userMessage = body.message?.trim();

    if (!userMessage || typeof userMessage !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid request format. Expected a 'message' field with text.",
        }),
      };
    }

    console.log("Received user message:", userMessage);

    const { base: ragBase, askUrl: ragAskUrl } = ragBaseAndAsk();

    let ragIsHealthy = false;
    if (ragBase) {
      try {
        const healthCheck = await fetch(`${ragBase}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        ragIsHealthy = healthCheck.ok;
        console.log("RAG server health check:", ragIsHealthy ? "healthy" : "unhealthy");
      } catch (e) {
        console.error("RAG server health check failed:", e.message);
        ragIsHealthy = false;
      }
    } else {
      console.log("RAG_SERVER_URL not set; treating RAG as unavailable");
    }

    const jsonHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // RAG down: LLM answers using greetings + common queries as reference context
    if (!ragIsHealthy) {
      console.log("RAG server not available, using LLM with rule-based reference context");
      try {
        console.log("Making LLM call with rule context for:", userMessage.substring(0, 100) + "...");
        const { reply, source } = await llmWithRuleContext(userMessage);
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({ reply, context: [], source }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        const cannedReply = getCannedReply(userMessage);
        if (cannedReply) {
          return {
            statusCode: 200,
            headers: jsonHeaders,
            body: JSON.stringify({
              reply: cannedReply,
              context: [],
              source: "canned-after-llm-error",
            }),
          };
        }
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({
            reply:
              "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
            context: [],
            source: "error",
          }),
        };
      }
    }

    // RAG is healthy, attempt RAG server
    let response;
    try {
      response = await fetch(ragAskUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: userMessage
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (e) {
      console.error("RAG server error:", e.message);
      response = undefined;
    }

    if (!response || !response.ok) {
      console.error("RAG server request failed, falling back to LLM with rule-based context");
      try {
        const { reply, source } = await llmWithRuleContext(userMessage);
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({ reply, context: [], source }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        const cannedReply = getCannedReply(userMessage);
        if (cannedReply) {
          return {
            statusCode: 200,
            headers: jsonHeaders,
            body: JSON.stringify({
              reply: cannedReply,
              context: [],
              source: "canned-after-llm-error",
            }),
          };
        }
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({
            reply:
              "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
            context: [],
            source: "error",
          }),
        };
      }
    }

    const data = await response.json();
    console.log("RAG Response:", data);

const cleanedReply = cleanLlmAnswer(data?.answer) || "Hello! I'm ReAgent AI, a decision-support agent for Kenya Re. Ask me about treaty referral thresholds, coverage and exclusions, claim documentation, or underwriting guidelines.";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: JSON.stringify({ reply: cleanedReply, context: data?.context || [], source: "rag" }),
    };
  } catch (error) {
    console.error("Server Error:", error.message);
    const cannedReply = getCannedReply(body.message || "");
    if (cannedReply) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: JSON.stringify({ reply: cannedReply, context: [], source: "canned-fallback" }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server Error: " + error.message }),
    };
  }
}
