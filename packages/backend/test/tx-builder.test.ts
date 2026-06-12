/**
 * Browser-signing seam (D-017 follow-through, D-028) — written before
 * implementation. The browser never carries chain deps: the backend
 * builds UNSIGNED governance transactions (deposit, cast-vote), the
 * wallet signs raw bytes (wallet-standard), and the backend submits.
 *
 * Contract for every built tx:
 *  - fee payer == the wallet, and the wallet is the ONLY signer
 *    (no platform key can be smuggled into the signer set);
 *  - serialized with requireAllSignatures=false and round-trips;
 *  - instruction content is byte-identical to the spl-governance client
 *    oracle (withDepositGoverningTokens / withCastVote).
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Vote,
  VoteChoice,
  VoteKind,
  withCastVote,
  withDepositGoverningTokens,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "@daofun/sdk";
import {
  buildCastVoteTx,
  buildDepositGoverningTokensTx,
} from "../src/tx-builder";
import { createApiHandler, type ApiDeps } from "../src/http-api";
import { MemoryLaunchStore } from "../src/launch-machine";
import { MemoryArtifactStore } from "../src/artifacts";
import type { GovernanceTxSource } from "../src/tx-builder";

const wallet = Keypair.generate().publicKey;
const realm = Keypair.generate().publicKey;
const governance = Keypair.generate().publicKey;
const proposal = Keypair.generate().publicKey;
const proposalOwnerRecord = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

function decoded(txBase64: string): Transaction {
  return Transaction.from(Buffer.from(txBase64, "base64"));
}

describe("buildDepositGoverningTokensTx", () => {
  it("wallet is fee payer and the only signer; ix matches the oracle", async () => {
    const built = await buildDepositGoverningTokensTx({
      realm,
      governingTokenMint: mint,
      wallet,
      amount: 123_456n,
      blockhash: BLOCKHASH,
    });
    const tx = decoded(built.txBase64);
    expect(tx.feePayer!.equals(wallet)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    const signers = tx.compileMessage()
      .accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.equals(wallet)).toBe(true);

    // oracle: the spl-governance client with the wallet's ATA as source
    const oracle: Parameters<typeof withDepositGoverningTokens>[0] = [];
    const tor = await withDepositGoverningTokens(
      oracle,
      SPL_GOVERNANCE_PROGRAM_ID,
      3,
      realm,
      getAssociatedTokenAddressSync(mint, wallet),
      mint,
      wallet,
      wallet,
      wallet,
      new BN("123456"),
    );
    expect(tx.instructions).toHaveLength(oracle.length);
    for (let i = 0; i < oracle.length; i++) {
      expect(tx.instructions[i]!.data.equals(oracle[i]!.data)).toBe(true);
      expect(
        tx.instructions[i]!.keys.map((k) => k.pubkey.toBase58()),
      ).toEqual(oracle[i]!.keys.map((k) => k.pubkey.toBase58()));
    }
    expect(built.tokenOwnerRecord).toBe(tor.toBase58());
  });

  it("supports a non-default token program for Token-2022 sources", async () => {
    const tokenProgram = Keypair.generate().publicKey;
    const built = await buildDepositGoverningTokensTx({
      realm,
      governingTokenMint: mint,
      wallet,
      amount: 1n,
      blockhash: BLOCKHASH,
      tokenProgram,
    });
    const tx = decoded(built.txBase64);
    const keys = tx.instructions.flatMap((ix) =>
      ix.keys.map((k) => k.pubkey.toBase58()),
    );
    expect(keys).toContain(
      getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram).toBase58(),
    );
  });

  it("AUDIT F-7: a Token-2022 deposit retargets the program AND appends the mint", async () => {
    // The deployed v3.1.4 fork rejects a classic-program/no-mint deposit for a
    // Token-2022 governing mint; the browser builder must apply both patches.
    const built = await buildDepositGoverningTokensTx({
      realm,
      governingTokenMint: mint,
      wallet,
      amount: 7n,
      blockhash: BLOCKHASH,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    const tx = decoded(built.txBase64);
    const depositIx = tx.instructions[tx.instructions.length - 1]!;
    const keys = depositIx.keys.map((k) => k.pubkey.toBase58());
    // (a) Token-2022 program present, classic Token program gone
    expect(keys).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(keys).not.toContain(TOKEN_PROGRAM_ID.toBase58());
    // (b) the mint is appended (read-only) for the Token-2022 transfer_checked
    expect(keys).toContain(mint.toBase58());
    const appended = depositIx.keys.find((k) => k.pubkey.equals(mint))!;
    expect(appended.isSigner).toBe(false);
    expect(appended.isWritable).toBe(false);
  });

  it("AUDIT F-7: the classic deposit path appends NO mint (behaviour preserved)", async () => {
    const built = await buildDepositGoverningTokensTx({
      realm,
      governingTokenMint: mint,
      wallet,
      amount: 7n,
      blockhash: BLOCKHASH,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    const tx = decoded(built.txBase64);
    const depositIx = tx.instructions[tx.instructions.length - 1]!;
    // classic path: the mint is NOT a standalone appended account
    expect(
      depositIx.keys.filter((k) => k.pubkey.equals(mint)),
    ).toHaveLength(0);
  });
});

describe("buildCastVoteTx", () => {
  it("builds an Approve(100%) vote; wallet-only signer; oracle-identical", async () => {
    const built = await buildCastVoteTx({
      realm,
      governance,
      proposal,
      proposalOwnerRecord,
      governingTokenMint: mint,
      wallet,
      blockhash: BLOCKHASH,
      approve: true,
    });
    const tx = decoded(built.txBase64);
    expect(tx.feePayer!.equals(wallet)).toBe(true);
    const msg = tx.compileMessage();
    expect(msg.header.numRequiredSignatures).toBe(1);
    expect(msg.accountKeys[0]!.equals(wallet)).toBe(true);

    const oracle: Parameters<typeof withCastVote>[0] = [];
    const { getTokenOwnerRecordAddress } = await import("@solana/spl-governance");
    const voterTor = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      realm,
      mint,
      wallet,
    );
    await withCastVote(
      oracle,
      SPL_GOVERNANCE_PROGRAM_ID,
      3,
      realm,
      governance,
      proposal,
      proposalOwnerRecord,
      voterTor,
      wallet,
      mint,
      new Vote({
        voteType: VoteKind.Approve,
        approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
        deny: undefined,
        veto: undefined,
      }),
      wallet,
    );
    expect(tx.instructions).toHaveLength(oracle.length);
    for (let i = 0; i < oracle.length; i++) {
      expect(tx.instructions[i]!.data.equals(oracle[i]!.data)).toBe(true);
    }
  });

  it("approve=false builds a Deny vote (different payload)", async () => {
    const yes = await buildCastVoteTx({
      realm,
      governance,
      proposal,
      proposalOwnerRecord,
      governingTokenMint: mint,
      wallet,
      blockhash: BLOCKHASH,
      approve: true,
    });
    const no = await buildCastVoteTx({
      realm,
      governance,
      proposal,
      proposalOwnerRecord,
      governingTokenMint: mint,
      wallet,
      blockhash: BLOCKHASH,
      approve: false,
    });
    expect(yes.txBase64).not.toBe(no.txBase64);
  });
});

// ---------- /chain/txs/* routes ----------

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function startApi(txs?: GovernanceTxSource) {
  const deps: ApiDeps = {
    launchStore: new MemoryLaunchStore(),
    artifactStore: new MemoryArtifactStore(),
    buildSteps: () => [],
    txs,
  };
  server = createServer(createApiHandler(deps));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe("POST /chain/txs/*", () => {
  const submitted: string[] = [];
  const fakeSource: GovernanceTxSource = {
    async depositTx(req) {
      expect(req.wallet.equals(wallet)).toBe(true);
      expect(req.amount).toBe(5n);
      return { txBase64: "ZGVwb3NpdA==", tokenOwnerRecord: "tor" };
    },
    async castVoteTx(req) {
      expect(req.proposal.equals(proposal)).toBe(true);
      expect(req.approve).toBe(false);
      return { txBase64: "dm90ZQ==" };
    },
    async submit(rawBase64) {
      submitted.push(rawBase64);
      return { signature: "sig123" };
    },
  };

  it("deposit + cast-vote return unsigned txs; submit forwards signed bytes", async () => {
    const base = await startApi(fakeSource);
    const dep = await fetch(`${base}/chain/txs/deposit`, {
      method: "POST",
      body: JSON.stringify({
        realm: realm.toBase58(),
        governingTokenMint: mint.toBase58(),
        wallet: wallet.toBase58(),
        amount: "5",
      }),
    });
    expect(dep.status).toBe(200);
    expect(await dep.json()).toEqual({
      txBase64: "ZGVwb3NpdA==",
      tokenOwnerRecord: "tor",
    });

    const vote = await fetch(`${base}/chain/txs/cast-vote`, {
      method: "POST",
      body: JSON.stringify({
        proposal: proposal.toBase58(),
        wallet: wallet.toBase58(),
        approve: false,
      }),
    });
    expect(vote.status).toBe(200);
    expect(await vote.json()).toEqual({ txBase64: "dm90ZQ==" });

    const sub = await fetch(`${base}/chain/txs/submit`, {
      method: "POST",
      body: JSON.stringify({ signedTxBase64: "c2lnbmVk" }),
    });
    expect(sub.status).toBe(200);
    expect(await sub.json()).toEqual({ signature: "sig123" });
    expect(submitted).toEqual(["c2lnbmVk"]);
  });

  it("validates pubkeys/amounts (400) and is 501 without a source", async () => {
    const base = await startApi(fakeSource);
    expect(
      (
        await fetch(`${base}/chain/txs/deposit`, {
          method: "POST",
          body: JSON.stringify({ realm: "x", governingTokenMint: "y", wallet: "z", amount: "0" }),
        })
      ).status,
    ).toBe(400);
    const bare = await startApi();
    expect(
      (
        await fetch(`${bare}/chain/txs/submit`, {
          method: "POST",
          body: JSON.stringify({ signedTxBase64: "AA==" }),
        })
      ).status,
    ).toBe(501);
  });
});
