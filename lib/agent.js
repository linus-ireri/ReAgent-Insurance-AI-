/**
 * lib/agent.js
 *
 * Agent tool-calling loop for ReAgent AI.
 *
 * Purpose: provide an independent, importable agent runner that uses
 * Groq's OpenAI-compatible chat completions API and a tool-calling
 * pattern. This module intentionally does not modify existing server
 * endpoints; it exports `runAgent` which can be wired into an Express
 * route (see the minimal change in rag-server.js).
 *
 * NOTE: It's unclear whether 'qwen/qwen3.8-27b' supports Groq's
 * tool-calling parameters ('tools' / 'tool_choice'). I recommend and
 * use a Groq model known to support tool/function calling semantics
 * in this file: 'llama-3.3-70b-versatile'. Do NOT change the model
 * used by the existing `/rag` and `/ask` endpoints.
 */

import axios from 'axios';
import { fileURLToPath } from 'url';
import { cleanLlmAnswer } from './clean-llm-answer.js';
import { checkClaimAnomaly } from './anomalyCheck.js';

// Agent model (chosen to support tool-calling). Do NOT change server.js endpoints.
// Updated per request to use gpt-oss-120b for agent tool-calls.
const AGENT_GROQ_MODEL = 'gpt-oss-120b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT = 20000; // per-call timeout, matching server.js

/**
 * Tools available to the agent. Each tool follows OpenAI function schema.
 * Implementations are resolved dynamically in the runAgent loop below.
 */
const TOOLS = [
  {
    type: 'function',
    name: 'query_policy_documents',
    description:
      'Search the policy, reinsurance treaty, claim form, and fire investigation report for relevant clauses, facts, or context. Use this whenever you need information grounded in the actual documents, such as coverage terms, exclusions, warranties, or treaty referral conditions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query', },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'check_claim_anomaly',
    description:
      'Check whether a specific claim is statistically unusual compared to historical claims data — sprinkler presence, claim-to-sum-insured ratio, prior claims count, notification delay, whether the cause of loss is confirmed. Use this when assessing claim risk or deciding whether a claim needs escalation.',
    parameters: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'Claim ID to check' },
      },
      required: ['claimId'],
    },
  },
];

/**
 * Run the agent with tool-calling loop.
 * @param {{question:string, claimId?:string, vectorStore:object}} opts
 * @returns {Promise<{answer:string, trace:array, raw_tool_calls_count:number}>}
 */
