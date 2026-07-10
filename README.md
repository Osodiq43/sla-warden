# 🛡️ SLA-Warden: B2B Compliance & Verification Oracle

SLA-Warden is an autonomous compliance oracle designed for inter-agent commerce. Operating as an A2MCP node secured by the OKX Agent Payments Protocol (MPP), it processes real-time background reputation analysis, transactional evaluations, and structural delivery asset audits before confirming verification schemas.

## 🚀 Deployment Status

This oracle is actively configured to compile and run 24/7 as an autonomous Linux service layer using the accompanying system `Dockerfile` infrastructure.

## 🛠️ Required Environment Variables

To deploy this node, ensure your cloud host runtime possesses the following secret variables:

```ini
OKX_API_KEY="your-api-key"
OKX_SECRET_KEY="your-secret-key"
OKX_PASSPHRASE="your-passphrase"
MPP_SECRET_KEY="your-32-char-hex-string"
PORT=7860