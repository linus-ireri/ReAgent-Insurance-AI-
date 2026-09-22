// Temporary deployment marker for WhatsApp webhook testing.
import { cleanLlmAnswer } from "../../lib/clean-llm-answer.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "qwen/qwen3.8-27b";

const greetingResponses = {
  "who are you": "I am ReAgent AI, a decision-support agent for Kenya Reinsurance Corporation (Kenya Re). I help assess reinsurance claims and underwriting questions using policy documents, treaties, claim forms, and investigation reports. Final decisions always stay with a human reviewer. How can I assist you today?",
  "who are you?": "I am ReAgent AI, a decision-support agent for Kenya Reinsurance Corporation (Kenya Re). I help assess reinsurance claims and underwriting questions using policy documents, treaties, claim forms, and investigation reports. Final decisions always stay with a human reviewer. How can I assist you today?",
  "hello": "Hello! Welcome to ReAgent AI. Ask me about treaty referral thresholds, coverage and exclusions, claim documentation, or underwriting guidelines for Kenya Re.",
  "hi": "Hi there! You're chatting with ReAgent AI. How can I help with a reinsurance claim or underwriting question today?",
  "hey": "Hello! This is ReAgent AI — I can help with policy coverage, treaty clauses, claim referral conditions, and investigation findings for Kenya Re.",
  "how are you": "I'm ready to help with reinsurance claims and underwriting — what would you like to review: coverage, exclusions, referral rules, or a specific claim?",
  "how are you?": "I'm ready to help with reinsurance claims and underwriting — what would you like to review: coverage, exclusions, referral rules, or a specific claim?",
  "good morning": "Good morning! ReAgent AI at your service — ask about claim referral thresholds, coverage checks, or treaty conditions.",
  "good afternoon": "Good afternoon! ReAgent AI can help with policy coverage, treaty referral clauses, claim forms, and investigation reports.",
  "good evening": "Good evening! Ask me about Kenya Re treaty clauses, claim coverage, exclusions, or escalation conditions."
};




// Common claims/underwriting queries - basic info only, detailed answers come from RAG
const commonQueries = {
  "what do you do": "I support reinsurance claims assessment and underwriting for Kenya Re: retrieve relevant policy/treaty clauses, check coverage and exclusions, flag anomalies, apply escalation/referral rules, and produce a cited recommendation for human review.",
  "how can you help": "I can retrieve treaty and policy clauses, check whether a claim appears covered or excluded, flag missing documents or anomalies, and highlight referral conditions that require human escalation. Try asking: \"What does the treaty say about claim referral thresholds?\"",
  "what information do you have": "I work from the knowledge base of policy wording, the reinsurance treaty, claim forms, fire investigation reports, and related claims context for Kenya Re decision support.",
  "help": "Ask about coverage, exclusions, treaty retention/capacity, claim referral thresholds (e.g. Article 6), missing documentation, or whether a claim should be escalated to a human reviewer."
};

// source for ReAgent AI Q&A snippets; load or replace this object accordingly.
const reagentResponses = {
  ...commonQueries
};

