/**
 * PRODUCTION backend bootstrap — the full launchpad API against mainnet.
 *
 * Unlike scripts/serve-frontend-mainnet.ts (read-only demo), this wires the
 * REAL launch flow: createApiHandler with durable sqlite stores, the chain
 * reader, the browser-signing tx source, the holder-snapshot source, the auth
 * guard, and a `buildSteps` that drives buildLaunchSteps with a signing
 * sendAndConfirm.
 *
 *   npx tsx scripts/serve-mainnet.ts
 *
 * SAFETY / OPERATOR NOTES (read before exposing this):
 *  - `POST /launches` and `POST /snapshots` are gated by API_AUTH_TOKEN
 *    (Bearer). A launch spends the DEPLOYER wallet (treasury rent + prefund +
 *    launch fee + any dev-buy), so /launches must ALSO sit behind your own
 *    payment / rate-limit layer — never expose it raw to the public internet.
 *  - The public, user-signed routes (GET /chain/*, /artifacts/*,
 *    POST /chain/txs/*) are intentionally open — that is the voting/deposit UI.
 *  - Per-launch mint/createKey/councilMint keypairs are DERIVED deterministically
 *    from SERVER_KEYPAIR_SEED + launchId, so a crashed launch resumes with the
 *    same accounts WITHOUT ever persisting a secret key. Keep that seed secret
 *    and backed up; rotating it orphans in-flight launches (not funds — the
 *    launch fee is charged last, AUDIT F-3).
 *  - This entrypoint cannot be exercised against mainnet in CI; it is
 *    type-checked here and MUST be validated with the Step 8 mainnet smoke test
 *    (one tiny real launch) before public use.
 *
 * Required env: RPC_URL, PROTOCOL_TREASURY, DEPLOYER_KEYPAIR, SERVER_KEYPAIR_SEED,
 *   API_AUTH_TOKEN. Optional: HELIUS_API_KEY, PROTOCOL_LAUNCH_FEE_LAMPORTS,
 *   ARTIFACT_STORE, LAUNCH_STORE, API_PORT, CLUSTER.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { MINT_SIZE, TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  PumpFunRail,
  fetchProgramConfigTreasury,
  resolveGovernanceParams,
  type CouncilSetup,
  type GovernanceMode,
  type LaunchFormInput,
  type LaunchParams,
  type MarketCapTier,
} from "../packages/sdk/src";
import {
  RpcChainReader,
  RpcGovernanceTxSource,
  SqliteArtifactStore,
  SqliteLaunchStore,
  buildLaunchSteps,
  createApiHandler,
  makeHolderSnapshotSource,
  type LaunchStep,
  type LaunchStepDeps,
  type TokenLaunchInput,
} from "../packages/backend/src";

/** Every pump.fun token: 1e9 supply at 6 decimals (drives the threshold floor). */
const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

/** Deterministic, never-persisted per-launch keypair (resumable). */
function launchKeypair(seed: string, launchId: string, role: string): Keypair {
  return Keypair.fromSeed(
    createHmac("sha256", seed).update(`${launchId}:${role}`).digest(),
  );
}

