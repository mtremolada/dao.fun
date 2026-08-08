/**
 * The production TxSource: a web3 Connection wrapper. Pulls the program's
 * signatures newest-first (getSignaturesForAddress `until` = our cursor), and
 * reduces each transaction to the inner-instruction data blobs our program
 * emitted via emit_cpi — which is where the events live, not the logs.
 *
 * Kept behind the indexer's TxSource seam so it is the ONLY place that touches
 * an RPC; the indexer itself stays hermetically testable.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { base58Decode } from "../base58";
import type { FetchedTransaction, SignatureRef, TxSource } from "./indexer";

export class RpcTxSource implements TxSource {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
  ) {}

  async fetchSignatures(afterSignature: string | null, limit: number): Promise<SignatureRef[]> {
    const options: { limit: number; until?: string } = { limit };
    if (afterSignature) options.until = afterSignature;
    const infos = await this.connection.getSignaturesForAddress(
      this.programId,
      options,
      "confirmed",
    );
    // Skip failed transactions — they emitted no events.
    return infos
      .filter((i) => i.err === null)
      .map((i) => ({ signature: i.signature, slot: i.slot }));
  }

  async fetchTransaction(signature: string): Promise<FetchedTransaction | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || tx.meta?.err) return null;

    const eventDatas: Buffer[] = [];
    for (const group of tx.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        // Only partially-decoded instructions carry raw base58 `data`.
        const raw = ix as { programId: PublicKey; data?: string };
        if (raw.data && raw.programId.equals(this.programId)) {
          try {
            eventDatas.push(base58Decode(raw.data));
          } catch {
            /* not our event encoding — skip */
          }
        }
      }
    }
    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      eventDatas,
    };
  }
}
