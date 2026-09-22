ReAgent AI - Synthetic Data Pack (Step 1 of the build roadmap)
================================================================

This pack is a self-contained, realistic reinsurance claims scenario for the
Kenya Re AI4I Hackathon 2026 (theme: Redefining Reinsurance Business Processes
with Agentic AI and Machine Learning).

Scenario: Mavuno Textiles Limited, a Nairobi textile factory, suffers a fire.
The claim (KES 85,000,000) sits above the cedant's treaty retention, so it
becomes a reinsurance claim for Kenya Re.

FILES

01_policy.txt
  The original insurance policy (Amani General -> Mavuno Textiles). Contains
  perils covered, exclusions, warranties (fire protection, housekeeping), and
  the excess/deductible. Your Claims Agent needs this to check coverage.

02_reinsurance_treaty.txt
  The Kenya Re treaty with the cedant. Contains retention/capacity, the
  underwriting "Section 4.2" enhanced-assessment clause your original prompt
  referenced, exclusions, and - importantly - Article 6, which lists exactly
  the conditions that require escalation to a human before a claim can be
  settled. This is the single most useful document for demoing "agentic"
  decision logic, since Article 6.1(a)-(d) gives you clean, checkable
  escalation triggers.

03_claim_form.txt
  The claim as submitted. Deliberately incomplete: the fire investigation
  report and sprinkler maintenance records are marked as outstanding at
  submission time. Good for testing "agent detects missing documentation."

04_fire_investigation_report.txt
  The independent loss adjuster's report, delivered ~2 weeks after the claim
  form. Contains a lower preliminary estimate than the insured's claim, and
  flags a probable Warranty breach (lapsed sprinkler maintenance, poor
  housekeeping) without giving a legal conclusion - exactly the kind of
  judgment call your Claims Agent should surface for human review rather
  than decide on its own.

05_historical_claims.csv
  29 prior claims plus this one (30 rows), for your anomaly/risk model.
  Useful signals already built in: claim-to-sum-insured ratio, notification
  delay, whether fire protection was present, and claim count for the
  insured. Row HC-030 (the current claim) already looks unusual on several
  of these axes on purpose - no sprinkler, 2 prior claims, cause still
  under investigation - so your model should be able to flag it without
  much tuning.

SUGGESTED FIRST TEST

Ask your RAG layer: "What does the treaty say about when a claim must be
referred to Kenya Re before settlement?" It should retrieve Article 6.1 from
02_reinsurance_treaty.txt and correctly identify that this claim triggers at
least two of the four conditions (loss exceeds KES 60,000,000, and cause /
warranty applicability is in doubt pending the investigation report).

NEXT STEPS (per the roadmap)
  Step 2: Ingest these into your existing HNSWLib/embeddings pipeline, test
          retrieval quality on questions like the one above.
  Step 3: Build the anomaly/risk check against 05_historical_claims.csv.
  Step 4: Build the agent that ties retrieval + anomaly check + escalation
          logic together and produces a recommendation with citations.
  Step 5: Dashboard showing the agent's reasoning trace.
