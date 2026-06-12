/**
 * Browser-signing seam (D-028) — server side.
 *
 * The pure builders + online resolvers now live in the SDK (browser-safe), so
 * the BROWSER can build deposit/vote transactions itself with no server in the
 * path (a decentralized app). This module re-exports them and keeps the HTTP
 * route seam (`GovernanceTxSource` / `RpcGovernanceTxSource`) for the optional
 * read/build backend, delegating to the SDK resolvers.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveCastVoteTx, resolveDepositTx } from "@daofun/sdk";

export {
  buildCastVoteTx,
  buildDepositGoverningTokensTx,
  resolveCastVoteTx,
  resolveDepositTx,
} from "@daofun/sdk";
export type { CastVoteTxParams, DepositTxParams } from "@daofun/sdk";

export interface GovernanceTxSource {
  depositTx(req: {
    realm: PublicKey;
    governingTokenMint: PublicKey;
    wallet: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  }): Promise<{ txBase64: string; tokenOwnerRecord: string }>;
  castVoteTx(req: {
    proposal: PublicKey;
    wallet: PublicKey;
    approve: boolean;
  }): Promise<{ txBase64: string }>;
  submit(signedTxBase64: string): Promise<{ signature: string }>;
}

export class RpcGovernanceTxSource implements GovernanceTxSource {
  constructor(private readonly connection: Connection) {}

  depositTx(req: {
    realm: PublicKey;
    governingTokenMint: PublicKey;
    wallet: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  }): Promise<{ txBase64: string; tokenOwnerRecord: string }> {
    return resolveDepositTx(this.connection, req);
  }

  castVoteTx(req: {
    proposal: PublicKey;
    wallet: PublicKey;
    approve: boolean;
  }): Promise<{ txBase64: string }> {
    return resolveCastVoteTx(this.connection, req);
  }

  async submit(signedTxBase64: string): Promise<{ signature: string }> {
    const signature = await this.connection.sendRawTransaction(
      Buffer.from(signedTxBase64, "base64"),
      { skipPreflight: false },
    );
    return { signature };
  }
}
