/**
 * Spec 6.6 — concrete launch steps over the step machine (written before
 * implementation). Deps are injected: tx sending and chain reads are
 * mocked; the assertions cover what the spec's 6.6 tests demand at unit
 * level — fee exactness, INV-1 creator plumbing, resume-after-token-
 * creation, and a failing invariant halting the launch (no silent
 * workarounds in fund paths).
 */
import { describe, expect, it, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  deriveGovernanceChainFromMint,
  deriveTreasuryPdas,
  resolveGovernanceParams,
} from "@daofun/sdk";
import { MemoryLaunchStore, runLaunch } from "../src/launch-machine";
import { buildLaunchSteps, type LaunchStepDeps } from "../src/launch-steps";

const launcher = Keypair.generate().publicKey;
const protocolTreasury = Keypair.generate().publicKey;

function makeArgs() {
  const mint = Keypair.generate();
  const createKey = Keypair.generate();
  return {
    mint: mint.publicKey,
    createKey: createKey.publicKey,
    launcher,
    protocolTreasury,
    launchFeeLamports: 50_000_000n,
    daoMode: "cypherpunk" as const,
    governanceParams: resolveGovernanceParams({
      mode: "cypherpunk",
      tier: "micro",
      communitySupply: 1_000_000_000n,
    }),
    launchParams: {
      metadata: { name: "T", symbol: "T", uri: "https://x.test/t.json" },
      daoConfig: { mode: "cypherpunk" as const, marketCapTier: "micro" as const },
      rail: "pumpfun" as const,
      launcher,
    },
  };
}

function makeDeps(overrides: Partial<LaunchStepDeps> = {}): LaunchStepDeps {
  return {
    sendAndConfirm: vi.fn(async (_ixs, label: string) => `sig-${label}`),
    buildCreateTokenIxs: vi.fn(async () => [
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [],
        data: Buffer.alloc(0),
      }),
    ]),
    fetchProgramConfigTreasury: vi.fn(async () => Keypair.generate().publicKey),
    fetchMintAuthority: vi.fn(async () => null), // null == INV-5 holds
    fetchMultisigSoleMember: vi.fn(
      async (multisigPda: PublicKey, expected: PublicKey) => expected,
    ),
    ...overrides,
  };
}

describe("buildLaunchSteps", () => {
  it("happy path: all five steps complete and the result asserts INV-1/5/7 inputs", async () => {
    const args = makeArgs();
    const deps = makeDeps();
    const { steps, getResult } = buildLaunchSteps(args, deps);
    const state = await runLaunch(args.mint.toBase58(), steps, new MemoryLaunchStore());
    expect(state.status).toBe("complete");
    expect(Object.keys(state.completedSteps)).toEqual([
      "create-treasury",
      "collect-launch-fee",
      "create-token",
      "create-dao",
      "assert-invariants",
    ]);

    const result = getResult();
    expect(result).not.toBeNull();
    expect(result!.mintAuthorityNull).toBe(true);
    expect(result!.predictedPdasMatched).toBe(true);
    const predicted = deriveGovernanceChainFromMint(args.mint);
    expect(result!.treasury.nativeTreasury.equals(predicted.nativeTreasury)).toBe(true);
    expect(
      result!.treasury.vaultPda.equals(deriveTreasuryPdas(args.createKey).vaultPda),
    ).toBe(true);
  });

  it("collects the exact launch fee from launcher to protocol treasury", async () => {
    const args = makeArgs();
    const sent: { ixs: TransactionInstruction[]; label: string }[] = [];
    const deps = makeDeps({
      sendAndConfirm: vi.fn(async (ixs, label: string) => {
        sent.push({ ixs, label });
        return `sig-${label}`;
      }),
    });
    const { steps } = buildLaunchSteps(args, deps);
    await runLaunch(args.mint.toBase58(), steps, new MemoryLaunchStore());

    const feeTx = sent.find((s) => s.label === "collect-launch-fee")!;
    expect(feeTx.ixs).toHaveLength(1);
    const ix = feeTx.ixs[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(launcher)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(protocolTreasury)).toBe(true);
    // SystemProgram.transfer data: u32 tag + u64 lamports LE
    expect(ix.data.readBigUInt64LE(4)).toBe(50_000_000n);
  });

  it("INV-1: the token create builder receives the vault PDA as creator", async () => {
    const args = makeArgs();
    const deps = makeDeps();
    const { steps } = buildLaunchSteps(args, deps);
    await runLaunch(args.mint.toBase58(), steps, new MemoryLaunchStore());

    const { vaultPda } = deriveTreasuryPdas(args.createKey);
    const call = (deps.buildCreateTokenIxs as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((call[1] as PublicKey).equals(vaultPda)).toBe(true);
  });

  it("injected failure after token creation -> resume completes realm setup only", async () => {
    const args = makeArgs();
    const store = new MemoryLaunchStore();
    let failDao = true;
    const sent: string[] = [];
    const deps = makeDeps({
      sendAndConfirm: vi.fn(async (_ixs, label: string) => {
        if (failDao && label.startsWith("create-dao")) throw new Error("rpc died");
        sent.push(label);
        return `sig-${label}`;
      }),
    });

    const first = await runLaunch(
      args.mint.toBase58(),
      buildLaunchSteps(args, deps).steps,
      store,
    );
    expect(first.status).toBe("failed");
    expect(first.failedStep).toBe("create-dao");
    expect(Object.keys(first.completedSteps)).toContain("create-token");

    failDao = false;
    sent.length = 0;
    const resumed = await runLaunch(
      args.mint.toBase58(),
      buildLaunchSteps(args, deps).steps,
      store,
    );
    expect(resumed.status).toBe("complete");
    // resume must NOT recreate treasury/fee/token
    expect(sent.some((l) => l === "create-treasury")).toBe(false);
    expect(sent.some((l) => l === "collect-launch-fee")).toBe(false);
    expect(sent.some((l) => l === "create-token")).toBe(false);
    expect(sent.some((l) => l.startsWith("create-dao"))).toBe(true);
  });

  it("INV-5 violation (mint authority not null) fails the launch — no silent workaround", async () => {
    const args = makeArgs();
    const deps = makeDeps({
      fetchMintAuthority: vi.fn(async () => Keypair.generate().publicKey),
    });
    const { steps, getResult } = buildLaunchSteps(args, deps);
    const state = await runLaunch(args.mint.toBase58(), steps, new MemoryLaunchStore());
    expect(state.status).toBe("failed");
    expect(state.failedStep).toBe("assert-invariants");
    expect(state.error).toMatch(/INV-5/);
    expect(getResult()).toBeNull();
  });

  it("sole-member mismatch fails the launch (INV-7 shape)", async () => {
    const args = makeArgs();
    const deps = makeDeps({
      fetchMultisigSoleMember: vi.fn(async () => Keypair.generate().publicKey),
    });
    const { steps } = buildLaunchSteps(args, deps);
    const state = await runLaunch(args.mint.toBase58(), steps, new MemoryLaunchStore());
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/INV-7|sole member/);
  });
});
