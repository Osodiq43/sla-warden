import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { extractJsonFromStdout } from "./utils.js";
import { AsyncLocalStorage } from "async_hooks";
import url from "url";

dotenv.config();
const execAsync = promisify(exec);

const logLocalStorage = new AsyncLocalStorage<{ sessionId: string }>();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = Number(process.env.PORT) || 8080;

const activeTransports = new Map<string, SSEServerTransport>();
const activeServers = new Map<string, Server>();
const sessionClientIdentifiers = new Map<string, string>(); 
const sessionPaths = new Map<string, string>(); 
const wsClients = new Map<WebSocket, string>();

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  , 2);
}

function broadcastLog(message: string) {
  if (
    message.includes("BOOT:") || 
    message.includes("=== BOOT DIAGNOSTICS ===") || 
    message.includes("DEBUG:") || 
    message.includes("endpoint_not_found")
  ) {
    return;
  }

  const store = logLocalStorage.getStore();
  if (store) {
    const activeSessionId = store.sessionId;
    const targetClientId = sessionClientIdentifiers.get(activeSessionId);
    
    if (targetClientId) {
      wsClients.forEach((wsClientId, clientWs) => {
        if (wsClientId === targetClientId && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(message);
        }
      });
    }
  } else {
    wsClients.forEach((wsClientId, clientWs) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(message);
      }
    });
  }
}

console.log = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? safeJsonStringify(arg) : String(arg)).join(' ');
  originalConsoleLog.apply(console, args);
  broadcastLog(msg);
};

console.error = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? safeJsonStringify(arg) : String(arg)).join(' ');
  originalConsoleError.apply(console, args);
  broadcastLog(msg);
};