async function fetchWithTimeout(url, { method = 'GET', headers = {}, body, timeout = 8000 } = {}) {
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

export const handler = async function(event, context) {
  // Webhook verification (GET request from Meta)
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters;
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
    
    if (!VERIFY_TOKEN) {
      console.error("WHATSAPP_VERIFY_TOKEN not configured");
      return {
        statusCode: 500,
        body: "Server configuration error"
      };
    }


    if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === VERIFY_TOKEN) {
      return {
        statusCode: 200,
        body: params["hub.challenge"]
      };
    } else {
      return {
        statusCode: 403,
        body: "Verification failed"
      };
    }
  }

  // Handle incoming messages (POST request from Meta)
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body);
      console.log("Received WhatsApp webhook:", JSON.stringify(body, null, 2));

      // Extract message data
      if (body.object === "whatsapp_business_account" && body.entry && body.entry.length > 0) {
        const entry = body.entry[0];
        if (entry.changes && entry.changes.length > 0) {
          const change = entry.changes[0];
          if (change.value && change.value.messages && change.value.messages.length > 0) {
            const message = change.value.messages[0];
            const from = message.from; // Sender's phone number
            const text = message.text ? message.text.body : "";

            console.log(`Message from ${from}: ${text}`);

            // Process message with health check and fallbacks
            const response = await processMessage(text, from);
            
            // Send response back to WhatsApp
            await sendWhatsAppMessage(from, response);

            return {
              statusCode: 200,
              body: "Message processed"
            };
          }
        }
      }

      return {
        statusCode: 200,
        body: "Event received"
      };

    } catch (error) {
      console.error("Error processing webhook:", error);
      return {
        statusCode: 500,
        body: "Internal server error"
      };
    }
  }

  return {
    statusCode: 405,
    body: "Method Not Allowed"
  };
};

