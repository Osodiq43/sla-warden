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

const saClient = new SaApiClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
});

const mppx = Mppx.create({
  methods: [charge({ saClient })],
  realm: "SLA-Warden Production Oracle",
  secretKey: process.env.MPP_SECRET_KEY!,
});

const CHARGE_CONFIG = {
  amount: "10000", 
  currency: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c", 
  recipient: "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291", 
  description: "SLA-Warden Comprehensive Compliance Evaluation",
  methodDetails: { chainId: 1952, feePayer: true },
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

// Helper to interact with OpenRouter for Layer 3 sentiment analysis
async function analyzeReviewsWithAI(reviewsText: string): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("   ↳ [AI Warning] OPENROUTER_API_KEY missing, defaulting sentiment to neutral.");
    return "neutral";
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3-8b-instruct:free",
        messages: [
          {
            role: "system",
            content: "You are a risk audit intelligence module. Analyze the following text reviews for an AI agent. Classify the cumulative user sentiment/reliability experience into exactly one of these tokens: positive, negative, or neutral. Return only the token word."
          },
          {
            role: "user",
            content: reviewsText
          }
        ]
      })
    });

    const aiData = await response.json();
    const token = aiData?.choices?.[0]?.message?.content?.trim().toLowerCase() || "neutral";
    return ["positive", "negative", "neutral"].includes(token) ? token : "neutral";
  } catch (err) {
    console.log("   ↳ [AI Error] OpenRouter connection timed out or failed.");
    return "neutral";
  }
}

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.post("/api/v1/verify", async (req: Request, res: Response) => {
  console.log(`\n--- [INCOMING REQUEST] ${new Date().toISOString()} ---`);
  console.log(`Target Agent ID: ${req.body?.targetAgentId || "None"}`);

  const protocol = req.secure ? "https" : "http";
  const fullUrl = `${protocol}://${req.headers.host}${req.url}`;
  const webHeaders = new Headers();
  Object.entries(req.headers).forEach(([k, v]) => {
    if (v) webHeaders.append(k, Array.isArray(v) ? v.join(", ") : v);
  });

  const webRequest = new globalThis.Request(fullUrl, {
    method: req.method,
    headers: webHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
  });

  console.log("[Layer 1] Validating OKX MPP Protocol payment gates...");
  const result = await mppx.charge(CHARGE_CONFIG)(webRequest);
  
  if (result.status === 402) {
    console.log("[Layer 1 Blocked] Payment token challenge required (402).");
    return res.status(402)
      .set("WWW-Authenticate", result.challenge.headers.get("WWW-Authenticate")!)
      .json();
  }
  console.log("[Layer 1 Verified] On-chain monetization checks cleared.");

  const { targetAgentId, expectedServiceName, expectedServiceType, transactionPayload } = req.body as VerifyBody;
  if (!targetAgentId) {
    console.log("[Request Rejected] Missing mandatory targetAgentId parameter.");
    return res.status(400).json({ error: "missing_parameter: targetAgentId" });
  }

  try {
    let verdict = "PASS";
    const flags: string[] = [];
    const summaryChecks = {
      identity: "unknown",
      reputation: { score: "—", reviewCount: 0, aiSignal: "neutral" },
      serviceMatch: "skipped",
      payloadRisk: "clear"
    };

    // --- LAYER 2: IDENTITY & REGISTRATION AUDIT ---
    console.log(`[Layer 2] Auditing marketplace profile identity for agent: ${targetAgentId}`);
    const profileCmd = `onchainos agent profile ${targetAgentId} --chain 196`;
    const profileRaw = await execAsync(profileCmd).catch((e) => e);
    const profileResult = profileRaw?.stdout ? extractJsonFromStdout(profileRaw.stdout) : null;

    if (!profileResult || !profileResult.ok || !profileResult.data) {
      verdict = "BLOCK";
      flags.push("target_agent_id_not_found_in_registry");
      summaryChecks.identity = "unregistered";
      console.log("   ↳ BLOCK added: Identity unregistered or invalid on network.");
    } else {
      const statusStr = profileResult.data.statusLabel || "";
      const statusInt = profileResult.data.status;
      if (statusInt === 1 || statusStr.toLowerCase() === "active") {
        summaryChecks.identity = "registered";
        console.log(`   ↳ Active registry profile found: ${profileResult.data.name || "Unnamed"}`);
      } else {
        verdict = "BLOCK";
        flags.push("agent_registry_status_suspended_or_inactive");
        summaryChecks.identity = "inactive";
        console.log(`   ↳ BLOCK added: Profile is listed but status is inactive/suspended (${statusStr}).`);
      }
    }

    // --- LAYER 3: REPUTATION & AI SENTIMENT ANALYSIS ---
    if (verdict !== "BLOCK") {
      console.log(`[Layer 3] Auditing public feedback track record for agent: ${targetAgentId}`);
      const feedbackCmd = `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20`;
      const feedbackRaw = await execAsync(feedbackCmd).catch((e) => e);
      const feedbackResult = feedbackRaw?.stdout ? extractJsonFromStdout(feedbackRaw.stdout) : null;

      if (feedbackResult && feedbackResult.ok && feedbackResult.data) {
        const totalCount = feedbackResult.data.totalCount || 0;
        const totalScore = feedbackResult.data.totalScore || "—";
        summaryChecks.reputation.reviewCount = totalCount;
        summaryChecks.reputation.score = totalScore;

        if (totalCount === 0) {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("unproven_agent_zero_reviews");
          console.log("   ↳ CAUTION added: Unproven agent asset profile with zero history.");
        } else {
          // Compile comments to pass through the hybrid AI sentiment parser
          const reviewComments = (feedbackResult.data.list || [])
            .map((r: any) => r.content || "")
            .filter((c: string) => c.length > 0)
            .join("\n");

          if (reviewComments.length > 0) {
            console.log("   ↳ Invoking hybrid AI layer to parse review narrative logs...");
            const aiSignal = await analyzeReviewsWithAI(reviewComments);
            summaryChecks.reputation.aiSignal = aiSignal;
            
            if (aiSignal === "negative") {
              if (verdict !== "BLOCK") verdict = "CAUTION";
              flags.push("llm_extracted_critical_reliability_concerns");
              console.log("   ↳ CAUTION added: AI flagged underlying performance risks in feedback text.");
            } else {
              console.log(`   ↳ AI review narrative classification complete: [${aiSignal.toUpperCase()}]`);
            }
          }
        }
      }
    }

    // --- LAYER 4: CLAIMED VS REGISTERED SERVICE MATCH ---
    if (verdict !== "BLOCK") {
      console.log(`[Layer 4] Auditing capability alignment metrics via service registry...`);
      const serviceCmd = `onchainos agent service-list --agent-id ${targetAgentId}`;
      const serviceRaw = await execAsync(serviceCmd).catch((e) => e);
      const serviceResult = serviceRaw?.stdout ? extractJsonFromStdout(serviceRaw.stdout) : null;

      const registeredServices = serviceResult?.ok && serviceResult?.data?.[0]?.list 
        ? serviceResult.data[0].list 
        : [];

      if (registeredServices.length === 0) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push("zero_registered_commercial_services_found");
        summaryChecks.serviceMatch = "no_services_found";
        console.log("   ↳ CAUTION added: Target agent is online but has zero capabilities bound on-chain.");
      } else if (expectedServiceName || expectedServiceType) {
        summaryChecks.serviceMatch = "mismatch_detected";
        const matchFound = registeredServices.some((svc: any) => {
          const nameMatch = expectedServiceName ? svc.serviceName?.toLowerCase() === expectedServiceName.toLowerCase() : true;
          const typeMatch = expectedServiceType ? svc.serviceType?.toLowerCase() === expectedServiceType.toLowerCase() : true;
          return nameMatch && typeMatch;
        });

        if (matchFound) {
          summaryChecks.serviceMatch = "matched";
          console.log("   ↳ Capability alignment verified successfully.");
        } else {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push("claimed_service_profile_mismatch");
          console.log("   ↳ CAUTION added: Discovered service profile mismatch against marketing intent.");
        }
      } else {
        summaryChecks.serviceMatch = "unspecified";
      }
    }

    // --- LAYER 5: PAYLOAD & CONTRACT EXECUTION RISK SCAN ---
    if (transactionPayload && verdict !== "BLOCK") {
      console.log("[Layer 5] Executing two-stage transaction safety check...");
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";

      // Stage 5A: Low-cost static scan filter
      console.log("   ↳ Stage A: Initializing static risk assessment matrix...");
      const scanCmd = `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain 196`;
      const scanRaw = await execAsync(scanCmd).catch((e) => e);
      const scanResult = scanRaw?.stdout ? extractJsonFromStdout(scanRaw.stdout) : null;

      const risks = scanResult?.data?.riskItemDetail || [];
      const warnings = scanResult?.data?.warnings || [];

      if (risks.length > 0 || warnings.length > 0) {
        verdict = "BLOCK";
        flags.push(`malicious_transaction_parameters_intercepted: ${risks.length} threats`);
        summaryChecks.payloadRisk = "static_threat_detected";
        console.log(`   ↳ BLOCK added: Malicious signature elements or addresses flagged inside risk matrix.`);
      } else {
        // Stage 5B: Full sandbox EVM execution simulation
        console.log("   ↳ Stage B: Executing sandbox execution simulation...");
        const simCmd = `onchainos gateway simulate --from ${simFrom} --to ${to} --data ${data} --amount ${value} --chain 196`;
        const simRaw = await execAsync(simCmd).catch((e) => e);
        const simResult = simRaw?.stdout ? extractJsonFromStdout(simRaw.stdout) : null;

        const revertReason = simResult?.data?.simulator?.revertReason;

        if (revertReason && revertReason.length > 0) {
          verdict = "BLOCK";
          flags.push(`simulation_reverted: ${revertReason}`);
          summaryChecks.payloadRisk = "execution_reverted";
          console.log(`   ↳ BLOCK added: Dry-run simulation crashed on-chain. Reason: ${revertReason}`);
        } else {
          summaryChecks.payloadRisk = "clear";
          console.log("   ↳ Trace dry-run successful. Bytecode execution metrics stable.");
        }
      }
    }

    const businessData = {
      verdict,
      targetAgentId,
      checks: summaryChecks,
      flags,
      timestamp: new Date().toISOString(),
    };

    console.log(`[Evaluation Finalized] Result: [${verdict}] with ${flags.length} warning flag(s).\n`);

    const webResponse = new globalThis.Response(JSON.stringify(businessData), { status: 200 });
    const finalizedResponse = result.withReceipt(webResponse);

    finalizedResponse.headers.forEach((v, k) => res.setHeader(k, v));
    return res.json(businessData);
  } catch (err: any) {
    console.log(`[Internal Failure] Application error: ${err.message}`);
    return res.status(500).json({ error: "internal_system_error", message: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "endpoint_not_found" });
});

app.listen(PORT, () => {
  console.log(`[SLA-Warden] Standard MPP Hybrid AI Server active on port ${PORT}`);
});