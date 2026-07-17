import express from "express";
import type { Request, Response, NextFunction } from "express";
import * as dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import { Mppx } from "@okxweb3/mpp";
import { charge } from "@okxweb3/mpp/evm/server";
import { SaApiClient } from "@okxweb3/mpp/evm";
import { extractJsonFromStdout } from "./utils.js";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import url from "url";

dotenv.config();
const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 4000;
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; 
const AUTOMATION_POLL_INTERVAL_MS = 5 * 60 * 1000;

const AGENT_ID = "5239"; 
const wsClients = new Map<WebSocket, string>();
const originalConsoleLog = console.log;

function broadcastLog(message: string) {
  if (
    message.includes("BOOT:") || 
    message.includes("=== BOOT DIAGNOSTICS ===") || 
    message.includes("DEBUG:") || 
    message.includes("endpoint_not_found")
  ) {
    return;
  }
  wsClients.forEach((wsClientId, clientWs) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(message);
    }
  });
}

console.log = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  originalConsoleLog.apply(console, args);
  broadcastLog(msg);
};

async function runDiagnosedCommand(label: string, cmd: string): Promise<any> {
  console.log(`[${label}] Executing Shell Command: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stderr) console.log(`[${label}] SHELL STDERR: ${stderr}`);
    console.log(`[${label}] RAW OUTPUT:\n${stdout}`);
    const parsed = extractJsonFromStdout(stdout);
    return { stdout, stderr, parsed, error: null };
  } catch (e: any) {
    console.log(`[${label}] EXECUTION CRITICAL FAILURE: ${e.message}`);
    return { stdout: e.stdout || "", stderr: e.stderr || "", parsed: null, error: e.message };
  }
}

// ================== CREATIVE GENIUS REPORT ENGINE ==================

async function generateAuditReportCard(verdict: string, flags: string[]): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) return "Risk Discovery pass complete under localized telemetry constraints.";
  
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [
          {
            role: "system",
            content: "You are 'SLA-Warden', a sharp, direct, and slightly witty AI security oracle. Write a 2-sentence summary report card of an agent or wallet security check based on the verdict and flags provided. Be punchy."
          },
          { role: "user", content: `Verdict: ${verdict}. Telemetry Flags: ${flags.join(", ")}` }
        ]
      })
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "Audit verification complete.";
  } catch {
    return "Audit finalized under secure environment bounds.";
  }
}

async function analyzeReviewsWithAI(reviewsText: string): Promise<{ signal: string }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("[AI COGNITION] Skipping classification loop — OPENROUTER_API_KEY is missing.");
    return { signal: "neutral" };
  }

  const modelsToTry = ["meta-llama/llama-3.3-70b-instruct:free", "openrouter/free"];

  try {
    for (const model of modelsToTry) {
      console.log(`[AI COGNITION] Dispatching payload data to OpenRouter via model: ${model}`);
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
        console.log(`[AI COGNITION WARNING] Model ${model} failed with status code ${response.status}`);
        continue;
      }

      const rawContent = aiData?.choices?.[0]?.message?.content;
      console.log(`[AI COGNITION RESPONSE]: Raw answer string -> "${rawContent?.trim()}"`);
      const token = rawContent?.trim().toLowerCase() || "neutral";
      const validToken = ["positive", "negative", "neutral"].includes(token);
      return { signal: validToken ? token : "neutral" };
    }
    return { signal: "neutral" };
  } catch (err: any) {
    console.log(`[AI COGNITION CRITICAL FAILURE]: Network runtime error -> ${err.message}`);
    return { signal: "neutral" };
  }
}

// ================== SOFTWARE UTILITY COMMERCE LOOP ==================

async function fulfillActiveMarketplaceContracts() {
  console.log("[COMMERCE ENGINE] Querying assigned active task items (status: 1)...");
  
  const activeTasksResult = await runDiagnosedCommand(
    "POLL ACTIVE", 
    `onchainos agent tasks --status 1 --agent-id ${AGENT_ID} --chain xlayer`
  );

  const activeList = activeTasksResult.parsed?.data?.[0]?.list || activeTasksResult.parsed?.list || [];
  
  for (const task of activeList) {
    const jobId = task.jobId;
    if (!jobId) continue;

    const contextResult = await runDiagnosedCommand(
      "FETCH CONTEXT",
      `onchainos agent common context ${jobId} --role asp --agent-id ${AGENT_ID} --chain xlayer`
    );

    const rawParams = (contextResult.parsed?.data?.serviceParams || contextResult.parsed?.serviceParams || "").trim();
    let targetChain = task.chain || "xlayer"; // Extract chain context natively

    let verdict = "PASS";
    const flags: string[] = [];
    const summaryChecks: Record<string, any> = { identity: "unknown", reputation: { score: "-", reviewCount: 0 }, accessControl: "clear", assetTriage: "clear" };

    let parsedPayload: any = null;
    try { parsedPayload = JSON.parse(rawParams); } catch { }

    // Check if the parameter payload itself designates an alternative target chain
    if (parsedPayload && parsedPayload.chain) {
      targetChain = parsedPayload.chain;
    }

    // --- LOGIC TRACK 1: TRANSACTION & PRE-FLIGHT RISK AUDIT ---
    if (parsedPayload && parsedPayload.to && parsedPayload.data) {
      console.log(`[TRACK MATCH] Transaction Payload Sandbox for job ${jobId}`);
      const scanCheck = await runDiagnosedCommand("SANDBOX: SCAN", `onchainos security tx-scan --from 0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291 --to ${parsedPayload.to} --data ${parsedPayload.data} --value ${parsedPayload.value || "0"} --chain ${targetChain}`);
      
      const risks = scanCheck.parsed?.data?.riskItemDetail || [];
      const warnings = scanCheck.parsed?.data?.warnings || [];
      const revertReason = scanCheck.parsed?.data?.simulator?.revertReason || "";

      if (risks.length > 0 || warnings.length > 0) {
        verdict = "BLOCK";
        flags.push(`security_scan_flagged_risk_items: ${risks.length}`);
        summaryChecks.payloadRisk = "flagged";
      } else if (revertReason) {
        verdict = "BLOCK";
        flags.push(`simulation_would_revert: ${revertReason}`);
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "would_revert";
      } else {
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "stable";
      }
    } 
    // --- LOGIC TRACK 2: WALLET SANCTIONS & HEALTH TRIAGE ---
    else if (/^0x[a-fA-F0-9]{40}$/.test(rawParams)) {
      console.log(`[TRACK MATCH] Wallet Security Triage for Target: ${rawParams}`);
      const approvalScan = await runDiagnosedCommand("TRIAGE: APPROVALS", `onchainos security approvals --address ${rawParams} --chain ${targetChain}`);
      const balanceScan = await runDiagnosedCommand("TRIAGE: BALANCES", `onchainos portfolio all-balances --address ${rawParams} --chains ${targetChain}`);

      const allowances = approvalScan.parsed?.data?.[0]?.dataList || [];
      const tokenAssets = balanceScan.parsed?.data?.[0]?.tokenAssets || [];

      summaryChecks.identity = "external_wallet_space";
      summaryChecks.assetTriage = `tracked_assets: ${tokenAssets.length}`;

      const highRiskAllowances = allowances.filter((a: any) => a.riskLevel > 1);
      if (highRiskAllowances.length > 0) {
        verdict = "CAUTION";
        flags.push(`vulnerable_spending_allowances: ${highRiskAllowances.length}`);
      }
    } 
    // --- LOGIC TRACK 3: AI AGENT TRUST CHECK / KYA ---
    else if (/^\d+$/.test(rawParams) || (rawParams && rawParams.toLowerCase().includes("agent"))) {
      const targetAgentId = rawParams.replace(/\D/g, "");
      console.log(`[TRACK MATCH] Registry KYA Audit for Agent ID: ${targetAgentId}`);

      const profileLookup = await runDiagnosedCommand("KYA: PROFILE", `onchainos agent profile ${targetAgentId} --chain ${targetChain}`);
      const feedbackLookup = await runDiagnosedCommand("KYA: REPUTATION", `onchainos agent feedback-list --agent-id ${targetAgentId} --chain ${targetChain}`);

      const registrationStatus = profileLookup.parsed?.data?.statusLabel || "unregistered";
      const reviewsArray = feedbackLookup.parsed?.data?.list || [];

      summaryChecks.identity = registrationStatus;
      summaryChecks.reputation.reviewCount = reviewsArray.length;
      summaryChecks.reputation.score = feedbackLookup.parsed?.data?.totalScore || "—";

      if (registrationStatus !== "active") {
        verdict = "BLOCK";
        flags.push(`target_registry_label_is_${registrationStatus}`);
      } else if (reviewsArray.length === 0) {
        verdict = "CAUTION";
        flags.push("unproven_counterparty_zero_marketplace_reviews");
      } else {
        const reviewComments = reviewsArray
          .map((r: any) => r.content || "")
          .filter((c: string) => c.length > 0)
          .join("\n");

        if (reviewComments.length > 0) {
          const aiResult = await analyzeReviewsWithAI(reviewComments);
          summaryChecks.reputation.aiSignal = aiResult.signal;
          if (aiResult.signal === "negative") {
            verdict = "CAUTION";
            flags.push("llm_extracted_critical_reliability_concerns");
          }
        }
      }
    } else {
      verdict = "NEUTRAL";
      flags.push("unstructured_text_context");
    }

    const reportCardCommentary = await generateAuditReportCard(verdict, flags);

    const businessData = {
      verdict,
      targetJob: jobId,
      checks: summaryChecks,
      flags,
      wittyAnalysis: reportCardCommentary,
      reputationNotice: "SLA-Warden complete. If this telemetry mitigated your execution risk, please submit positive feedback using 'onchainos agent feedback-submit'."
    };

    console.log(`[COMMERCE ENGINE] Delivering finalized telemetry payload for Job ${jobId}`);
    await runDiagnosedCommand(
      "SUBMIT DELIVERY",
      `onchainos agent deliver ${jobId} --agent-id ${AGENT_ID} --deliverable-text "${JSON.stringify(businessData).replace(/"/g, '\\"')}" --chain xlayer`
    );
  }
}