async function runDiagnosedCommand(label: string, cmd: string): Promise<any> {
  console.log(`[${label}] Executing Shell Command: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      env: {
        ...process.env,
        ONCHAINOS_API_KEY: process.env.OKX_API_KEY,
        ONCHAINOS_SECRET_KEY: process.env.OKX_SECRET_KEY,
        ONCHAINOS_PASSPHRASE: process.env.OKX_PASSPHRASE
      }
    });
    if (stderr) console.log(`[${label}] SHELL STDERR: ${stderr}`);
    console.log(`[${label}] RAW OUTPUT:\n${stdout}`);
    const parsed = extractJsonFromStdout(stdout);
    return { stdout, stderr, parsed, error: null };
  } catch (e: any) {
    console.log(`[${label}] EXECUTION CRITICAL FAILURE: ${e.message}`);
    return { stdout: e.stdout || "", stderr: e.stderr || "", parsed: null, error: e.message };
  }
}

// ================== X402 PROTOCOL GATEWAY SERVER ==================

const NETWORK = "eip155:196"; 
const PAY_TO = process.env.PAY_TO_ADDRESS || "0xeded37a75f0e0fcfb2f9c84dbbc6c98bf4dc8291";

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_SECRET_KEY || "",
  passphrase: process.env.OKX_PASSPHRASE || "",
});

const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(NETWORK, new ExactEvmScheme()); 

app.use((req, res, next) => {
  const rawSig = req.headers["payment-signature"] || req.headers["Payment-Signature"] || req.headers["payment_signature"];
  if (rawSig && !req.headers["authorization"]) {
    req.headers["authorization"] = String(rawSig).startsWith("Exact ") ? String(rawSig) : `Exact ${rawSig}`;
  }
  next();
});

if (process.env.BYPASS_PAYMENT !== "true") {
  app.use(
    paymentMiddleware(
      {
        "GET /mcp/kya": {
          accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0" }],
          description: "AI Agent Trust Check (KYA) Zero Fee standard service gate",
          mimeType: "application/json",
        },
        "GET /mcp/triage": {
          accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0" }],
          description: "Wallet Security Triage Zero Fee standard service gate",
          mimeType: "application/json",
        },
        "GET /mcp/simulation": {
          accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: "$0" }],
          description: "Tx Pre-Flight Simulation Zero Fee standard service gate",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );
}

// ================== CREATIVE GENIUS REPORT ENGINE ==================

async function callOpenRouter(systemPrompt: string, userContent: string): Promise<string | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
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
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      })
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err: any) {
    console.log(`[AI LLM CALL ERROR]: ${err.message}`);
    return null;
  }
}

async function generateAuditReportCard(verdict: string, flags: string[]): Promise<string> {
  const systemPrompt = "You are 'SLA-Warden', a sharp, direct, and slightly witty AI security oracle. Write a 2-sentence summary report card of an agent or wallet security check based on the verdict and flags provided. Be punchy.";
  const userContent = `Verdict: ${verdict}. Telemetry Flags: ${flags.join(", ")}`;
  const summary = await callOpenRouter(systemPrompt, userContent);
  return summary || "Audit finalized under secure environment bounds.";
}

async function analyzeReviewsWithAI(reviewsText: string): Promise<{ signal: string }> {
  const systemPrompt = "You are a risk audit intelligence module. Analyze the following text reviews for an AI agent. Classify the cumulative user sentiment/reliability experience into exactly one of these tokens: positive, negative, or neutral. Return only the token word.";
  const token = await callOpenRouter(systemPrompt, reviewsText);
  const cleanToken = token?.toLowerCase() || "neutral";
  const validToken = ["positive", "negative", "neutral"].includes(cleanToken);
  return { signal: validToken ? cleanToken : "neutral" };
}

async function generateSimulationExplanationWithAI(revertReason: string, risks: any[], warnings: any[]): Promise<string> {
  const systemPrompt = 
    "You are a smart contract security analysis tool. Explain this EVM transaction simulation output in simple, direct English. " +
    "Translate raw errors like 'ERC20: transfer amount exceeds balance' or security warnings into clear, professional instructions " +
    "on what went wrong and how the user can fix it. Keep it under 3 sentences.";
  const userContent = safeJsonStringify({ revertReason, risks, warnings });
  const explanation = await callOpenRouter(systemPrompt, userContent);
  return explanation || "Transaction simulation failed. Review your token balances and smart contract parameters before executing.";
}

async function generateTriageAuditWithAI(allowances: any[]): Promise<string> {
  const systemPrompt = 
    "You are a decentralized wallet audit system. Review this wallet's token allowances and spending risk metrics. " +
    "Provide a direct 2-sentence professional breakdown of any critical exposures or high spending risk parameters that could put funds at risk.";
  const userContent = safeJsonStringify({ allowances });
  const triageSummary = await callOpenRouter(systemPrompt, userContent);
  return triageSummary || "Triage completed. No immediate high-risk token exposures detected.";
}

// ================== CORE TELEMETRY AUDIT ENGINE ==================

async function performCoreTelemetryAudit(targetAgentId: string | null, transactionPayload: any) {
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
  let customAiSummary = "";

  if (targetAgentId) {
    const profileCheck = await runDiagnosedCommand("Identity Scan", `onchainos agent profile ${targetAgentId} --chain ${targetChain}`);
    profileResult = profileCheck.parsed;

    if (!profileResult || !profileResult.ok || !profileResult.data) {
      verdict = "BLOCK";
      flags.push("target_agent_id_not_found_in_registry");
      summaryChecks.identity = "unregistered";
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
      const feedbackCheck = await runDiagnosedCommand("Reputation Scan", `onchainos agent feedback-list --agent-id ${targetAgentId} --page-size 20 --chain ${targetChain}`);
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
            if (aiResult.signal === "negative") {
              if (verdict !== "BLOCK") verdict = "CAUTION";
              flags.push("llm_extracted_critical_reliability_concerns");
            }
          }
        }
      }
    }
  }

  if (transactionPayload && verdict !== "BLOCK") {
    const { to, data, value } = transactionPayload;
    const simFrom = profileResult?.data?.agentWalletAddress || PAY_TO;

    if (data && data !== "0x") {
      const valArg = (value && String(value) !== "undefined" && String(value).trim() !== "") 
        ? `--value ${value}` 
        : "";
      
      const cleanCmd = `onchainos security tx-scan --from ${simFrom} --to ${to} --data ${data} ${valArg} --chain ${targetChain}`.replace(/\s+/g, ' ').trim();
      
      const scanCheck = await runDiagnosedCommand("Tx Sandbox", cleanCmd);
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
      } else {
        summaryChecks.payloadRisk = "clear";
        summaryChecks.simulation = "stable";
      }

      // Execute Simulation-focused AI analysis
      customAiSummary = await generateSimulationExplanationWithAI(revertReason, risks, warnings);
    } else {
      const triageCheck = await runDiagnosedCommand("Wallet Approvals", `onchainos security approvals --address ${to} --chain ${targetChain}`);
      const triageResult = triageCheck.parsed;

      const allowances = triageResult?.data?.[0]?.dataList || [];
      summaryChecks.payloadRisk = "clear";
      summaryChecks.simulation = "skipped (no calldata)";

      const highRiskAllowances = allowances.filter((a: any) => a.riskLevel > 1);
      if (highRiskAllowances.length > 0) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push(`vulnerable_spending_allowances: ${highRiskAllowances.length}`);
      }

      // Execute Triage-focused AI analysis
      customAiSummary = await generateTriageAuditWithAI(allowances);
    }
  }

  // Generate the main witty oracle commentary block
  const reportCardCommentary = await generateAuditReportCard(verdict, flags);

  return {
    verdict,
    targetAgentId: targetAgentId || null,
    checks: summaryChecks,
    flags,
    wittyAnalysis: reportCardCommentary,
    aiSummary: customAiSummary || undefined,
    timestamp: new Date().toISOString(),
  };
}

// ================== DYNAMIC MCP SERVER BUILDERS ==================

function buildKyaMcpServer(sessionId: string): Server {
  const server = new Server({ name: "sla-warden-kya", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "AI Agent Trust Check (KYA)",
      description: "Automated zero-trust agent registry, reputation audit, and KYA risk check.",
      inputSchema: {
        type: "object",
        properties: { targetAgentId: { type: "string", description: "The registered on-chain platform agent numeric identifier to audit." } },
        required: ["targetAgentId"]
      }
    }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "AI Agent Trust Check (KYA)") throw new Error("Tool mismatch.");
    return logLocalStorage.run({ sessionId }, async () => {
      const args = z.object({ targetAgentId: z.string() }).parse(request.params.arguments);
      console.log(`[KYA ENGINE EXECUTION] Starting registry trust lookup for ID: ${args.targetAgentId}`);
      const data = await performCoreTelemetryAudit(args.targetAgentId, null);
      return { content: [{ type: "text", text: safeJsonStringify(data) }] };
    });
  });
  return server;
}

function buildTriageMcpServer(sessionId: string): Server {
  const server = new Server({ name: "sla-warden-triage", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "Wallet Security Triage",
      description: "On-chain address triage scanning suite to detect counterparty asset anomalies.",
      inputSchema: {
        type: "object",
        properties: {
          transactionPayload: {
            type: "object",
            properties: { to: { type: "string", description: "The counterparty address or contract to scan for spender vulnerabilities." } },
            required: ["to"]
          }
        },
        required: ["transactionPayload"]
      }
    }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "Wallet Security Triage") throw new Error("Tool mismatch.");
    return logLocalStorage.run({ sessionId }, async () => {
      const args = z.object({ transactionPayload: z.object({ to: z.string() }) }).parse(request.params.arguments);
      console.log(`[TRIAGE ENGINE EXECUTION] Starting allowance spend health scan for address: ${args.transactionPayload.to}`);
      const data = await performCoreTelemetryAudit(null, args.transactionPayload);
      return { content: [{ type: "text", text: safeJsonStringify(data) }] };
    });
  });
  return server;
}

function buildSimulationMcpServer(sessionId: string): Server {
  const server = new Server({ name: "sla-warden-simulation", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "Tx Pre-Flight Simulation",
      description: "Sandboxed dry-run pre-execution simulation for raw EVM calldata payloads.",
      inputSchema: {
        type: "object",
        properties: {
          transactionPayload: {
            type: "object",
            properties: {
              to: { type: "string", description: "Target EVM smart contract deployment destination address." },
              data: { type: "string", description: "Hexadecimal compiled calldata string execution byte payload block." },
              value: { type: "string", description: "Raw base native token value size integer transfer string." }
            },
            required: ["to", "data"]
          }
        },
        required: ["transactionPayload"]
      }
    }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "Tx Pre-Flight Simulation") throw new Error("Tool mismatch.");
    return logLocalStorage.run({ sessionId }, async () => {
      const args = z.object({
        transactionPayload: z.object({ to: z.string(), data: z.string(), value: z.string().optional() })
      }).parse(request.params.arguments);
      console.log(`[SIMULATION ENGINE EXECUTION] Dispatching dry-run pre-flight to target contract: ${args.transactionPayload.to}`);
      const data = await performCoreTelemetryAudit(null, args.transactionPayload);
      return { content: [{ type: "text", text: safeJsonStringify(data) }] };
    });
  });
  return server;
}

// ================== ISOLATED A2MCP DIRECT ROUTERS ==================

const buildMcpHandler = (serverBuilder: (sid: string) => Server, endpointPath: string) => {
  return (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const host = req.headers.host || "localhost:8080";
    const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const messageUrl = `${protocol}://${host}${endpointPath}/messages`;

    const transport = new SSEServerTransport(messageUrl as any, res as any);
    const sessionId = transport.sessionId;

    const clientId = req.headers["x-client-id"];
    if (clientId) sessionClientIdentifiers.set(sessionId, String(clientId));
    
    sessionPaths.set(sessionId, endpointPath);

    const sessionServer = serverBuilder(sessionId);
    activeTransports.set(sessionId, transport);
    activeServers.set(sessionId, sessionServer);

    logLocalStorage.run({ sessionId }, () => {
      console.log(`[A2MCP CONNECT] Active Route: ${endpointPath} | Session spawned: ${sessionId}`);
    });

    sessionServer.connect(transport).catch((error) => {
      console.error(`Session failed to connect: ${sessionId}`, error);
      activeTransports.delete(sessionId);
      activeServers.delete(sessionId);
      sessionPaths.delete(sessionId);
      if (clientId) sessionClientIdentifiers.delete(sessionId);
    });

    req.on("close", () => {
      logLocalStorage.run({ sessionId }, () => {
        console.log(`[A2MCP CLOSE] Connection closed for route ${endpointPath} on session ${sessionId}`);
      });
      activeTransports.delete(sessionId);
      activeServers.delete(sessionId);
      sessionPaths.delete(sessionId);
      if (clientId) sessionClientIdentifiers.delete(sessionId);
    });
  };
};

