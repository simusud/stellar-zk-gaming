# The Tie-Breaker: ZK Prisoner's Dilemma

A Zero-Knowledge (ZK) powered implementation of the classic Prisoner's Dilemma game theory scenario, built for the **Stellar ZK Hackathon**.

**Live Demo:** [https://stellar-zk-gaming-double-cross.vercel.app/](https://stellar-zk-gaming-double-cross.vercel.app/)

## Overview

The leaderboard is locked. You and a rival developer are tied for 1st Place. To decide the winning share, the judges have initiated a high-stakes, 5-round Tie-Breaker. 

This project demonstrates the power of **Zero-Knowledge Proofs** on the **Stellar Network** using **Soroban** smart contracts and **Noir** ZK circuits.

## Game Theory & Strategy

At its core, "The Tie-Breaker" is an exploration of **Strategic Decision-Making**. Based on the classic **Prisoner's Dilemma**, the game highlights how a player's optimal choice is inherently dependent on the actions—and the perceived intent—of their opponent.

### The Conflict of Choice
- **Interdependence:** Your outcome is not solely determined by your move, but by the *interaction* of your choice with your rival's.
- **Cooperation vs. Betrayal:** Do you trust your peer to cooperate for a mutual reward (`Pact`), or do you betray them (`Double Cross`) to maximize your own gain at their expense?
- **Iterated Strategy:** Over 5 rounds, "The Tie-Breaker" shifts from a one-time choice to a battle of patterns. Players must decide whether to retaliate against betrayal or continue building the trust required for a co-champion payout.

By utilizing **Zero-Knowledge Proofs**, we ensure that this strategic tension is preserved. Moves remain private until both players have committed, preventing any "last-mover advantage" and ensuring that every decision is a pure test of strategy and anticipation.

## Key Features

- **ZK-Encrypted Moves:** Player moves (Cooperate or Defect) are hidden from the opponent and the blockchain until the reveal phase, using ZK-protected hashes.
- **On-Chain Game Logic:** A Soroban contract manages the entire game lifecycle, from session creation to score calculation and outcome determination.
- **Simultaneous Turns:** ZK commitments allow both players to act at the same time without leaking their strategy.
- **Dynamic Leaderboard:** Real-time scoring based on the classic Prisoner's Dilemma payoff matrix.
- **Secure Multi-Party Auth:** Uses Soroban's native authorization framework for secure game initialization.

## Tech Stack

- **Zero-Knowledge:** [Noir](https://noir-lang.org/) (Circuit definition and proof generation)
- **Smart Contracts:** [Soroban](https://soroban.stellar.org/) (Rust)
- **Blockchain:** [Stellar Testnet](https://www.stellar.org/)
- **Frontend:** React, Vite, Tailwind CSS
- **Tools:** Bun, Stellar SDK

## Project Structure

This repository is organized as follows:

- `zk-game-theory/contracts`: Soroban smart contract source code.
- `zk-game-theory/circuits`: Noir ZK circuit definitions.
- `zk-game-theory/frontend`: React web application.
- `zk-game-theory/scripts`: Deployment and setup automation scripts.
- `zk-game-theory/bindings`: Auto-generated contract and ZK bindings.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/)
- [Node.js](https://nodejs.org/) (v18 or higher)
- [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup#install-the-stellar-cli) (Optional, for manual interactions)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd stellar-zk-gaming
   ```

2. Enter the project directory:
   ```bash
   cd zk-game-theory
   ```

3. Install dependencies:
   ```bash
   bun install
   ```

4. Run the automated setup:
   ```bash
   bun run setup
   ```
   *This script deploys the contracts to Testnet, generates ZK artifacts, and sets up your local .env with test wallets.*

### Running Locally

From the `zk-game-theory` directory, start the frontend development server:
```bash
bun run dev
```
Navigate to `http://localhost:5173` to play.

## How to Play

1. **Initialize Phase:** Player 1 creates a game session and exports a signed transaction entry.
2. **Join Phase:** Player 2 imports the entry to join the session.
3. **Commit Phase:** Both players select their move (Cooperate or Defect). The choice is hashed with a secret salt and committed to the contract.
4. **Reveal Phase:** Once both have committed, players generate a ZK proof to reveal their move without exposing their secret salt.
5. **Score Phase:** The contract calculates the points for the round:
   - Both Cooperate: +3 pts each
   - Both Defect: +1 pt each
   - One Betrays: +5 for the betrayer, 0 for the cooperator
6. **Victory:** The player with the most points after 5 rounds wins the majority share!

## License

This project is licensed under the MIT License - see the LICENSE file for details.

---
Built with passion for the Stellar ZK Hackathon.
