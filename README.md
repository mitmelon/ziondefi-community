<div align="center">

# 💳 ZionDefi Protocol v1.0
### The Push-Only Smart Contract Payment System on Starknet — Powered by Amazon Nova and Starkzap

[![Cairo](https://img.shields.io/badge/Cairo-2.0+-blue?style=flat-square)](https://www.cairo-lang.org/)
[![Starknet](https://img.shields.io/badge/Starknet-Sepolia-purple?style=flat-square)](https://www.starknet.io/)
[![Amazon Nova](https://img.shields.io/badge/Amazon-Nova%20Lite-orange?style=flat-square)](https://aws.amazon.com/bedrock/)
[![Starkzap](https://img.shields.io/badge/Starkzap-Staking%20SDK-green?style=flat-square)](https://starkzap.com/)
[![License: MIT](https://img.shields.io/badge/Contracts-MIT-yellow?style=flat-square)](contracts/LICENSE)
[![Website](https://img.shields.io/badge/Website-ziondefi.com-blue?style=flat-square)](https://ziondefi.com)

---

🔒 **No Infinite Approvals** · ⚡ **Gasless Transactions** · 🤖 **AI-Powered Yield via Zara** · 📲 **NFC + QR Payments**

**🌐 [Website](https://ziondefi.com)** | **💬 [Issues](https://github.com/mitmelon/ziondefi-community/issues)**

</div>

> **Security Notice — v1.0 Beta**
> Core contracts are on Starknet Sepolia undergoing internal audit. Use testnet funds only.

---

## Table of Contents

- [About](#about)
- [The Problem](#the-problem)
- [Our Solution](#our-solution)
- [Meet Zara — The AI Agent](#meet-zara--the-ai-agent)
- [Tech Stack](#tech-stack)
- [Deployed Addresses](#deployed-addresses)
- [Running Locally](#running-locally)
- [Configuration](#configuration)
- [Using the App](#using-the-app)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## About

ZionDefi is a **QR and NFC payment protocol** built on Starknet. Each user deploys their own isolated smart contract card through a factory, funds it, and spends at merchants by pushing exact amounts — never granting pull approvals to anyone.

Sitting on top of every card is **Zara**, an autonomous AI agent powered by **Amazon Nova Lite** via AWS Bedrock. Zara manages the idle balance inside your card — staking it through **Starkzap** to earn yield, compounding rewards automatically, adjusting how much stays liquid based on your spending patterns, and monitoring live market data to protect your funds if conditions turn volatile.

Your money earns yield while it waits to be spent. You tap to pay, and Zara keeps the rest working.

---

## The Problem

Crypto payments are broken in four specific ways.

**Infinite approvals.** Standard DeFi requires you to grant protocols permission to pull unlimited funds from your wallet. Over $1.5 billion was lost to exploits and approval-based drains in 2024 alone. Often it was not even bad code — it was a single old approval that silently survived long after the user forgot about it.

**Gas friction.** Asking a retail user to estimate gas before buying coffee is a non-starter for mass adoption. The mental overhead alone sends people back to their bank cards.

**Token fragmentation.** Users hold STRK or ETH. Merchants want USDC. Bridging this gap manually involves steps that do not belong in a payment flow.

**Idle capital.** When you top up a payment card, that money just sits there. In traditional finance your bank puts it to work. In DeFi it sits dead in a contract doing nothing until you spend it. That is capital inefficiency that does not need to exist.

---

## Our Solution

ZionDefi replaces "pull" with "push" and adds an intelligent financial layer on top.

**Push-only payments.** Your card contract is funded and isolated. Every payment requires a fresh ECDSA PIN signature from your device's secure enclave. The contract verifies the signature and pushes the exact amount to the merchant. No approval is ever granted. Nothing can be taken without a valid signed instruction from you.

**Simple cross-chain funding.** You can top up your card from any major chain or directly from a Starknet wallet, all from inside the dashboard. No manual bridging, no third-party UIs to connect to or trust.

**Gasless experience.** Starknet's native Account Abstraction lets a relayer pay gas on behalf of users. From the user's perspective, transactions are free.

**AI-managed yield via Zara and Starkzap.** Idle card balances are automatically staked through Starkzap and managed by Zara — so your funds earn yield between spending, and return to the card when you need them.

---

## Meet Zara — The AI Agent

Zara is ZionDefi's autonomous financial agent. She runs continuously in the background as a worker process and manages the economic life of your card using **Amazon Nova Lite** as her reasoning engine.

Every decision Zara makes — stake, compound, adjust buffer, emergency unstake — is a call to Amazon Bedrock with the full current context: card balances, active staking positions, recent transaction history, and live market data. Nova processes this and returns a structured decision with its reasoning attached. That reasoning is stored in MongoDB so every action has a transparent audit trail.

### What Zara does

**Staking cycle (every 24 hours)**
Zara checks your card balance, calculates the buffer you need to stay liquid for spending, and stakes the remainder through Starkzap. She asks Nova: given this balance and spending history, how much should go to staking and how much should stay accessible? Nova reasons through it and returns a recommendation with the amount and rationale.

**Compound cycle (every 6 hours)**
Zara checks active staking positions for accumulated rewards. If Nova determines the rewards are large enough to justify a compound transaction, she claims them and re-stakes. Small rewards get left to grow. The decision threshold accounts for transaction costs.

**Spending analysis (every 12 hours)**
Zara pulls 30 days of transaction history and asks Nova to identify the trend. If spending is increasing, she unstakes enough to raise the liquid buffer — you will not hit a low balance at a payment terminal. If spending is decreasing, she stakes the excess. The buffer adapts to you automatically.

**Market monitoring (every 4 hours)**
Zara pulls real-time market data — 24h price change, 7-day price history, trading volume, and a volatility index — for every token held in staking positions. This goes to Nova for risk assessment. If Nova identifies conditions that meet the emergency threshold (severe token dump, market-wide crash, extreme volatility), Zara triggers an emergency unstake and returns funds to the card.

### Nova as a reasoning layer

The core design pattern is treating Nova as a function, not a chatbot. Each agent cycle constructs a prompt with the complete current state and asks for a structured JSON response with a specific schema. The agent parses that response and acts on it directly. Nova's reasoning is stored in MongoDB attached to every on-chain action, making every decision fully auditable.

```
Current state (balances, positions, market data, spending history)
                           ↓
                  Amazon Nova Lite
                           ↓
             Structured JSON decision
              { action, amount, reasoning }
                           ↓
             Starkzap on-chain execution
                           ↓
              MongoDB log with tx hash
```

### Zara's activity log types

| Action | Trigger |
|---|---|
| `staking_cycle_started` | 24h cycle begins |
| `staking_analysis_complete` | Nova returns recommendation |
| `stake_success` | Starkzap stake confirmed on-chain |
| `compound_success` | Rewards claimed and re-staked |
| `buffer_adjustment_unstake` | Spending increase detected |
| `buffer_adjustment_stake` | Spending decrease detected |
| `emergency_unstake_triggered` | Market crash threshold met |
| `compound_skipped` | Nova decided rewards too small |

---

## Tech Stack

### Smart Contracts
- **Cairo 2.0+** — Contract language for Starknet
- **Starknet** — L2 ZK-Rollup execution layer
- **Pragma Oracle** — On-chain USD price feeds for fee calculations
- **ECDSA** — PIN-based authorization with nonce protection and lockout

### AI Agent (Zara)
- **Amazon Nova Lite** (via AWS Bedrock) — Reasoning engine for all financial decisions
- **Starkzap SDK** — Starknet staking, compounding, and unstaking
- **MongoDB** — Stake positions and agent activity audit trail
- **RabbitMQ** — Agent lifecycle events (enable/disable per card)
- **Node.js** — Worker process runtime

### Infrastructure
- **Starknet Account Abstraction** — Gasless relayer transactions
- **ArgentX / Braavos** — Supported wallet connections

---

## Deployed Addresses

### Starknet Sepolia (Testnet)

| Contract | Address |
|---|---|
| **ZionDefiFactory** | `0x027b6949b32eb29c3d2c21215d68186f6ee8a16d62193e7d35faf77d6fcccf9a` |
| **ZionDefiCard** (class hash) | `0x3f7430fed1cc6d7776d1a6125ca8ff922f1f1bd85d250e0f7515a9a44029693` |

> The ZionDefiCard class hash is the declared blueprint used by the factory to deploy individual user cards. It is not a standalone contract — the factory deploys a fresh instance per user.

### Starknet Mainnet

| Contract | Address |
|---|---|
| **ZionDefiFactory** | *Upcoming — pending audit completion* |
| **ZionDefiCard** (class hash) | *Upcoming* |

### Supported Tokens (Sepolia)

| Token | Address |
|---|---|
| **ETH** | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` |
| **STRK** | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |
| **USDC** | `0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343` |
| **USDC.e** | `0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080` |

---

## Running Locally

### Prerequisites

- **Node.js** >= 24 — [Download](https://nodejs.org/)
- **MongoDB** running locally or a connection string — [Atlas free tier](https://www.mongodb.com/atlas) works fine
- **RabbitMQ** running locally — [Install](https://www.rabbitmq.com/download.html) or use [CloudAMQP free tier](https://www.cloudamqp.com/)
- **ArgentX** or **Braavos** wallet installed in your browser with some Sepolia Strk — [Faucet](https://starknet-faucet.vercel.app/)

### Install and run

```bash
git clone https://github.com/mitmelon/ziondefi-community.git
cd ziondefi-community
npm install
cp .env.example .env
# fill in .env — see Configuration section below
npm start
```

Then open **http://localhost:3000/home** in your browser.

That is all. Everything else — card deployment, funding, and Zara — happens through the GUI.

---

## Configuration

All configuration lives in `.env`. The deployed Sepolia contracts are pre-filled so you can run against testnet immediately without deploying anything. The minimum you need to provide to get started is a MongoDB URI, a RabbitMQ URL, a Starknet Sepolia RPC URL, a funded relayer wallet, and AWS credentials for Zara.

```bash
# ── App ─────────────────────────────────────────────────────────────────
APP_NAME=ZionDefi
APP_DOMAIN=http://localhost:3000
PORT=3000
NODE_ENV=development
TIMEZONE=Africa/Lagos                         # set to your local timezone

# ── Security ────────────────────────────────────────────────────────────
COOKIE_SECRET=at-least-32-characters-long-random-string_community
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRATION=1h

# ── MongoDB ─────────────────────────────────────────────────────────────
# Local:  mongodb://localhost:27017
# Atlas:  mongodb+srv://user:pass@cluster.mongodb.net
MONGO_URI=
MONGO_DB=ziondefi_community
DB_NAME_SANDBOX=ziondefi_community_sandbox

# ── Cloudflare Turnstile (bot protection on auth forms) ─────────────────
# For local dev use the always-passes test keys:
#   Site key:   1x00000000000000000000AA
#   Secret key: 1x0000000000000000000000000000000AA
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=

# ── Starknet MAINNET (is_live = true) ────────────────────────────────────
# Leave blank — mainnet is pending audit. App falls back to testnet automatically.
STARKNET_RPC_URL=
EXPLORER_URL_MAINNET=
FACTORY_CONTRACT_ADDRESS=
RELAYER_ACCOUNT_ADDRESS=
RELAYER_PRIVATE_KEY=
OWNER_ACCOUNT_ADDRESS=
OWNER_PRIVATE_KEY=

# Mainnet token addresses (pre-filled, do not change)
TOKEN_ETH=0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7
TOKEN_STRK=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
TOKEN_USDC=0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8
TOKEN_USDT=0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8

# ── Starknet SEPOLIA TESTNET (is_live = false) ───────────────────────────
# Get one from Alchemy:
TESTNET_STARKNET_RPC_URL=
EXPLORER_URL_SEPOLIA=https://sepolia.voyager.online

# Factory is already deployed — use this address as-is, no redeployment needed
TESTNET_FACTORY_CONTRACT_ADDRESS=0x027b6949b32eb29c3d2c21215d68186f6ee8a16d62193e7d35faf77d6fcccf9a

# Relayer — create a Starknet Sepolia account wallet and fund it from the faucet
# https://starknet-faucet.vercel.app/
# The relayer pays gas on behalf of users via Account Abstraction
TESTNET_RELAYER_ACCOUNT_ADDRESS=
TESTNET_RELAYER_PRIVATE_KEY=

# Admin/owner — can be the same account as relayer on testnet
TESTNET_OWNER_ACCOUNT_ADDRESS=
TESTNET_OWNER_PRIVATE_KEY=

# Testnet token addresses (pre-filled, do not change)
TESTNET_TOKEN_ETH=0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7
TESTNET_TOKEN_STRK=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
TESTNET_TOKEN_USDCE=0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080
TESTNET_TOKEN_USDC=0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343

# ── RabbitMQ ────────────────────────────────────────────────────────────
# Required for Zara's enable/disable worker events
# Local: amqp://localhost:5672
RABBITMQ_URL=amqp://localhost:5672
RABBITMQ_QUEUE=card_deployment_queue

# ── AWS Bedrock — Required for Zara ─────────────────────────────────────
# Zara uses Amazon Nova Lite for all financial decisions.
#
# Setup steps:
#   1. AWS Console → IAM → create a user or role
#   2. Attach policy: AmazonBedrockFullAccess
#   3. Security Credentials → create an Access Key
#   4. Paste the key ID and secret below
#   5. Enable Nova Lite in your region:
#      AWS Console → Bedrock → Model Access → request Amazon Nova Lite
#
# us-east-1 is recommended for lowest latency
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AGENT_BEDROCK_MODEL=us.amazon.nova-2-lite-v1:0

# ── Zara Agent ───────────────────────────────────────────────────────────
# Set to true to auto-resume all enabled agents on server restart
AGENT_AUTOSTART=false

# ── CoinGecko (price display in dashboard) ───────────────────────────────
# Optional. Free tier works (60s refresh). Pro key gives 10s refresh.
# https://coingecko.com/en/api
COINGECKO_API_KEY=
```

---

## Using the App

Once the server is running at **http://localhost:3000/home**, everything happens through the browser. No CLI steps needed after startup.

### 1. Connect your wallet

ZionDefi supports **ArgentX** and **Braavos**. Click Connect Wallet on the home page and approve the connection. Make sure your wallet is set to **Starknet Sepolia**.

### 2. Deploy a card

Go to the Cards section and create a new card. The app deploys it through the factory contract on your behalf. Once confirmed on-chain, your card address appears on the dashboard.

### 3. Fund your card

Open your card and go to Deposit. You have two options:

**Direct deposit** — send any supported token from a Starknet wallet straight to your card address.

**Bridge from another chain** — fund your card from Ethereum, Base, Arbitrum, Optimism, or other major networks without connecting to any external service. Select your source chain, enter the amount, and follow the steps in the dashboard. Funds arrive directly in your card.

### 4. Activate Zara

Once your card has a balance, flip the Zara switch on your card dashboard and confirm the transaction. Zara starts immediately and runs in the background from that point — staking idle funds through Starkzap, compounding rewards, adjusting your liquid buffer as spending patterns shift, and watching market conditions. No further action needed from you.

You can view Zara's full activity log from the dashboard, including the reasoning Nova gave for every decision.

### What's available now vs coming soon

| Feature | Status |
|---|---|
| Wallet connect (ArgentX, Braavos) | Available |
| Card deployment | Available |
| Direct deposit | Available |
| Cross-chain deposit | Available |
| Zara AI agent (stake, compound, monitor) | Available |
| Withdraw to wallet | Coming soon |
| NFC tap-to-pay | Coming soon |
| QR code payments | Coming soon |
| Merchant dashboard | Coming soon |
| Physical card request | Coming soon |

---

## Roadmap

### Phase 1 — Protocol Foundation (Complete)
- [x] ZionDefiFactory and ZionDefiCard built in Cairo
- [x] ECDSA PIN component with lockout and nonce protection
- [x] Multi-currency deposit and payment lifecycle
- [x] Automatic token swap on payment
- [x] Pragma Oracle integration for USD-denominated limits
- [x] Recurring subscription payment support
- [x] Anomaly detection with auto-freeze
- [x] Factory deployed on Starknet Sepolia

### Phase 2 — Zara AI Agent (Complete)
- [x] Amazon Nova Lite integration via AWS Bedrock
- [x] Starkzap staking and compounding cycles
- [x] Spending pattern analysis with dynamic buffer adjustment
- [x] Market monitoring with Nova-powered emergency unstake
- [x] MongoDB persistence with full audit trail
- [x] RabbitMQ worker architecture for continuous background operation
- [x] Web dashboard — wallet connect, card deployment, deposit, Zara toggle

### Phase 3 — Payments (In Progress)
- [ ] NFC tap-to-pay (mobile app)
- [ ] QR code payment flow
- [ ] Merchant dashboard
- [ ] Withdraw to wallet
- [ ] Smart contract security audit

### Phase 4 — Mainnet Launch
- [ ] Factory deployment on mainnet post-audit
- [ ] Physical NFC card production
- [ ] Merchant onboarding programme

### Phase 5 — Ecosystem Expansion
- [ ] Multi-protocol yield routing via Zara
- [ ] Fiat off-ramp for merchant local currency settlement
- [ ] ZionDefi DAO governance for protocol parameters

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push and open a pull request

Contributions welcome in anomaly detection heuristics, mobile NFC integration, expanded test coverage, and contract gas optimizations.

---

## License

**`/contracts`** — MIT License. All Cairo smart contracts are open source.

**Backend, worker, frontend, mobile** — Commercial License. Contact [ziondefi.work.gd](https://ziondefi.com) for licensing inquiries.

---

<div align="center">

**🌐 [ziondefi.com](https://ziondefi.com)**

</div>