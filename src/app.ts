import express from "express";
import type { Request, Response } from "express";
import * as dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import * as fsPromises from "fs/promises";
import * as path from "path";
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
  amount: "20000", 
  currency: "0x779ded0c9e1022225f8e0630b35a9b54be713736", 
  recipient: "0x0000000000000000000000000000000000000000", 
  description: "SLA-Warden Comprehensive Compliance Evaluation",
  methodDetails: { chainId: 196, feePayer: true },
};

interface VerifyBody {
  targetAgentId: string;
  jobId?: string;
  fileKey?: string;
  expectedSchema?: string; 
  transactionPayload?: {
    to: string;
    data: string;
    value: string;
  };
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

  const { targetAgentId, jobId, fileKey, expectedSchema, transactionPayload } = req.body as VerifyBody;
  if (!targetAgentId) {
    console.log("[Request Rejected] Missing mandatory targetAgentId parameter.");
    return res.status(400).json({ error: "missing_parameter: targetAgentId" });
  }

  try {
    let verdict = "PASS";
    const flags: string[] = [];

    console.log(`[Layer 2] Auditing identity and active disputes for agent: ${targetAgentId}`);
    const profileCmd = `onchainos agent profile ${targetAgentId} --chain xlayer`;
    const tasksCmd = `onchainos agent task-in-progress --agent-ids ${targetAgentId} --chain xlayer`;

    const [profileRaw, tasksRaw] = await Promise.all([
      execAsync(profileCmd).catch((e) => e),
      execAsync(tasksCmd).catch((e) => e),
    ]);

    const profileResult = profileRaw?.stdout ? extractJsonFromStdout(profileRaw.stdout) : null;
    const tasksResult = tasksRaw?.stdout ? extractJsonFromStdout(tasksRaw.stdout) : null;

    if (!profileResult || !profileResult.ok) {
      verdict = "BLOCK";
      flags.push("unregistered_or_invalid_agent_identity");
      console.log("   ↳ FLAG added: Identity unregistered or invalid.");
    }

    if (tasksResult && tasksResult.data) {
      const activeDisputes = tasksResult.data.evaluatorDisputes || [];
      if (activeDisputes.length > 0) {
        verdict = "CAUTION";
        flags.push(`active_disputes_detected: ${activeDisputes.length}`);
        console.log(`   ↳ FLAG added: Detected ${activeDisputes.length} active registry disputes.`);
      }
    }

    if (transactionPayload && verdict !== "BLOCK") {
      console.log("[Layer 3] Simulating smart contract execution payload...");
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";
      const simCmd = `onchainos gateway simulate --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain xlayer`;
      const simRaw = await execAsync(simCmd).catch((e) => e);
      const simResult = simRaw?.stdout ? extractJsonFromStdout(simRaw.stdout) : null;

      if (simResult && simResult.error) {
        verdict = "BLOCK";
        flags.push(`simulation_reverted: ${simResult.error.message || "unknown_revert"}`);
        console.log(`   ↳ FLAG added: Blockchain simulation failed. Revert message: ${simResult.error.message}`);
      } else {
        console.log("   ↳ Simulation successful. Transaction paths stable.");
      }
    }

    if (jobId && fileKey && verdict !== "BLOCK") {
      console.log(`[Layer 4] Securing and validating deliverable assets for Job: ${jobId}`);
      const downloadDir = path.join(process.cwd(), "downloads");
      await fsPromises.mkdir(downloadDir, { recursive: true });
      const targetPath = path.join(downloadDir, `${jobId}_output.dat`);

      const downloadCmd = `onchainos agent file-download --file-key ${fileKey} --agent-id ${targetAgentId} --output ${targetPath}`;
      const downloadSuccess = await execAsync(downloadCmd).then(() => true).catch(() => false);

      if (!downloadSuccess) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push("deliverable_download_failed_or_key_invalid");
        console.log("   ↳ FLAG added: Download failed. File key or permissions invalid.");
      } else {
        const mimeCmd = `file --mime-type -b ${targetPath}`;
        const mimeType = await execAsync(mimeCmd).then(r => r.stdout.trim()).catch(() => "unknown/binary");

        if (expectedSchema) {
          try {
            const rawContent = await fsPromises.readFile(targetPath, "utf-8");
            const parsedJson = JSON.parse(rawContent);
            const parsedSchema = JSON.parse(expectedSchema);
            
            for (const key of Object.keys(parsedSchema)) {
              if (!(key in parsedJson)) {
                if (verdict !== "BLOCK") verdict = "CAUTION";
                flags.push(`schema_violation: missing_expected_key_${key}`);
                console.log(`   ↳ SCHEMA VIOLATION: Missing structured key: "${key}"`);
              }
            }
          } catch {
            if (verdict !== "BLOCK") verdict = "CAUTION";
            flags.push(`schema_violation: output_is_not_valid_json_but_schema_was_provided (Detected MIME: ${mimeType})`);
            console.log(`   ↳ SCHEMA VIOLATION: Output format unparsable. Detected MIME: ${mimeType}`);
          }
        }
        await fsPromises.unlink(targetPath).catch(() => null);
      }
    }

    const businessData = {
      verdict,
      targetAgentId,
      timestamp: new Date().toISOString(),
      flags,
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

app.listen(PORT, () => {
  console.log(`[SLA-Warden] Standard MPP Server active on port ${PORT}`);
});