const buildMcpMessageHandler = () => {
  return (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    logLocalStorage.run({ sessionId }, () => {
      const transport = activeTransports.get(sessionId);
      if (transport) {
        transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No active session segment found in mapping space.");
      }
    });
  };
};

app.get("/mcp/kya", buildMcpHandler(buildKyaMcpServer, "/mcp/kya"));
app.post("/mcp/kya/messages", buildMcpMessageHandler());

app.get("/mcp/triage", buildMcpHandler(buildTriageMcpServer, "/mcp/triage"));
app.post("/mcp/triage/messages", buildMcpMessageHandler());

app.get("/mcp/simulation", buildMcpHandler(buildSimulationMcpServer, "/mcp/simulation"));
app.post("/mcp/simulation/messages", buildMcpMessageHandler());

app.get("/mcp/active-sessions", (req: Request, res: Response) => {
  const targetId = req.headers["x-client-id"] || req.query.clientId;
  const targetPath = req.query.path as string; 
  
  if (targetId) {
    let matchingSessions = Array.from(sessionClientIdentifiers.entries())
      .filter(([_, cid]) => cid === targetId)
      .map(([sid, _]) => sid);
      
    if (targetPath) {
      matchingSessions = matchingSessions.filter(sid => {
        const storedPath = sessionPaths.get(sid) || "";
        return storedPath.includes(targetPath) || targetPath.includes(storedPath);
      });
    }

    return res.status(200).json({
      activeSessionIds: matchingSessions
    });
  }

  return res.status(200).json({
    activeSessionIds: Array.from(activeTransports.keys())
  });
});