export async function runAgent({ question, claimId, vectorStore }) {
  if (!question || typeof question !== 'string') throw new Error('Missing question');
  if (!vectorStore) throw new Error('vectorStore is required');

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  // Build system prompt by reusing the server's systemPrompt guidelines,
  // but explicitly inform the assistant that tools are available.
  const systemPrompt = `You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Re.
Your role is to support reinsurance claims assessment and underwriting by reasoning over policy documents, reinsurance treaties, claim forms, and investigation reports.
You have access to tools which you MUST call when you need grounded information or specialized checks. When a tool is required, call it rather than guessing. Always defer final decisions to a human reviewer.`;

  // Build initial messages
  const userText = claimId ? `Claim ${claimId}: ${question}` : question;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  const trace = [];
  let raw_tool_calls_count = 0;

  // Helper: execute a single tool call
  async function executeToolCall(toolName, argsObj) {
    if (toolName === 'query_policy_documents') {
      const q = String(argsObj.query || '');
      const docs = await vectorStore.similaritySearch(q, 5);
      const formatted = docs.map((d, i) => `Context #${i + 1}:\n${d.pageContent}`).join('\n\n');
      return formatted;
    }
    if (toolName === 'check_claim_anomaly') {
      const id = String(argsObj.claimId || '');
      const result = await checkClaimAnomaly(id);
      return JSON.stringify(result);
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Main loop: ask model, run tool calls if any, repeat up to 5 iterations
  for (let iter = 0; iter < 5; iter++) {
    // Prepare request body including tools in OpenAI/Groq schema
    const body = {
      model: AGENT_GROQ_MODEL,
      messages,
      tools: TOOLS,
    };

    let response;
    try {
      console.log('DEBUG: sending agent request body:', JSON.stringify(body, null, 2));
      response = await axios.post(GROQ_API_URL, body, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: GROQ_TIMEOUT,
      });
    } catch (llmErr) {
      console.error('DEBUG: LLM error response data:', llmErr.response?.data);
      const details = llmErr.response?.data || llmErr.message;
      // If model not found, fall back to a non-tool path using the server's qwen model
      const code = llmErr.response?.data?.error?.code;
      if (code === 'model_not_found') {
        console.warn('Agent model not available; falling back to qwen model without tool-calling.');
        // Execute tools proactively and then call qwen model with results embedded in the prompt
        const localTrace = [];
        // Execute policy search for the question
        let policyResult = '';
        try {
          policyResult = await executeToolCall('query_policy_documents', { query: question });
          localTrace.push({ tool: 'query_policy_documents', input: { query: question }, output: policyResult });
          raw_tool_calls_count += 1;
        } catch (e) {
          policyResult = `Tool error: ${e.message}`;
          localTrace.push({ tool: 'query_policy_documents', input: { query: question }, output: policyResult });
        }

        // Execute anomaly check if claimId provided
        let anomalyResult = '';
        if (claimId) {
          try {
            anomalyResult = await executeToolCall('check_claim_anomaly', { claimId });
            localTrace.push({ tool: 'check_claim_anomaly', input: { claimId }, output: anomalyResult });
            raw_tool_calls_count += 1;
          } catch (e) {
            anomalyResult = `Tool error: ${e.message}`;
            localTrace.push({ tool: 'check_claim_anomaly', input: { claimId }, output: anomalyResult });
          }
        }

        // Build fallback prompt
        const fallbackSystem = systemPrompt + '\n(FALLBACK MODE: tools executed locally; the model does not support remote tool-calling.)';
        const fallbackUser = `Context (retrieved):\n${policyResult}\n\nAnomaly check (if any):\n${anomalyResult}\n\nUser question: ${userText}`;

        // Call the qwen model used elsewhere in server.js
        try {
          const fallbackBody = { model: 'qwen/qwen3.8-27b', messages: [ { role: 'system', content: fallbackSystem }, { role: 'user', content: fallbackUser } ] };
          console.log('DEBUG: sending fallback request body:', JSON.stringify(fallbackBody, null, 2));
          const fallbackResp = await axios.post(GROQ_API_URL, fallbackBody, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: GROQ_TIMEOUT,
          });
          const rawAnswer = fallbackResp.data?.choices?.[0]?.message?.content || '';
          const answer = cleanLlmAnswer(rawAnswer) || '[No answer returned]';
          return { answer, trace: localTrace, raw_tool_calls_count };
        } catch (fallbackErr) {
          const fdetails = fallbackErr.response?.data || fallbackErr.message;
          throw new Error(`Fallback LLM call failed: ${JSON.stringify(fdetails)}`);
        }
      }
      throw new Error(`LLM call failed: ${JSON.stringify(details)}`);
    }

    const choice = response.data?.choices?.[0]?.message;
    if (!choice) {
      throw new Error('No choice returned from LLM');
    }

    // If the model requested a tool call, Groq/OpenAI style put it in 'tool_calls'
    const toolCalls = choice.tool_calls || []; // defensive

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Append the assistant's tool call message as returned by the model
      messages.push(choice);

      for (const tcall of toolCalls) {
        raw_tool_calls_count += 1;
        const toolName = tcall.name;
        let argsObj = {};
        try {
          argsObj = typeof tcall.arguments === 'string' ? JSON.parse(tcall.arguments) : (tcall.arguments || {});
        } catch (e) {
          // If parsing fails, send raw string as single argument
          argsObj = { raw: tcall.arguments };
        }

        // Execute the tool implementation
        let output;
        try {
          output = await executeToolCall(toolName, argsObj);
        } catch (toolErr) {
          output = `Tool execution error: ${toolErr.message}`;
        }

        // Record trace
        trace.push({ tool: toolName, input: argsObj, output });

        // Append tool result as a tool-message (matching Groq/OpenAI style)
        messages.push({ role: 'tool', name: toolName, content: String(output), tool_call_id: tcall.id });
      }

      // continue loop to send messages with tool outputs back to model
      continue;
    }

    // No tool calls: final assistant answer
    const rawAnswer = choice.content || '';
    const answer = cleanLlmAnswer(rawAnswer) || '[No answer returned]';
    return { answer, trace, raw_tool_calls_count };
  }

  // If we exit loop without final answer
  return { answer: '[Incomplete — max iterations reached]', trace, raw_tool_calls_count };
}
