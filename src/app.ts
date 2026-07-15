import express from "express";
import type { Request, Response } from "express";
import * as dotenv from "dotenv";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { Mppx } from "@okxweb3/mpp";
import { charge } from "@okxweb3/mpp/evm/server";
import { SaApiClient } from "@okxweb3/mpp/evm";
import { extractJsonFromStdout } from "./utils.js";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import url from "url";
import fs from "fs";
import path from "path";
import os from "os";

dotenv.config();
const execAsync = promisify(exec);
const app = express();
app.use(express.json());

// Explicitly parse the port configuration to guarantee a strict number assignment
const PORT = Number(process.env.PORT) || 4000;
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; 

// WebSocket client mappings (WS instance -> clientId)
const wsClients = new Map<WebSocket, string>();

const originalConsoleLog = console.log;

// Intercept console logging to stream clean execution loops natively to remote observers
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
  console.log(`[HEARTBEAT] Loop initialized. Interval: ${HEARTBEAT_INTERVAL_MS / 1000}s.`);
}

async function runBootDiagnostics() {
  console.log("\n=== SERVER SPIN-UP BOOT DIAGNOSTICS ===");
  await runDiagnosedCommand("BOOT: version", "onchainos --version");
  await runDiagnosedCommand("BOOT: wallet-status", "onchainos wallet status");
  await runDiagnosedCommand("BOOT: agent-profile-test", "onchainos agent profile 5239 --chain xlayer");
  await runDiagnosedCommand("BOOT: home-config-check", "ls -la ~/.onchainos 2>&1 || echo '~/.onchainos DOES NOT EXIST'");
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

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/debug/cli-status", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) {
    return res.status(404).json({ error: "endpoint_not_found" });
  }

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

app.post("/api/v1/verify", async (req: Request, res: Response) => {
  console.log(`\n================== [INCOMING AUDIT REQUEST] ==================`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Parameters Received: ${JSON.stringify(req.body, null, 2)}`);

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

  const { targetAgentId, expectedServiceName, expectedServiceType, transactionPayload } = req.body as VerifyBody;
  if (!targetAgentId) {
    console.log("[INPUT VALIDATION ERROR]: Parameter targetAgentId is missing. Dropping request.");
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

    console.log(`\n--- [Layer 2: Identity Registry Scan for ID ${targetAgentId}] ---`);
    const profileCheck = await runDiagnosedCommand("Layer 2", `onchainos agent profile ${targetAgentId} --chain xlayer`);
    const profileResult = profileCheck.parsed;
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

    if (verdict !== "BLOCK") {
      console.log(`\n--- [Layer 3: Cryptographic Reputation Scan for ID ${targetAgentId}] ---`);
      const feedbackCheck = await runDiagnosedCommand("Layer 3", `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20 --chain xlayer`);
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

    if (verdict !== "BLOCK") {
      console.log(`\n--- [Layer 4: Commercial Capabilities Alignment Check] ---`);
      const serviceCheck = await runDiagnosedCommand("Layer 4", `onchainos agent service-list --agent-id ${targetAgentId} --chain xlayer`);
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

    if (transactionPayload && verdict !== "BLOCK") {
      console.log(`\n--- [Layer 5: Sandboxed Transaction Safety Simulation] ---`);
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";

      const scanCheck = await runDiagnosedCommand("Layer 5", `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain xlayer`);
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
    }

    const businessData = {
      verdict,
      targetAgentId,
      checks: summaryChecks,
      flags,
      timestamp: new Date().toISOString(),
    };

    console.log(`\n================== [EVALUATION FINALIZED] ==================`);
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

app.use((req, res) => {
  res.status(404).json({ error: "endpoint_not_found" });
});

// Setup server and bind WebSocket Server
const serverInstance = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

serverInstance.on("upgrade", (request, socket, head) => {
  const parsedUrl = url.parse(request.url || "", true);
  if (parsedUrl.pathname === "/api/v1/logs") {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const clientId = String(parsedUrl.query.clientId || "");
      wss.emit("connection", ws, request, clientId);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, clientId: string) => {
  wsClients.set(ws, clientId);
  ws.send(`[SYSTEM] Linked to SLA-Warden Process Log Streamer.`);
  ws.on("close", () => wsClients.delete(ws));
});

// Pass the strictly typed number variable to eliminate server prototype overloads
serverInstance.listen(PORT, "0.0.0.0", async () => {
  console.log(`[Counterparty Check] Server active on port ${PORT}`);
  
  // SESSION UNPACKING LOGIC FOR RENDER
  const onchainosDir = path.join(os.homedir(), ".onchainos");
  if (process.env.CLI_WALLET_SESSION) {
    console.log("[SYSTEM] Base64 configuration data detected. Instantiating file mapping...");
    try {
      if (!fs.existsSync(onchainosDir)) {
        fs.mkdirSync(onchainosDir, { recursive: true });
      }
      
      const tarPath = path.join(os.tmpdir(), "session.tar.gz");
      fs.writeFileSync(tarPath, Buffer.from(process.env.CLI_WALLET_SESSION, "base64"));
      
      // Unpack targeted configs directly into the context path
      execSync(`tar -xzf ${tarPath} -C ${onchainosDir}`);
      console.log("[SYSTEM] Successfully mapped minimal anonbrizzy@gmail.com environment.");
    } catch (err: any) {
      console.log(`[SYSTEM ERROR] Failed to unpack targeted configurations: ${err.message}`);
    }
  } else {
    console.log("[SYSTEM] No CLI_WALLET_SESSION variable detected. Defaulting profile targets.");
  }

  await runBootDiagnostics();
  startHeartbeatLoop();
});