/** Sign with EXACTLY the required signers among the candidates, then confirm. */
async function signSend(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  candidates: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  const msg = tx.compileMessage();
  const requiredKeys = new Set(
    msg.accountKeys
      .slice(0, msg.header.numRequiredSignatures)
      .map((k) => k.toBase58()),
  );
  const signers: Keypair[] = [];
  const added = new Set<string>();
  for (const k of [payer, ...candidates]) {
    const id = k.publicKey.toBase58();
    if (requiredKeys.has(id) && !added.has(id)) {
      signers.push(k);
      added.add(id);
    }
  }
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

async function main() {
  const rpcUrl = required("RPC_URL");
  const protocolTreasury = new PublicKey(required("PROTOCOL_TREASURY"));
  const deployer = loadKeypair(required("DEPLOYER_KEYPAIR"));
  const serverSeed = required("SERVER_KEYPAIR_SEED");
  const apiAuthToken = required("API_AUTH_TOKEN");

  const launchFeeLamports = BigInt(
    process.env.PROTOCOL_LAUNCH_FEE_LAMPORTS ?? "50000000",
  );
  const artifactStoreSpec =
    process.env.ARTIFACT_STORE ?? "sqlite:.data/artifacts.db";
  const launchStoreSpec = process.env.LAUNCH_STORE ?? "sqlite:.data/launches.db";
  const heliusKey = process.env.HELIUS_API_KEY;
  const port = Number(process.env.API_PORT ?? "4404");

  const connection = new Connection(rpcUrl, "confirmed");
  const rail = new PumpFunRail(connection);
  // Council mint rent (MINT_SIZE, no extensions) — fetched once.
  const councilMintRent = BigInt(
    await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
  );

  function buildSteps(
    launchId: string,
    form: LaunchFormInput,
    token?: TokenLaunchInput,
  ): LaunchStep[] {
    if (!token?.name || !token.symbol || !token.uri) {
      return [
        {
          name: "validate-token",
          run: async () => {
            throw new Error("token { name, symbol, uri } is required");
          },
        },
      ];
    }
    const mode = form.mode as GovernanceMode;
    const tier = form.tier as MarketCapTier;
    const governanceParams = resolveGovernanceParams({
      mode,
      tier,
      communitySupply: PUMP_TOTAL_SUPPLY,
      ...(form.sovereignHoldUpSeconds !== undefined
        ? { sovereignHoldUpSeconds: form.sovereignHoldUpSeconds }
        : {}),
    });

    const mintKp = launchKeypair(serverSeed, launchId, "mint");
    const createKeyKp = launchKeypair(serverSeed, launchId, "createKey");
    const councilMintKp = launchKeypair(serverSeed, launchId, "councilMint");
    const members = (form.councilMembers ?? []).map((m) => new PublicKey(m));
    const devBuyLamports =
      token.devBuyLamports !== undefined ? BigInt(token.devBuyLamports) : undefined;

    const launchParams: LaunchParams = {
      metadata: { name: token.name, symbol: token.symbol, uri: token.uri },
      daoConfig: {
        mode,
        marketCapTier: tier,
        ...(members.length > 0 ? { councilMembers: members } : {}),
        ...(form.councilVetoThresholdPercent !== undefined
          ? { councilVetoThresholdPercent: form.councilVetoThresholdPercent }
          : {}),
        ...(form.sovereignHoldUpSeconds !== undefined
          ? { sovereignHoldUpSeconds: form.sovereignHoldUpSeconds }
          : {}),
      },
      ...(devBuyLamports ? { devBuyLamports } : {}),
      rail: "pumpfun",
      launcher: deployer.publicKey,
    };

    const council: CouncilSetup | undefined =
      mode === "council"
        ? {
            mint: councilMintKp.publicKey,
            members,
            vetoThresholdPercent: form.councilVetoThresholdPercent ?? 50,
            mintRentLamports: councilMintRent,
          }
        : undefined;

    const deps: LaunchStepDeps = {
      sendAndConfirm: (ixs) =>
        signSend(connection, ixs, deployer, [mintKp, createKeyKp, councilMintKp]),
      buildCreateTokenIxs: (params, creator) =>
        rail.buildCreateTokenIxs(params, creator, mintKp),
      fetchProgramConfigTreasury: () => fetchProgramConfigTreasury(connection),
      fetchMintAuthority: async (mint) =>
        (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID))
          .mintAuthority,
      fetchMultisigSoleMember: async (multisigPda) => {
        const ms = await multisig.accounts.Multisig.fromAccountAddress(
          connection,
          multisigPda,
        );
        if (ms.members.length !== 1) {
          throw new Error(`multisig has ${ms.members.length} members, expected 1`);
        }
        return ms.members[0]!.key;
      },
    };

    return buildLaunchSteps(
      {
        mint: mintKp.publicKey,
        createKey: createKeyKp.publicKey,
        launcher: deployer.publicKey,
        protocolTreasury,
        launchFeeLamports,
        daoMode: mode,
        governanceParams,
        launchParams,
        ...(council ? { council } : {}),
      },
      deps,
    ).steps;
  }

  const handler = createApiHandler({
    launchStore: SqliteLaunchStore.fromEnv(launchStoreSpec),
    artifactStore: SqliteArtifactStore.fromEnv(artifactStoreSpec),
    chain: new RpcChainReader(connection),
    txs: new RpcGovernanceTxSource(connection),
    snapshot: makeHolderSnapshotSource({
      connection,
      ...(heliusKey
        ? { heliusUrl: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` }
        : {}),
    }),
    authToken: apiAuthToken,
    buildSteps,
  });

  createServer(handler).listen(port, () => {
    console.log(`daofun mainnet api on :${port} (rpc ${rpcUrl})`);
    console.log(`launcher ${deployer.publicKey.toBase58()}`);
    console.log(`protocol-treasury ${protocolTreasury.toBase58()}`);
    console.log(`/launches + /snapshots require Bearer API_AUTH_TOKEN`);
  });
}

void main();
