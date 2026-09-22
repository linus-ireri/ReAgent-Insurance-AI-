// ingest.js
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import fs from "fs";
import path from "path";


// SOURCE FILES & CONFIG

const txtPaths = [
  "./docs/01_policy.txt",
  "./docs/02_reinsurance_treaty.txt",
  "./docs/03_claim_form.txt",
  "./docs/04_fire_investigation_report.txt"
];

const VECTOR_STORE_PATH = "./vector_store";

// LOADERS
async function loadTextFiles() {
  console.log("📄 Loading TXT source files...");
  const docs = [];

  for (const txtPath of txtPaths) {
    try {
      if (!fs.existsSync(txtPath)) {
        console.warn(`  Skipping missing file: ${txtPath}`);
        continue;
      }

      console.log(`  Loading: ${path.basename(txtPath)}`);
      const content = fs.readFileSync(txtPath, "utf8");

      docs.push({
        pageContent: content,
        metadata: {
          source: path.basename(txtPath),
          type: "txt"
        }
      });

      console.log(`  ✓ Loaded ${path.basename(txtPath)}`);
    } catch (error) {
      console.error(`  ✗ Error loading ${txtPath}:`, error.message);
    }
  }

  return docs;
}

//  MAIN INGESTION PIPELINE

async function main() {
  console.log("🚀 Starting RAG ingestion pipeline...\n");

  // 1. Load all source files for the policy/treaty/claim dataset
  const txtDocs = await loadTextFiles();
  const allDocs = [...txtDocs];

  if (allDocs.length === 0) {
    console.error("❌ No documents loaded. Exiting.");
    process.exit(1);
  }

  console.log(`\n📊 Total documents loaded: ${allDocs.length}`);

  // 2. Smart splitting for legal documents
  console.log("\n✂️  Splitting documents into structured chunks...");
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 700,
    chunkOverlap: 100,
    separators: ["\nSection ", "\nPART ", "\nCHAPTER ", "\n\n", ". "]
  });

  const splitDocs = await splitter.splitDocuments(allDocs);
  console.log(`  ✓ Created ${splitDocs.length} section-based chunks`);

  // 3. Clean and normalize
  const cleanDocs = splitDocs.map(doc => {
    doc.pageContent = doc.pageContent
      .replace(/Page\s\d+\sof\s\d+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return doc;
  });

  // 4. Initialize embeddings model (CPU-optimized)
  console.log("\n🤖 Loading embedding model...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2",
    batchSize: 8 // ✅ small batch size prevents memory errors
  });

  // 5. Create vector store incrementally
  console.log("\n🔢 Creating vector store in safe batches...");
  if (!fs.existsSync(VECTOR_STORE_PATH)) {
    fs.mkdirSync(VECTOR_STORE_PATH, { recursive: true });
  }

  const vectorStore = await HNSWLib.fromDocuments([], embeddings);

  const BATCH_SIZE = 50;
  for (let i = 0; i < cleanDocs.length; i += BATCH_SIZE) {
    const batch = cleanDocs.slice(i, i + BATCH_SIZE);
    console.log(`  → Processing batch ${Math.ceil(i / BATCH_SIZE) + 1}/${Math.ceil(cleanDocs.length / BATCH_SIZE)}...`);
    await vectorStore.addDocuments(batch);
    global.gc?.(); // Force garbage collection if available
  }

  await vectorStore.save(VECTOR_STORE_PATH);
  console.log(`\n💾 Vector store saved to: ${VECTOR_STORE_PATH}`);

  // 6. Summary
  console.log("\n✅ Ingestion complete!");
  console.log("📈 Summary:");
  console.log(`  - TXT files processed: ${txtPaths.length}`);
  console.log(`  - Total chunks: ${cleanDocs.length}`);
  console.log(`  - Vector store location: ${VECTOR_STORE_PATH}`);
}

main().catch(err => {
  console.error("\n❌ Ingestion failed:");
  console.error(err);
  process.exit(1);
});
