import express from "express";
import type { Request, Response } from "express";
import * as dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import { Mppx } from "@okxweb3/mpp";
import { charge } from "@okxweb3/mpp/evm/server";
import { SaApiClient } from "@okxweb3/mpp/evm";
import { extractJsonFromStdout } from "./utils.js";

dotenv.config();
const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ---------- Diagnostic helper: runs a CLI command and logs EVERYTHING, no swallowing ----------
async function runDiagnosedCommand(label: string, cmd: string): Promise<any> {
  console.log(`[${label}] Running: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stderr) console.log(`[${label}] STDERR: ${stderr}`);
    console.log(`[${label}] STDOUT (raw, first 1000 chars): ${stdout.slice(0, 1000)}`);
    const parsed = extractJsonFromStdout(stdout);
    if (!parsed) {
      console.log(`[${label}] WARNING: stdout did not contain parseable JSON.`);
    }
    return { stdout, stderr, parsed, error: null };
  } catch (e: any) {
    // exec throws when the command exits non-zero OR fails to spawn at all (e.g. "not found")
    console.log(`[${label}] EXEC THREW AN ERROR (this is the real failure — nothing was swallowed):`);
    console.log(`[${label}]   error.message: ${e.message}`);
    console.log(`[${label}]   error.code: ${e.code}`);
    console.log(`[${label}]   error.stdout: ${e.stdout || "(none)"}`);
    console.log(`[${label}]   error.stderr: ${e.stderr || "(none)"}`);
    return { stdout: e.stdout || "", stderr: e.stderr || "", parsed: null, error: e.message };
  }
}

// ---------- Boot-time self-check: run once at server startup, before accepting traffic ----------
async function runBootDiagnostics() {
  console.log("\n================ BOOT DIAGNOSTICS START ================");

  console.log("\n--- Check 1: Is the onchainos binary present and executable? ---");
  await runDiagnosedCommand("BOOT: version", "onchainos --version");

  console.log("\n--- Check 2: Is there an authenticated wallet session in this container? ---");
  await runDiagnosedCommand("BOOT: wallet-status", "onchainos wallet status");

  console.log("\n--- Check 3: Can we actually call a real read-only agent command? ---");
  // Using CertiK's known public agentId (1965) as a stable test target — not tied to any account.
  await runDiagnosedCommand("BOOT: agent-profile-test", "onchainos agent profile 1965");

  console.log("\n--- Check 4: Does ~/.onchainos config directory exist in this container? ---");
  await runDiagnosedCommand("BOOT: home-config-check", "ls -la ~/.onchainos 2>&1 || echo '~/.onchainos DOES NOT EXIST'");

  console.log("\n================ BOOT DIAGNOSTICS END ================\n");
}

const saClient = new SaApiClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  onError: (info) => {
    console.log(`\n[SA API ERROR] ==========================================`);
    console.log(`[SA API ERROR] method: ${info.method}`);
    console.log(`[SA API ERROR] path: ${info.path}`);
    console.log(`[SA API ERROR] httpStatus: ${info.httpStatus}`);
    console.log(`[SA API ERROR] code: ${info.code}`);
    console.log(`[SA API ERROR] msg: ${info.msg}`);
    console.log(`[SA API ERROR] requestBody: ${info.requestBody}`);
    console.log(`[SA API ERROR] responseBody: ${info.responseBody}`);
    console.log(`[SA API ERROR] ==========================================\n`);
  },
});

const mppx = Mppx.create({
  methods: [charge({ saClient })],
  realm: "SLA-Warden Production Oracle",
  secretKey: process.env.MPP_SECRET_KEY!,
});

const CHARGE_CONFIG = {
  // Set VERIFY_FEE_AMOUNT in Render env vars: "0" for free testing, "10000" for 0.01 USDT (6 decimals, confirmed live)
  amount: process.env.VERIFY_FEE_AMOUNT || "0",
  currency: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  recipient: "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291",
  description: "Counterparty Check — Pre-Trust Verification",
  methodDetails: { chainId: 196, feePayer: true },
};

interface VerifyBody {
  targetAgentId: string;
  expectedServiceName?: string;
  expectedServiceType?: string;
  transactionPayload?: {
    to: string;
    data: string;
    value: string;
  };
}

async function analyzeReviewsWithAI(reviewsText: string): Promise<{ signal: string; source: string }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("   -> [AI DIAGNOSTIC] OPENROUTER_API_KEY is NOT SET in this environment. Skipping AI call, defaulting to neutral.");
    return { signal: "neutral", source: "skipped_no_api_key" };
  }
  console.log(`   -> [AI DIAGNOSTIC] OPENROUTER_API_KEY present (first 6 chars: ${process.env.OPENROUTER_API_KEY.slice(0, 6)}...). Calling OpenRouter...`);
  console.log(`   -> [AI DIAGNOSTIC] Review text being sent (first 200 chars): ${reviewsText.slice(0, 200)}`);

  try {
    const modelsToTry = [
      "meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/free", // auto-router fallback if the primary free model is rotated out
    ];
    let lastError = "";

    for (const model of modelsToTry) {
      console.log(`   -> [AI DIAGNOSTIC] Trying model: ${model}`);
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "You are a risk audit intelligence module. Analyze the following text reviews for an AI agent. Classify the cumulative user sentiment/reliability experience into exactly one of these tokens: positive, negative, or neutral. Return only the token word."
            },
            { role: "user", content: reviewsText }
          ]
        })
      });

      console.log(`   -> [AI DIAGNOSTIC] Model ${model} HTTP status: ${response.status}`);
      const aiData = await response.json();

      if (!response.ok) {
        lastError = `api_error_status_${response.status}_model_${model}`;
        console.log(`   -> [AI DIAGNOSTIC] ${model} failed: ${JSON.stringify(aiData).slice(0, 300)}`);
        continue; // try next model
      }

      const rawContent = aiData?.choices?.[0]?.message?.content;
      console.log(`   -> [AI DIAGNOSTIC] Raw model output: "${rawContent}"`);
      const token = rawContent?.trim().toLowerCase() || "neutral";
      const validToken = ["positive", "negative", "neutral"].includes(token);
      return { signal: validToken ? token : "neutral", source: `live_ai_call_${model}` };
    }

    return { signal: "neutral", source: lastError || "all_models_failed" };
  } catch (err: any) {
    console.log(`   -> [AI DIAGNOSTIC] Network/parse error calling OpenRouter: ${err.message}`);
    return { signal: "neutral", source: "network_error" };
  }
}

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Manual diagnostic endpoint — gated behind a secret so it's not publicly exposed.
// Set DEBUG_SECRET in Render's env vars, then call with ?key=YOUR_SECRET
app.get("/debug/cli-status", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) {
    return res.status(404).json({ error: "endpoint_not_found" });
  }

  const versionCheck = await runDiagnosedCommand("DEBUG: version", "onchainos --version");
  const walletCheck = await runDiagnosedCommand("DEBUG: wallet-status", "onchainos wallet status");
  const profileCheck = await runDiagnosedCommand("DEBUG: agent-profile-test", "onchainos agent profile 1965");
  const homeCheck = await runDiagnosedCommand("DEBUG: home-config", "ls -la ~/.onchainos 2>&1 || echo 'MISSING'");

  return res.json({
    binaryPresent: !versionCheck.error,
    versionOutput: versionCheck.stdout || versionCheck.error,
    walletStatus: walletCheck.parsed || walletCheck.error,
    sampleAgentLookup: profileCheck.parsed || profileCheck.error,
    homeConfigDir: homeCheck.stdout || homeCheck.error,
  });
});

app.post("/api/v1/verify", async (req: Request, res: Response) => {
  console.log(`\n--- [INCOMING REQUEST] ${new Date().toISOString()} ---`);
  console.log(`Target Agent ID: ${req.body?.targetAgentId || "None"}`);

  const fullUrl = `https://sla-warden.onrender.com/api/v1/verify`;
  const webHeaders = new Headers();
  Object.entries(req.headers).forEach(([k, v]) => {
    if (v) webHeaders.append(k, Array.isArray(v) ? v.join(", ") : v);
  });

  const rawSig = req.headers["payment-signature"];
  if (rawSig && !req.headers["authorization"]) {
    const formattedSig = String(rawSig).startsWith("Payment ") ? String(rawSig) : `Payment ${rawSig}`;
    webHeaders.append("authorization", formattedSig);
    console.log("[Layer 1 DEBUG] Remapped payment-signature header onto Authorization.");
  }

  const webRequest = new globalThis.Request(fullUrl, {
    method: req.method,
    headers: webHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
  });

  console.log("[Layer 1] Validating OKX MPP Protocol payment gates...");
  const result = await mppx.charge(CHARGE_CONFIG)(webRequest);

  if (result.status === 402) {
    const challengeText = result.challenge ? await result.challenge.text() : "";
    console.log(`[Layer 1 DEBUG] Full challenge response body: ${challengeText}`);
    return res.status(402)
      .set("WWW-Authenticate", result.challenge.headers.get("WWW-Authenticate")!)
      .json();
  }
  console.log("[Layer 1 Verified] Payment cleared.");

  const { targetAgentId, expectedServiceName, expectedServiceType, transactionPayload } = req.body as VerifyBody;
  if (!targetAgentId) {
    return res.status(400).json({ error: "missing_parameter: targetAgentId" });
  }

  try {
    let verdict = "PASS";
    const flags: string[] = [];
    const summaryChecks: Record<string, any> = {
      identity: "unknown",
      reputation: { score: "-", reviewCount: 0, aiSignal: "neutral" },
      serviceMatch: "skipped",
      payloadRisk: "clear"
    };

    // --- LAYER 2: IDENTITY & REGISTRATION AUDIT ---
    console.log(`[Layer 2] Auditing identity for agent: ${targetAgentId}`);
    const profileCmd = `onchainos agent profile ${targetAgentId}`;
    const profileCheck = await runDiagnosedCommand("Layer 2", profileCmd);
    const profileResult = profileCheck.parsed;

    if (!profileResult || !profileResult.ok || !profileResult.data) {
      verdict = "BLOCK";
      flags.push(profileCheck.error ? `cli_execution_failed: ${profileCheck.error}` : "target_agent_id_not_found_in_registry");
      summaryChecks.identity = "unregistered_or_cli_error";
      console.log("   -> BLOCK: identity check failed (see Layer 2 log lines above for real cause).");
    } else {
      const statusLabel = profileResult.data.statusLabel ?? "unknown";
      if (statusLabel === "active") {
        summaryChecks.identity = "registered";
        console.log(`   -> Identity confirmed active: ${profileResult.data.name || "Unnamed"}`);
      } else {
        verdict = "BLOCK";
        flags.push(`agent_registry_status_not_active_${statusLabel}`);
        summaryChecks.identity = statusLabel;
        console.log(`   -> BLOCK: status is "${statusLabel}", not active.`);
      }
    }

    // --- LAYER 3: REPUTATION & AI SENTIMENT ANALYSIS ---
    if (verdict !== "BLOCK") {
      console.log(`[Layer 3] Auditing feedback for agent: ${targetAgentId}`);
      const feedbackCmd = `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20`;
      const feedbackCheck = await runDiagnosedCommand("Layer 3", feedbackCmd);
      const feedbackResult = feedbackCheck.parsed;

      if (feedbackResult && feedbackResult.ok && feedbackResult.data) {
        const totalCount = feedbackResult.data.totalCount || 0;
        const totalScore = feedbackResult.data.totalScore || "-";
        summaryChecks.reputation.reviewCount = totalCount;
        summaryChecks.reputation.score = totalScore;

        if (totalCount === 0) {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("unproven_agent_zero_reviews");
          console.log("   -> CAUTION: zero reviews.");
        } else {
          const reviewComments = (feedbackResult.data.list || [])
            .map((r: any) => r.content || "")
            .filter((c: string) => c.length > 0)
            .join("\n");

          if (reviewComments.length > 0) {
            const aiResult = await analyzeReviewsWithAI(reviewComments);
            summaryChecks.reputation.aiSignal = aiResult.signal;
            summaryChecks.reputation.aiSignalSource = aiResult.source;
            if (aiResult.signal === "negative") {
              if (verdict !== "BLOCK") verdict = "CAUTION";
              flags.push("llm_extracted_critical_reliability_concerns");
              console.log("   -> CAUTION: AI flagged negative sentiment in reviews.");
            } else {
              console.log(`   -> AI sentiment: [${aiResult.signal.toUpperCase()}] (source: ${aiResult.source})`);
            }
          }
        }
      } else {
        flags.push(feedbackCheck.error ? `feedback_lookup_cli_error: ${feedbackCheck.error}` : "feedback_lookup_failed");
        console.log("   -> WARNING: feedback-list lookup failed (see Layer 3 log lines above).");
      }
    }

    // --- LAYER 4: CLAIMED VS REGISTERED SERVICE MATCH ---
    if (verdict !== "BLOCK") {
      console.log(`[Layer 4] Auditing registered services for agent: ${targetAgentId}`);
      const serviceCmd = `onchainos agent service-list --agent-id ${targetAgentId}`;
      const serviceCheck = await runDiagnosedCommand("Layer 4", serviceCmd);
      const serviceResult = serviceCheck.parsed;

      const registeredServices = serviceResult?.ok && Array.isArray(serviceResult?.data) && serviceResult.data[0]?.list
        ? serviceResult.data[0].list
        : [];

      if (registeredServices.length === 0) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push(serviceCheck.error ? `service_list_cli_error: ${serviceCheck.error}` : "zero_registered_commercial_services_found");
        summaryChecks.serviceMatch = "no_services_found";
        console.log("   -> CAUTION: no registered services found (see Layer 4 log lines above).");
      } else if (expectedServiceName || expectedServiceType) {
        const matchFound = registeredServices.some((svc: any) => {
          const nameMatch = expectedServiceName ? svc.serviceName?.toLowerCase() === expectedServiceName.toLowerCase() : true;
          const typeMatch = expectedServiceType ? svc.serviceType?.toLowerCase() === expectedServiceType.toLowerCase() : true;
          return nameMatch && typeMatch;
        });
        if (matchFound) {
          summaryChecks.serviceMatch = "matched";
          console.log("   -> Service claim matches registration.");
        } else {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("claimed_service_profile_mismatch");
          summaryChecks.serviceMatch = "mismatch";
          console.log("   -> CAUTION: claimed service not found in registered list.");
        }
      } else {
        summaryChecks.serviceMatch = "unspecified";
      }
    }

    // --- LAYER 5: PAYLOAD & CONTRACT RISK SCAN ---
    if (transactionPayload && verdict !== "BLOCK") {
      console.log("[Layer 5] Running tx-scan (includes internal simulation data)...");
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";

      const scanCmd = `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain xlayer`;
      const scanCheck = await runDiagnosedCommand("Layer 5", scanCmd);
      const scanResult = scanCheck.parsed;

      const risks = scanResult?.data?.riskItemDetail || [];
      const warnings = scanResult?.data?.warnings || [];
      const revertReason = scanResult?.data?.simulator?.revertReason || "";

      if (risks.length > 0 || warnings.length > 0) {
        verdict = "BLOCK";
        flags.push(`security_scan_flagged_risk_items: ${risks.length}`);
        summaryChecks.payloadRisk = "flagged";
        console.log("   -> BLOCK: tx-scan flagged risk items or warnings.");
      } else if (revertReason) {
        verdict = "BLOCK";
        flags.push(`simulation_would_revert: ${revertReason}`);
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "would_revert";
        console.log(`   -> BLOCK: simulation predicts revert. ${revertReason}`);
      } else if (scanCheck.error) {
        flags.push(`tx_scan_cli_error: ${scanCheck.error}`);
        console.log("   -> WARNING: tx-scan lookup failed (see Layer 5 log lines above).");
      } else {
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "stable";
        console.log("   -> tx-scan clear.");
      }
    }

    const businessData = {
      verdict,
      targetAgentId,
      checks: summaryChecks,
      flags,
      timestamp: new Date().toISOString(),
    };

    console.log(`[Evaluation Finalized] Result: [${verdict}] with ${flags.length} flag(s).\n`);

    const webResponse = new globalThis.Response(JSON.stringify(businessData), { status: 200 });
    const finalizedResponse = result.withReceipt(webResponse);
    finalizedResponse.headers.forEach((v, k) => res.setHeader(k, v));
    return res.json(businessData);
  } catch (err: any) {
    console.log(`[Internal Failure] ${err.message}`);
    return res.status(500).json({ error: "internal_system_error", message: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "endpoint_not_found" });
});

app.listen(PORT, async () => {
  console.log(`[Counterparty Check] Server active on port ${PORT}`);
  await runBootDiagnostics();
});