// ================== DEBUG AND LOGIN ANCHOR ROUTING LAYER ==================

app.get("/debug/cli-status", async (req: Request, res: Response) => {
  const providedKey = req.query.key;
  if (!process.env.DEBUG_SECRET || providedKey !== process.env.DEBUG_SECRET) return res.status(404).json({ error: "endpoint_not_found" });
  
  const versionCheck = await runDiagnosedCommand("DEBUG: version", "onchainos --version");
  const walletCheck = await runDiagnosedCommand("DEBUG: wallet-status", "onchainos wallet status");
  const homeCheck = await runDiagnosedCommand("DEBUG: home-config", "ls -la ~/.onchainos 2>&1 || echo 'MISSING'");

  return res.json({
    binaryPresent: !versionCheck.error,
    versionOutput: versionCheck.stdout || versionCheck.error,
    walletStatus: walletCheck.parsed || walletCheck.error,
    homeConfigDir: homeCheck.stdout || homeCheck.error,
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
  
  const agentCheck = await runDiagnosedCommand("BRIDGE MY AGENTS", "onchainos agent my-agents");
  let activeAgentId = "5239"; 
  
  if (agentCheck.parsed && agentCheck.parsed.ok && Array.isArray(agentCheck.parsed.data)) {
    const activeAgent = agentCheck.parsed.data.find((a: any) => a.status === "active");
    if (activeAgent) {
      activeAgentId = activeAgent.agentId;
    }
  }

  try {
    await runDiagnosedCommand("BRIDGE ACTIVATE", `onchainos agent activate --agent-id ${activeAgentId} --preferred-language en-US`);
  } catch (actErr: any) {
    console.log(`[BRIDGE WARNING] Activation routing deferred: ${actErr.message}`);
  }
  const statusCheck = await runDiagnosedCommand("BRIDGE STATUS", "onchainos wallet status");
  return res.json({ verification: verifyResult.parsed || verifyResult.stdout, currentWalletStatus: statusCheck.parsed || statusCheck.stdout });
});

app.get("/health", (req: Request, res: Response) => {
  return res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
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

async function runBootDiagnostics() {
  console.log("\n=== SERVER SPIN-UP BOOT DIAGNOSTICS ===");
  await runDiagnosedCommand("BOOT: version", "onchainos --version");

  if (process.env.OKX_API_KEY) {
    console.log("[BOOT: login] Found API credentials. Attempting automated login...");
    await runDiagnosedCommand("BOOT: login-action", "onchainos wallet login");
  } else {
    console.log("[BOOT: login] No API key present in environment variables.");
  }

  await runDiagnosedCommand("BOOT: wallet-status", "onchainos wallet status");
  console.log("=== SERVER SPIN-UP BOOT DIAGNOSTICS END ===\n");
}

serverInstance.listen(PORT, "0.0.0.0", async () => {
  console.log(`[A2MCP Server] SLA-Warden active with separate routes on port ${PORT}`);
  await runBootDiagnostics();
});