async function discoverAndApplyToPublicJobs() {
  console.log("[COMMERCE ENGINE] Scanning open marketplace listings via task-search...");
  const searchResult = await runDiagnosedCommand(
    "MARKET HOVER", 
    `onchainos agent task-search --agent-id ${AGENT_ID} --status 0 --page-size 30 --chain xlayer`
  );

  const marketJobs = searchResult.parsed?.data?.tasks || searchResult.parsed?.tasks || [];
  for (const job of marketJobs) {
    const title = job.title || "";
    const jobId = job.jobId;
    const paymentMode = job.paymentMode;
    const tokenAmount = job.tokenAmount || "0";
    const tokenSymbol = job.tokenSymbol || "USDT";

    if (!jobId) continue;

    // 1. ESCROW Filtering (paymentMode 1 = ESCROW)
    if (paymentMode !== 1) {
      console.log(`[COMMERCE ENGINE] Skipping Job ${jobId} ("${title}") - Non-ESCROW payment mode (${paymentMode})`);
      continue;
    }

    const matchesNicheKeywords = 
      title.toLowerCase().includes("trust") || 
      title.toLowerCase().includes("kya") || 
      title.toLowerCase().includes("sanction") || 
      title.toLowerCase().includes("scam") || 
      title.toLowerCase().includes("audit") ||
      title.toLowerCase().includes("wallet");

    // 2. Filter by Niche & Apply with Dynamic Bidding parameters
    if (matchesNicheKeywords) {
      console.log(`[COMMERCE ENGINE] Auto-applying to ESCROW contract: "${title}" with bid: ${tokenAmount} ${tokenSymbol}`);
      await runDiagnosedCommand(
        "SUBMIT APPLICATION",
        `onchainos agent apply ${jobId} --agent-id ${AGENT_ID} --token-amount ${tokenAmount} --token-symbol ${tokenSymbol} --chain xlayer`
      );
    }
  }
}

