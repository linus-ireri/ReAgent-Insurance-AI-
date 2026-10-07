/**
 * anomalyCheck.js
 *
 * Rule-based anomaly detection for historical claims.
 * Designed to be imported and called as a tool by an LLM agent or
 * Netlify function orchestrator. Not a serverless function itself.
 */

import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "url";

// Thresholds (tune these constants as needed)
const RATIO_THRESHOLD_MULTIPLIER = 1.5; // claim_to_sum_insured_ratio > 1.5x historical average
const SPRINKLER_MAJORITY_THRESHOLD = 0.7; // historical proportion of sprinkler_present considered majority
const TAIL_PERCENTILE = 0.1; // top/bottom 10%
const ANOMALY_FLAG_SCORE = 2; // anomaly_score >= 2 -> anomaly_flag true

const CSV_PATH = "docs/05_historical_claims.csv";

const UNRESOLVED_CAUSE_MARKERS = [
  "Under investigation",
  "Undetermined",
  "Under review",
  "Open - current claim",
  "",
];

function asNumber(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function asBoolYes(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "true" || s === "1";
}

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * checkClaimAnomaly(claimId)
 * Returns structured anomaly info for the given claim id.
 *
 * @param {string} claimId
 * @returns {Promise<{claim_id:string, anomaly_flag:boolean, anomaly_score:number, max_possible_score:number, reasons:string[]}>}
 */
export async function checkClaimAnomaly(claimId) {
  const csvRaw = await fs.readFile(CSV_PATH, "utf8");
  const records = parse(csvRaw, { columns: true, skip_empty_lines: true });

  const normalizedClaimId = String(claimId || '').trim().toUpperCase();
  const target = records.find((r) => String(r.claim_id || '').trim().toUpperCase() === normalizedClaimId);
  if (!target) {
    throw new Error(`Claim ID not found: ${claimId}`);
  }

  // Parse features for target
  const target_claimed = asNumber(target.claimed_amount_kes);
  const target_sum_insured = asNumber(target.sum_insured_kes);
  const target_ratio = Number.isFinite(target_claimed) && Number.isFinite(target_sum_insured)
    ? target_claimed / target_sum_insured
    : NaN;
  const target_sprinkler = asBoolYes(target.sprinkler_present);
  const target_extinguisher_serviced = asBoolYes(target.extinguisher_serviced);
  const target_previous_claims = Number.isFinite(asNumber(target.previous_claims_count)) ? asNumber(target.previous_claims_count) : 0;
  const target_days_to_notify = Number.isFinite(asNumber(target.days_to_notify)) ? asNumber(target.days_to_notify) : NaN;
  const target_cause_confirmed = !UNRESOLVED_CAUSE_MARKERS.includes(String(target.cause_confirmed).trim());

  // Baselines computed across other records (exclude target)
  const others = records.filter((r) => String(r.claim_id || '').trim().toUpperCase() !== normalizedClaimId);

  const ratios = [];
  const sprinklerBooleans = [];
  const previousClaims = [];
  const daysToNotifyArr = [];
  const causeConfirmedBooleans = [];

  for (const r of others) {
    const claimed = asNumber(r.claimed_amount_kes);
    const sumIns = asNumber(r.sum_insured_kes);
    if (Number.isFinite(claimed) && Number.isFinite(sumIns) && sumIns !== 0) {
      ratios.push(claimed / sumIns);
    }
    sprinklerBooleans.push(asBoolYes(r.sprinkler_present) ? 1 : 0);
    previousClaims.push(Number.isFinite(asNumber(r.previous_claims_count)) ? asNumber(r.previous_claims_count) : 0);
    if (Number.isFinite(asNumber(r.days_to_notify))) daysToNotifyArr.push(asNumber(r.days_to_notify));
    causeConfirmedBooleans.push(UNRESOLVED_CAUSE_MARKERS.includes(String(r.cause_confirmed).trim()) ? 0 : 1);
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

  const baseline_ratio_avg = avg(ratios);
  const baseline_sprinkler_prop = avg(sprinklerBooleans); // proportion with sprinkler
  const baseline_previous_claims_avg = avg(previousClaims);
  const baseline_days_10th = percentile(daysToNotifyArr, TAIL_PERCENTILE);
  const baseline_days_90th = percentile(daysToNotifyArr, 1 - TAIL_PERCENTILE);
  const baseline_cause_resolved_prop = avg(causeConfirmedBooleans);

  // Rules
  let score = 0;
  const reasons = [];

  // 1. claim_to_sum_insured_ratio rule
  if (Number.isFinite(target_ratio) && Number.isFinite(baseline_ratio_avg)) {
    if (target_ratio > baseline_ratio_avg * RATIO_THRESHOLD_MULTIPLIER) {
      score += 1;
      reasons.push(`High claim-to-sum-insured ratio (${target_ratio.toFixed(2)} vs historical avg ${baseline_ratio_avg.toFixed(2)}).`);
    }
  }

  // 2. sprinkler missing while historical majority have it
  if (!target_sprinkler && Number.isFinite(baseline_sprinkler_prop)) {
    if (baseline_sprinkler_prop > SPRINKLER_MAJORITY_THRESHOLD) {
      score += 1;
      reasons.push(`No sprinkler system present (${Math.round(baseline_sprinkler_prop * 100)}% of historical claims had one).`);
    }
  }

  // 3. previous_claims_count greater than historical average
  if (Number.isFinite(target_previous_claims) && Number.isFinite(baseline_previous_claims_avg)) {
    if (target_previous_claims > baseline_previous_claims_avg) {
      score += 1;
      reasons.push(`Previous claims count (${target_previous_claims}) is greater than historical average (${baseline_previous_claims_avg.toFixed(2)}).`);
    }
  }

  // 4. days_to_notify in bottom or top 10%
  if (Number.isFinite(target_days_to_notify) && Number.isFinite(baseline_days_10th) && Number.isFinite(baseline_days_90th)) {
    if (target_days_to_notify <= baseline_days_10th || target_days_to_notify >= baseline_days_90th) {
      score += 1;
      reasons.push(`Days to notify (${target_days_to_notify}) is in the extreme ${Math.round(TAIL_PERCENTILE * 100)}% tail of historical distribution.`);
    }
  }

  // 5. cause_confirmed false while almost all historical claims are resolved
  if (!target_cause_confirmed && Number.isFinite(baseline_cause_resolved_prop)) {
    if (baseline_cause_resolved_prop > 0.9) {
      score += 1;
      reasons.push(`Cause not confirmed while ${Math.round(baseline_cause_resolved_prop * 100)}% of historical claims had confirmed causes.`);
    }
  }

  const max_possible_score = 5;
  const anomaly_flag = score >= ANOMALY_FLAG_SCORE;

  return {
    claim_id: String(target.claim_id),
    anomaly_flag,
    anomaly_score: score,
    max_possible_score,
    reasons,
  };
}

// CLI test runner (ESM-safe check matching project style)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const res = await checkClaimAnomaly("HC-030");
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error("Error:", err.message || err);
      process.exit(1);
    }
  })();
}
