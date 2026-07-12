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

async function runDiagnosedCommand(label: string, cmd: string): Promise<any> {
  console.log(`[${label}] Running: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stderr) console.log(`[${label}] STDERR: ${stderr}`);
    const parsed = extractJsonFromStdout(stdout);
    if (!parsed) console.log(`[${label}] WARNING: stdout did not contain parseable JSON.`);
    return { stdout, stderr, parsed, error: null };
  } catch (e: any) {
    console.log(`[${label}] EXEC FAILED: ${e.message}`);
    return { stdout: e.stdout || "", stderr: e.stderr || "", parsed: null, error: e.message };
  }
}

async function runBootDiagnostics() {
  console.log("\n=== BOOT DIAGNOSTICS ===");
  await runDiagnosedCommand("BOOT: version", "onchainos --version");
  await runDiagnosedCommand("BOOT: wallet-status", "onchainos wallet status");
  // CertiK's public agentId — stable target, not tied to any of our accounts
  await runDiagnosedCommand("BOOT: agent-profile-test", "onchainos agent profile 1965");
  await runDiagnosedCommand("BOOT: home-config-check", "ls -la ~/.onchainos 2>&1 || echo '~/.onchainos DOES NOT EXIST'");
  console.log("=== BOOT DIAGNOSTICS END ===\n");
}

const saClient = new SaApiClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  onError: (info) => {
    console.log(`[SA API ERROR] ${info.method} ${info.path} -> ${info.httpStatus} (${info.code}): ${info.msg}`);
    console.log(`[SA API ERROR] responseBody: ${info.responseBody}`);
  },
});

const mppx = Mppx.create({
  methods: [charge({ saClient })],
  realm: "SLA-Warden Production Oracle",
  secretKey: process.env.MPP_SECRET_KEY!,
});

// VERIFY_FEE_AMOUNT lives in Render env vars — smallest units, e.g. 20000 = $0.02 on a 6-decimal token
const CHARGE_CONFIG = {
  amount: process.env.VERIFY_FEE_AMOUNT || "0",
  currency: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  recipient: "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291",
  description: "Counterparty Check - Pre-Trust Verification",
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
    return { signal: "neutral", source: "skipped_no_api_key" };
  }

  const modelsToTry = ["meta-llama/llama-3.3-70b-instruct:free", "openrouter/free"];
  let lastError = "";

  try {
    for (const model of modelsToTry) {
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

      const aiData = await response.json();
      if (!response.ok) {
        lastError = `api_error_status_${response.status}_model_${model}`;
        continue;
      }

      const rawContent = aiData?.choices?.[0]?.message?.content;
      const token = rawContent?.trim().toLowerCase() || "neutral";
      const validToken = ["positive", "negative", "neutral"].includes(token);
      return { signal: validToken ? token : "neutral", source: `live_ai_call_${model}` };
    }
    return { signal: "neutral", source: lastError || "all_models_failed" };
  } catch (err: any) {
    console.log(`[AI] Network/parse error: ${err.message}`);
    return { signal: "neutral", source: "network_error" };
  }
}

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Set DEBUG_SECRET in Render env vars, then call with ?key=YOUR_SECRET
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

  // Build the real request URL from what actually served this request,
  // not a hardcoded host — stays correct if we ever move off Render.
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"] || "sla-warden.onrender.com";
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  const webHeaders = new Headers();
  Object.entries(req.headers).forEach(([k, v]) => {
    if (v) webHeaders.append(k, Array.isArray(v) ? v.join(", ") : v);
  });

  const rawSig = req.headers["payment-signature"];
  if (rawSig && !req.headers["authorization"]) {
    const formattedSig = String(rawSig).startsWith("Payment ") ? String(rawSig) : `Payment ${rawSig}`;
    webHeaders.append("authorization", formattedSig);
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

    console.log(`[Layer 2] Auditing identity for agent: ${targetAgentId}`);
    const profileCheck = await runDiagnosedCommand("Layer 2", `onchainos agent profile ${targetAgentId}`);
    const profileResult = profileCheck.parsed;

    if (!profileResult || !profileResult.ok || !profileResult.data) {
      verdict = "BLOCK";
      flags.push(profileCheck.error ? `cli_execution_failed: ${profileCheck.error}` : "target_agent_id_not_found_in_registry");
      summaryChecks.identity = "unregistered_or_cli_error";
    } else {
      const statusLabel = profileResult.data.statusLabel ?? "unknown";
      if (statusLabel === "active") {
        summaryChecks.identity = "registered";
      } else {
        verdict = "BLOCK";
        flags.push(`agent_registry_status_not_active_${statusLabel}`);
        summaryChecks.identity = statusLabel;
      }
    }

    if (verdict !== "BLOCK") {
      console.log(`[Layer 3] Auditing feedback for agent: ${targetAgentId}`);
      const feedbackCheck = await runDiagnosedCommand("Layer 3", `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20`);
      const feedbackResult = feedbackCheck.parsed;

      if (feedbackResult && feedbackResult.ok && feedbackResult.data) {
        const totalCount = feedbackResult.data.totalCount || 0;
        summaryChecks.reputation.reviewCount = totalCount;
        summaryChecks.reputation.score = feedbackResult.data.totalScore || "-";

        if (totalCount === 0) {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("unproven_agent_zero_reviews");
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
            }
          }
        }
      } else {
        flags.push(feedbackCheck.error ? `feedback_lookup_cli_error: ${feedbackCheck.error}` : "feedback_lookup_failed");
      }
    }

    if (verdict !== "BLOCK") {
      console.log(`[Layer 4] Auditing registered services for agent: ${targetAgentId}`);
      const serviceCheck = await runDiagnosedCommand("Layer 4", `onchainos agent service-list --agent-id ${targetAgentId}`);
      const serviceResult = serviceCheck.parsed;
      const registeredServices = serviceResult?.ok && Array.isArray(serviceResult?.data) && serviceResult.data[0]?.list
        ? serviceResult.data[0].list
        : [];

      if (registeredServices.length === 0) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push(serviceCheck.error ? `service_list_cli_error: ${serviceCheck.error}` : "zero_registered_commercial_services_found");
        summaryChecks.serviceMatch = "no_services_found";
      } else if (expectedServiceName || expectedServiceType) {
        const matchFound = registeredServices.some((svc: any) => {
          const nameMatch = expectedServiceName ? svc.serviceName?.toLowerCase() === expectedServiceName.toLowerCase() : true;
          const typeMatch = expectedServiceType ? svc.serviceType?.toLowerCase() === expectedServiceType.toLowerCase() : true;
          return nameMatch && typeMatch;
        });
        if (matchFound) {
          summaryChecks.serviceMatch = "matched";
        } else {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("claimed_service_profile_mismatch");
          summaryChecks.serviceMatch = "mismatch";
        }
      } else {
        summaryChecks.serviceMatch = "unspecified";
      }
    }

    if (transactionPayload && verdict !== "BLOCK") {
      console.log("[Layer 5] Running tx-scan...");
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";

      const scanCheck = await runDiagnosedCommand("Layer 5", `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain xlayer`);
      const scanResult = scanCheck.parsed;
      const risks = scanResult?.data?.riskItemDetail || [];
      const warnings = scanResult?.data?.warnings || [];
      const revertReason = scanResult?.data?.simulator?.revertReason || "";

      if (risks.length > 0 || warnings.length > 0) {
        verdict = "BLOCK";
        flags.push(`security_scan_flagged_risk_items: ${risks.length}`);
        summaryChecks.payloadRisk = "flagged";
      } else if (revertReason) {
        verdict = "BLOCK";
        flags.push(`simulation_would_revert: ${revertReason}`);
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "would_revert";
      } else if (scanCheck.error) {
        flags.push(`tx_scan_cli_error: ${scanCheck.error}`);
      } else {
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "stable";
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
    // Full detail stays server-side only — never sent to the caller.
    console.log(`[Internal Failure] ${err.message}`);
    console.log(`[Internal Failure] Stack: ${err.stack}`);
    return res.status(500).json({ error: "internal_system_error" });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "endpoint_not_found" });
});

app.listen(PORT, async () => {
  console.log(`[Counterparty Check] Server active on port ${PORT}`);
  await runBootDiagnostics();
});