// Function to process message with health check and fallbacks
async function processMessage(message, from) {
  const normalizedMessage = normalize(message); // lower-cased, punctuation-stripped

  let ragIsHealthy = false;
  const ragBase = ragBaseUrl();
  try {
    if (ragBase) {
      await fetchWithTimeout(`${ragBase}/health`, { timeout: 1000 });
      ragIsHealthy = true;
      console.log("RAG server is healthy");
    } else {
      console.log("RAG_SERVER_URL not set; using LLM with rule-based reference context");
    }
  } catch (healthError) {
    console.log("RAG server health check failed, will use fallback mode");
    ragIsHealthy = false;
  }

  if (!ragIsHealthy) {
    console.log("Using fallback mode without RAG (LLM + greeting/common reference context)");
    try {
      if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY not set in environment");
      }
      const ruleContext = buildRuleBasedContextBlock();
      const systemPrompt = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Document RAG is offline: use the reference snippets in the next message when they match the user's intent; for other reinsurance claims/underwriting topics use careful reasoning or recommend human review. Be concise and professional. Always defer final claim decisions to a human reviewer. For unrelated questions, redirect politely to claims and underwriting topics.`;

      const messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Reference:\n${ruleContext}\n\nUser message: ${message}`,
        },
      ];
      try {
        console.log("Making LLM fallback call for message:", message.substring(0, 100) + "...");
        const response = await fetchWithTimeout(
          GROQ_API_URL,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: GROQ_MODEL,
              messages,
              max_tokens: 500,
              temperature: 0.7
            }),
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
          

        );
        const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
        console.log("LLM response received, length:", answer?.length || 0);
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Fallback LLM error:", llmError.response?.status, llmError.response?.data || llmError.message);
        return "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.";
      }
    } catch (error) {
      console.error("Error in LLM fallback when RAG is down:", error);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  }

  if (greetingResponses[normalizedMessage]) {
    return greetingResponses[normalizedMessage];
  }

  
  // If RAG is healthy, proceed with RAG
  try{
    const RAG_SERVER_URL = process.env.RAG_SERVER_URL;
    if (!RAG_SERVER_URL) {
      throw new Error("RAG_SERVER_URL not set in environment");
    }
    const ragResponse = await fetchWithTimeout(
      `${RAG_SERVER_URL}/rag`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: message }),
        timeout: 5000 // 5 seconds timeout for RAG retrieval when up
      }
    );

    // If answer is present, return it
    if (ragResponse && ragResponse.answer) {
      return cleanLlmAnswer(ragResponse.answer);
    }

    // If no answer, but context exists, use it in LLM fallback
    const retrievedContext = ragResponse && ragResponse.context;
    if (retrievedContext) {
      // --- LLM must answer ONLY from retrieved RAG context ---
      try {
        if (!GROQ_API_KEY) {
          throw new Error("GROQ_API_KEY not set in environment");
        }
        const systemPrompt = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Your role is to support reinsurance claims assessment and underwriting by reasoning over policy documents, reinsurance treaties, claim forms, and investigation reports: check coverage and exclusions, flag anomalies, apply escalation/referral rules (including treaty referral conditions), and produce a recommendation with cited evidence. Always defer final decisions to a human reviewer — never auto-approve or auto-deny claims. Base answers ONLY on the retrieved context provided. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base. A human reviewer should obtain the missing documentation or confirm with Kenya Re underwriting/claims." For questions unrelated to reinsurance claims or underwriting, politely redirect: "I appreciate your question, but I'm specifically designed to assist with Kenya Re claims assessment and underwriting. How can I help with a claim or treaty question?" Never identify yourself as an AI model or mention model providers.`;
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Retrieved context: ${Array.isArray(retrievedContext) ? retrievedContext.join(" ") : retrievedContext}` },
          { role: "user", content: message }
        ];
        const response = await fetchWithTimeout(
          GROQ_API_URL,
          {
            method: "POST",
            headers: {
              'Authorization': `Bearer ${GROQ_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model: GROQ_MODEL, messages }),
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
        );
        const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Error in LLM request:", llmError);
        return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      }
    }

    // If no context, fall back to FAQ/cached info as context
    const allFaqs = [
      ...Object.values(greetingResponses),
      ...Object.values(reagentResponses)
    ].join(" ");
    try {
      if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY not set in environment");
      }
      const systemPrompt = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Your role is to answer questions about reinsurance claims and underwriting using the official information provided (policy, treaty, claim form, investigation reports). Do not speculate and do not use general knowledge. If the information is not present, say you do not have official information about that topic and recommend human review. Always defer final claim decisions to a human reviewer. For questions unrelated to claims or underwriting, politely redirect the user to those topics. Never identify yourself as an AI model or mention model providers.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Official information: ${allFaqs}` },
        { role: "user", content: message }
      ];
      try {
        const response = await fetchWithTimeout(
          GROQ_API_URL,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: GROQ_MODEL,
              messages
            }),
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
        );
        const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Error in LLM request:", llmError.response?.status, llmError.response?.data || llmError.message);
        return "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.";
      }
    } catch (error) {
      console.error("Error in fallback LLM request:", error);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  } catch (error) {
    console.error("Error in RAG request:", error);
    // If RAG fails, proceed with LLM fallback using greetings and common query context
    try {
      if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY not set in environment");
      }
      const allFaqs = [
        ...Object.values(greetingResponses),
        ...Object.values(commonQueries)
      ].join(" ");
      const systemPrompt = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Your primary role is to support reinsurance claims assessment and underwriting. For claims/underwriting questions, answer based on available information or recommend human review with Kenya Re claims/underwriting. Always defer final decisions to a human reviewer — never auto-approve or auto-deny claims. For unrelated questions, politely redirect: "I appreciate your question, but I'm specifically designed to assist with Kenya Re claims assessment and underwriting. How can I help with a claim or treaty question?" Never identify yourself as an AI model or mention model providers.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ];
      const response = await fetchWithTimeout(
        GROQ_API_URL,
        {
          method: "POST",
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: GROQ_MODEL, messages }),
          timeout: 8000 // 8 seconds timeout for LLM fallback
        }
      );
      const answer = cleanLlmAnswer(response?.choices?.[0]?.message?.content);
      return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    } catch (llmError) {
      console.error("Error in LLM fallback:", llmError);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  }
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

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

function ragBaseUrl() {
  const raw = process.env.RAG_SERVER_URL;
  if (!raw || !String(raw).trim()) return null;
  const t = String(raw).replace(/\/$/, "");
  if (/\/ask$/i.test(t)) return t.replace(/\/ask$/i, "") || t;
  return t;
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

// Function to send message back to WhatsApp
async function sendWhatsAppMessage(to, message) {
  try {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      console.error("Missing WhatsApp credentials");
      return;
    }

    const response = await fetchWithTimeout(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: message }
        }),
        timeout: 15000
      }
    );

    console.log("WhatsApp message sent:", response);
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
  }
}