async function runAutonomousWorkflowPass() {
  await fulfillActiveMarketplaceContracts();
  await discoverAndApplyToPublicJobs();
}

function initializeAutomationLoops() {
  runAutonomousWorkflowPass();
  setInterval(runAutonomousWorkflowPass, AUTOMATION_POLL_INTERVAL_MS);
}

// ====================================================================

async function sendHeartbeat() {
  const result = await runDiagnosedCommand("HEARTBEAT", "onchainos agent heartbeat --chain-index 196 --chain xlayer");
  if (result.error) {
    console.log(`[HEARTBEAT] STATUS: FAILED — Agent may drop to OFFLINE on OKX.AI.`);
  } else {
    console.log(`[HEARTBEAT] STATUS: SUCCESS — Reported online at ${new Date().toISOString()}`);
  }
}

function startHeartbeatLoop() {
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

async function runBootDiagnostics() {
  console.log("\n=== SERVER SPIN-UP BOOT DIAGNOSTICS ===");
  await runDiagnosedCommand("BOOT: version", "onchainos --version");
  await runDiagnosedCommand("BOOT: wallet-status", "onchainos wallet status");
  await runDiagnosedCommand("BOOT: agent-profile-test", "onchainos agent profile 5239 --chain xlayer");
  await runDiagnosedCommand("BOOT: home-config-check", "ls -la ~/.onchainos 2>&1 || echo 'MISSING'");
  console.log("=== SERVER SPIN-UP BOOT DIAGNOSTICS END ===\n");
}

const saClient = new SaApiClient({
  apiKey: process.env.OKX_API_KEY!,
  secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!,
  onError: (info) => {
    console.log(`[SA API ERROR] ${info.method} ${info.path} -> ${info.httpStatus} (${info.code}): ${info.msg}`);
  },
});

const mppx = Mppx.create({
  methods: [charge({ saClient })],
  realm: "SLA-Warden Production Oracle",
  secretKey: process.env.MPP_SECRET_KEY!,
});

const CHARGE_CONFIG = {
  amount: "0",
  currency: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  recipient: "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291",
  description: "Counterparty Check - Pre-Trust Verification",
  methodDetails: { chainId: 196, feePayer: true },
};

interface VerifyBody {
  targetAgentId?: string | null;
  expectedServiceName?: string;
  expectedServiceType?: string;
  transactionPayload?: {
    to: string;
    data?: string;
    value?: string;
    chain?: string;
  } | null;
}

// ================== REQUEST NORMALIZATION INTERACTION LAYER ==================

function smartNormalizer(body: any): VerifyBody {
  const normalized: VerifyBody = {
    targetAgentId: body.targetAgentId ? String(body.targetAgentId).trim() : null,
    expectedServiceName: body.expectedServiceName || undefined,
    expectedServiceType: body.expectedServiceType || undefined,
    transactionPayload: null,
  };

  // Extract address variants for transactionPayload mapping
  const rawTx = body.transactionPayload;
  if (rawTx) {
    const toAddress = rawTx.to || rawTx.address || rawTx.target;
    if (toAddress) {
      let rawData = "0x";
      if (rawTx.data && typeof rawTx.data === "string" && rawTx.data.trim() !== "") {
        rawData = rawTx.data.trim();
      }
      normalized.transactionPayload = {
        to: toAddress.trim(),
        data: rawData,
        value: rawTx.value ? String(rawTx.value).trim() : "0",
        chain: rawTx.chain || undefined
      };
    }
  }

  return normalized;
}

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/debug/cli-status", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) return res.status(404).json({ error: "endpoint_not_found" });
  
  const versionCheck = await runDiagnosedCommand("DEBUG: version", "onchainos --version");
  const walletCheck = await runDiagnosedCommand("DEBUG: wallet-status", "onchainos wallet status");
  const profileCheck = await runDiagnosedCommand("DEBUG: agent-profile-test", "onchainos agent profile 5239 --chain xlayer");
  const homeCheck = await runDiagnosedCommand("DEBUG: home-config", "ls -la ~/.onchainos 2>&1 || echo 'MISSING'");
  const heartbeatCheck = await runDiagnosedCommand("DEBUG: heartbeat-test", "onchainos agent heartbeat --chain-index 196 --chain xlayer");

  return res.json({
    binaryPresent: !versionCheck.error,
    versionOutput: versionCheck.stdout || versionCheck.error,
    walletStatus: walletCheck.parsed || walletCheck.error,
    sampleAgentLookup: profileCheck.parsed || profileCheck.error,
    homeConfigDir: homeCheck.stdout || homeCheck.error,
    heartbeat: heartbeatCheck.parsed || heartbeatCheck.error,
  });
});

