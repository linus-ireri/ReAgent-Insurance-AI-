// rag.js
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import axios from "axios";
import dotenv from "dotenv";
import { cleanLlmAnswer } from "./lib/clean-llm-answer.js";

dotenv.config();

async function main() {
  console.log("🚀 Loading vector store...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2"
  });

  const vectorStore = await HNSWLib.load("vector_store", embeddings);

  // 🔍 Example question (replace or pass dynamically)
  const question = "What does the treaty say about claim referral thresholds?";

  console.log("\n🔎 Retrieving relevant context...");
  const results = await vectorStore.similaritySearch(question, 5);

  if (results.length === 0) {
    console.error("❌ No relevant context found. Exiting.");
    process.exit(1);
  }

  const context = results
    .map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`)
    .join("\n\n");

  // 🧠 Strict, structured prompt to prevent hallucination
  const prompt = `
You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Your job is to answer the user's question *strictly and only* based on the provided context from policy documents, reinsurance treaties, claim forms, and investigation reports. If an answer is found in the context, respond to what the user is asking. Be professional and cite sources.

If the answer cannot be found exactly in the context, respond with:
"I don't have that information in my knowledge base. A human reviewer should obtain the missing documentation or confirm with Kenya Re underwriting/claims."

Follow these rules:
- Do NOT invent or assume information.
- Quote exact information about coverage, exclusions, retention, referral/escalation conditions, and claim facts when available.
- Never mix information from outside the retrieved context.
- Maintain a professional, helpful, and factual tone.
- Produce recommendations with cited evidence; always defer final decisions to a human reviewer — never auto-approve or auto-deny claims.

-----------------------
Retrieved Context:
${context}
-----------------------

User Question: ${question}

Answer:
`;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("❌ No LLM API key found. Set GROQ_API_KEY.");
    process.exit(1);
  }
  const groqModel = "qwen/qwen3.8-27b";
  const apiUrl = "https://api.groq.com/openai/v1/chat/completions";

  try {
    console.log("\n💬 Querying LLM...");
    const body = {
      model: groqModel,
      messages: [
        { role: "system", content: "You are ReAgent AI, an agentic claims and underwriting decision-support assistant for Kenya Reinsurance Corporation (Kenya Re). Answer questions accurately based only on provided context from policy documents, reinsurance treaties, claim forms, and investigation reports. Cite evidence and always defer final claim decisions to a human reviewer." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1, // 🔒 ensures factuality with minimal variation
      max_tokens: 500
    };

    const response = await axios.post(apiUrl, body, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });

    const answer = cleanLlmAnswer(response.data?.choices?.[0]?.message?.content) || "[No answer returned]";
    console.log("\n----- LLM Answer -----\n");
    console.log(answer);
  } catch (err) {
    console.error("\n❌ Error calling LLM provider:");
    console.error(err.response?.data || err.message);
  }
}

main().catch(err => {
  console.error("❌ Fatal Error:", err);
  process.exit(1);
});
