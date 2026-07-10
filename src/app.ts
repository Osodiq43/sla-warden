import express from "express";
import type { Request, Response } from "express";
import * as dotenv from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
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

app.post("/api/v1/verify", async (req: Request, res: Response) => {
  // Convert Express request to standard Web Fetch Request for MPP compatibility
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

  const result = await mppx.charge(CHARGE_CONFIG)(webRequest);
  
  if (result.status === 402) {
    return res.status(402)
      .set("WWW-Authenticate", result.challenge.headers.get("WWW-Authenticate")!)
      .json();
  }

  const { targetAgentId, jobId, fileKey, expectedSchema, transactionPayload } = req.body as VerifyBody;
  if (!targetAgentId) {
    return res.status(400).json({ error: "missing_parameter: targetAgentId" });
  }

  try {
    let verdict = "PASS";
    const flags: string[] = [];

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
    }

    if (tasksResult && tasksResult.data) {
      const activeDisputes = tasksResult.data.evaluatorDisputes || [];
      if (activeDisputes.length > 0) {
        verdict = "CAUTION";
        flags.push(`active_disputes_detected: ${activeDisputes.length}`);
      }
    }

    if (transactionPayload && verdict !== "BLOCK") {
      const { to, data, value } = transactionPayload;
      const simFrom = profileResult?.data?.agentWalletAddress || "0x0000000000000000000000000000000000000000";
      const simCmd = `onchainos gateway simulate --from ${simFrom} --to ${to} --data ${data} --value ${value} --chain xlayer`;
      const simRaw = await execAsync(simCmd).catch((e) => e);
      const simResult = simRaw?.stdout ? extractJsonFromStdout(simRaw.stdout) : null;

      if (simResult && simResult.error) {
        verdict = "BLOCK";
        flags.push(`simulation_reverted: ${simResult.error.message || "unknown_revert"}`);
      }
    }

    if (jobId && fileKey && verdict !== "BLOCK") {
      const downloadDir = path.join(process.cwd(), "downloads");
      await fs.mkdir(downloadDir, { recursive: true });
      const targetPath = path.join(downloadDir, `${jobId}_output.dat`);

      const downloadCmd = `onchainos agent file-download --file-key ${fileKey} --agent-id ${targetAgentId} --output ${targetPath}`;
      const downloadSuccess = await execAsync(downloadCmd).then(() => true).catch(() => false);

      if (!downloadSuccess) {
        if (verdict !== "BLOCK") verdict = "CAUTION";
        flags.push("deliverable_download_failed_or_key_invalid");
      } else {
        const mimeCmd = `file --mime-type -b ${targetPath}`;
        const mimeType = await execAsync(mimeCmd).then(r => r.stdout.trim()).catch(() => "unknown/binary");

        if (expectedSchema) {
          try {
            const rawContent = await fs.readFile(targetPath, "utf-8");
            const parsedJson = JSON.parse(rawContent);
            const parsedSchema = JSON.parse(expectedSchema);
            
            for (const key of Object.keys(parsedSchema)) {
              if (!(key in parsedJson)) {
                if (verdict !== "BLOCK") verdict = "CAUTION";
                flags.push(`schema_violation: missing_expected_key_${key}`);
              }
            }
          } catch {
            if (verdict !== "BLOCK") verdict = "CAUTION";
            flags.push(`schema_violation: output_is_not_valid_json_but_schema_was_provided (Detected MIME: ${mimeType})`);
          }
        }
        await fs.unlink(targetPath).catch(() => null);
      }
    }

    // Prepare JSON payload and append the required Payment-Receipt proof headers
    const businessData = {
      verdict,
      targetAgentId,
      timestamp: new Date().toISOString(),
      flags,
    };

    const webResponse = new globalThis.Response(JSON.stringify(businessData), { status: 200 });
    const finalizedResponse = result.withReceipt(webResponse);

    finalizedResponse.headers.forEach((v, k) => res.setHeader(k, v));
    return res.json(businessData);
  } catch (err: any) {
    return res.status(500).json({ error: "internal_system_error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[SLA-Warden] Standard MPP Server active on port ${PORT}`);
});