app.post("/debug/login-start", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) return res.status(404).json({ error: "endpoint_not_found" });
  const result = await runDiagnosedCommand("BRIDGE LOGIN", "onchainos wallet login anonbrizzy@gmail.com --force");
  return res.json({ message: "Login initialization triggered successfully.", cliOutput: result.parsed || result.stdout });
});

app.post("/debug/login-submit", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  const { otp } = req.body;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) return res.status(404).json({ error: "endpoint_not_found" });
  if (!otp) return res.status(400).json({ error: "Missing parameter: otp" });

  const verifyResult = await runDiagnosedCommand("BRIDGE VERIFY", `onchainos wallet verify ${otp}`);
  try {
    await runDiagnosedCommand("BRIDGE ACTIVATE", "onchainos agent activate --agent-id 5239 --preferred-language en-US");
  } catch (actErr: any) {
    console.log(`[BRIDGE WARNING] Activation routing deferred: ${actErr.message}`);
  }
  const statusCheck = await runDiagnosedCommand("BRIDGE STATUS", "onchainos wallet status");
  return res.json({ verification: verifyResult.parsed || verifyResult.stdout, currentWalletStatus: statusCheck.parsed || statusCheck.stdout });
});

app.post("/api/v1/verify", async (req: Request, res: Response) => {
  console.log(`\n================== [INCOMING API AUDIT REQUEST] ==================`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Parameters Received: ${JSON.stringify(req.body, null, 2)}`);

  // Execute request normalization
  const normalizedBody = smartNormalizer(req.body);
  console.log(`Normalized Parameters: ${JSON.stringify(normalizedBody, null, 2)}`);

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
    console.log("[Layer 1 STATUS]: Payment missing or invalid. Issuing HTTP 402 Challenge header back to caller.");
    return res.status(402)
      .set("WWW-Authenticate", result.challenge.headers.get("WWW-Authenticate")!)
      .json();
  }
  console.log("[Layer 1 Verified] Cryptographic payment cleared.");

  const { targetAgentId, expectedServiceName, expectedServiceType, transactionPayload } = normalizedBody;

  // Enforce loose boundary validation: Must provide at least one of targetAgentId OR transactionPayload
  if (!targetAgentId && !transactionPayload) {
    console.log("[INPUT VALIDATION ERROR]: Both targetAgentId and transactionPayload are empty. Dropping request.");
    return res.status(400).json({ error: "missing_parameter: You must provide either targetAgentId or transactionPayload" });
  }

  try {
    let verdict = "PASS";
    const flags: string[] = [];
    const summaryChecks: Record<string, any> = {
      identity: "skipped",
      reputation: { score: "-", reviewCount: 0, aiSignal: "neutral" },
      serviceMatch: "skipped",
      payloadRisk: "skipped"
    };

    const targetChain = transactionPayload?.chain || "xlayer";
    let profileResult: any = null;

    // --- SERVICE LAYER 2: IDENTITY REGISTRY SCAN (KYA) ---
    if (targetAgentId) {
      console.log(`\n--- [Layer 2: Identity Registry Scan for ID ${targetAgentId}] ---`);
      const profileCheck = await runDiagnosedCommand("Layer 2", `onchainos agent profile ${targetAgentId} --chain ${targetChain}`);
      profileResult = profileCheck.parsed;
      console.log(`[Layer 2 PARSED JSON]: ${JSON.stringify(profileResult, null, 2)}`);

      if (!profileResult || !profileResult.ok || !profileResult.data) {
        verdict = "BLOCK";
        flags.push(profileCheck.error ? `cli_execution_failed: ${profileCheck.error}` : "target_agent_id_not_found_in_registry");
        summaryChecks.identity = "unregistered_or_cli_error";
      } else {
        const statusLabel = profileResult.data.statusLabel ?? "unknown";
        console.log(`[Layer 2 Verification] Target Registration Status Flag -> "${statusLabel}"`);
        if (statusLabel === "active") {
          summaryChecks.identity = "registered";
        } else {
          verdict = "BLOCK";
          flags.push(`agent_registry_status_not_active_${statusLabel}`);
          summaryChecks.identity = statusLabel;
        }
      }

      // --- SERVICE LAYER 3: CRYPTOGRAPHIC REPUTATION SCAN ---
      if (verdict !== "BLOCK") {
        console.log(`\n--- [Layer 3: Cryptographic Reputation Scan for ID ${targetAgentId}] ---`);
        const feedbackCheck = await runDiagnosedCommand("Layer 3", `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20 --chain ${targetChain}`);
        const feedbackResult = feedbackCheck.parsed;
        console.log(`[Layer 3 PARSED JSON]: ${JSON.stringify(feedbackResult, null, 2)}`);

        if (feedbackResult && feedbackResult.ok && feedbackResult.data) {
          const totalCount = feedbackResult.data.totalCount || 0;
          summaryChecks.reputation.reviewCount = totalCount;
          summaryChecks.reputation.score = feedbackResult.data.totalScore || "-";

          if (totalCount === 0) {
            console.log("[Layer 3 Evaluation] Target agent has 0 historical reviews. Adjusting status to CAUTION.");
            if (verdict !== "BLOCK") verdict = "CAUTION";
            flags.push("unproven_agent_zero_reviews");
          } else {
            const reviewComments = (feedbackResult.data.list || [])
              .map((r: any) => r.content || "")
              .filter((c: string) => c.length > 0)
              .join("\n");

            console.log(`[Layer 3 Evaluation] Extracted Review Texts:\n"""\n${reviewComments}\n"""`);

            if (reviewComments.length > 0) {
              const aiResult = await analyzeReviewsWithAI(reviewComments);
              summaryChecks.reputation.aiSignal = aiResult.signal;
              console.log(`[Layer 3 Evaluation] Semantic Sentiment Verdict -> [${aiResult.signal.toUpperCase()}]`);
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

      // --- SERVICE LAYER 4: SERVICE CAPABILITIES ALIGNMENT CHECK ---
      if (verdict !== "BLOCK") {
        console.log(`\n--- [Layer 4: Commercial Capabilities Alignment Check] ---`);
        const serviceCheck = await runDiagnosedCommand("Layer 4", `onchainos agent service-list --agent-id ${targetAgentId} --chain ${targetChain}`);
        const serviceResult = serviceCheck.parsed;
        console.log(`[Layer 4 PARSED JSON]: ${JSON.stringify(serviceResult, null, 2)}`);
        
        const registeredServices = serviceResult?.ok && Array.isArray(serviceResult?.data) && serviceResult.data[0]?.list
          ? serviceResult.data[0].list
          : [];

        if (registeredServices.length === 0) {
          if (verdict !== "BLOCK") verdict = "CAUTION";
          flags.push(serviceCheck.error ? `service_list_cli_error: ${serviceCheck.error}` : "zero_registered_commercial_services_found");
          summaryChecks.serviceMatch = "no_services_found";
        } else if (expectedServiceName || expectedServiceType) {
          console.log(`[Layer 4 Alignment] Filtering for Name match: "${expectedServiceName}" | Type match: "${expectedServiceType}"`);
          const matchFound = registeredServices.some((svc: any) => {
            const nameMatch = expectedServiceName ? svc.serviceName?.toLowerCase() === expectedServiceName.toLowerCase() : true;
            const typeMatch = expectedServiceType ? svc.serviceType?.toLowerCase() === expectedServiceType.toLowerCase() : true;
            return nameMatch && typeMatch;
          });
          if (matchFound) {
            console.log("[Layer 4 Alignment] Capability alignment verified successfully.");
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
    }

    // --- SERVICE LAYER 5: TRANSACTION SAFETY SIMULATION / TRIAGE ---
    if (transactionPayload && verdict !== "BLOCK") {
      const { to, data, value } = transactionPayload;
      
      // Determine sender context
      const simFrom = profileResult?.data?.agentWalletAddress || "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291";

      if (data && data !== "0x") {
        // Run full Tx Pre-Flight Simulation
        console.log(`\n--- [Layer 5: Sandboxed Transaction Safety Simulation] ---`);
        const scanCheck = await runDiagnosedCommand("Layer 5 Simulation", `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain ${targetChain}`);
        const scanResult = scanCheck.parsed;
        console.log(`[Layer 5 PARSED JSON]: ${JSON.stringify(scanResult, null, 2)}`);
        
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
      } else {
        // Run Wallet Security Triage instead
        console.log(`\n--- [Layer 5: Wallet Security Triage for Address ${to}] ---`);
        const triageCheck = await runDiagnosedCommand("Layer 5 Triage", `onchainos security approvals --address ${to} --chain ${targetChain}`);
        const triageResult = triageCheck.parsed;
        console.log(`[Layer 5 PARSED JSON]: ${JSON.stringify(triageResult, null, 2)}`);

        const allowances = triageResult?.data?.[0]?.dataList || [];
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "skipped (no calldata)";

        const highRiskAllowances = allowances.filter((a: any) => a.riskLevel > 1);
        if (highRiskAllowances.length > 0) {
          verdict = "CAUTION";
          flags.push(`vulnerable_spending_allowances: ${highRiskAllowances.length}`);
        }
      }
    }

    const reportCardCommentary = await generateAuditReportCard(verdict, flags);

    const businessData = {
      verdict,
      targetAgentId: targetAgentId || null,
      checks: summaryChecks,
      flags,
      wittyAnalysis: reportCardCommentary,
      timestamp: new Date().toISOString(),
    };

    console.log(`\n================== [API EVALUATION FINALIZED] ==================`);
    console.log(`Final Response Payload -> ${JSON.stringify(businessData, null, 2)}`);
    console.log(`============================================================\n`);

    const webResponse = new globalThis.Response(JSON.stringify(businessData), { status: 200 });
    const finalizedResponse = result.withReceipt(webResponse);
    finalizedResponse.headers.forEach((v, k) => res.setHeader(k, v));
    return res.json(businessData);
  } catch (err: any) {
    console.log(`[CRITICAL AUDIT INTERCLUSION FAILURE]: ${err.message}`);
    return res.status(500).json({ error: "internal_system_error" });
  }
});

app.use((req, res) => { res.status(404).json({ error: "endpoint_not_found" }); });
const serverInstance = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

serverInstance.on("upgrade", (request, socket, head) => {
  const parsedUrl = url.parse(request.url || "", true);
  if (parsedUrl.pathname === "/api/v1/logs") {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const clientId = String(parsedUrl.query.clientId || "");
      wss.emit("connection", ws, request, clientId);
    });
  } else { socket.destroy(); }
});

wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, clientId: string) => {
  wsClients.set(ws, clientId);
  ws.send(`[SYSTEM] Linked to SLA-Warden Process Log Streamer.`);
  ws.on("close", () => wsClients.delete(ws));
});

serverInstance.listen(PORT, "0.0.0.0", async () => {
  console.log(`[Counterparty Check] Server active on port ${PORT}`);
  await runBootDiagnostics();
  startHeartbeatLoop();
  initializeAutomationLoops();
});