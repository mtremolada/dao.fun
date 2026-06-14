/**
 * Enhanced-listing backend sources (D-036) — the network/chain half of the
 * claim-verification layer; the pure logic (interpretEtiOrders, the claim
 * signature) lives in the sdk. Two adapters behind interfaces, like the
 * holder-snapshot sources:
 *
 *  - DexScreenerOrdersSource: GET /orders/v1/{chainId}/{mint} -> delivery
 *    state. Only an `approved` tokenProfile order is a live enhanced listing;
 *    malformed/unknown records fail CLOSED (never counted as live).
 *
 *  - OnChainPaymentVerifier: resolves competing claims. It re-reads the
 *    claimant's payment transaction and checks it was sent FROM the claim's
 *    payer (a signer), for >= the configured minimum, within a time window of
 *    the Orders API paymentTimestamp. An impostor who never paid cannot point
 *    at a tx that is BOTH signed by their wallet AND an outflow from it.
 *
 * Destination (D-038): DEX Screener settles through Helio, whose Solana
 * recipient is NOT a stable address, so the verifier does NOT gate on where
 * the SOL went. The automated checks are ownership + amount + time window; the
 * payment's recipients are surfaced (informational) so the DAO checks "the
 * rest" before voting. Delivery (an approved tokenProfile order exists) already
 * proves the listing was paid and is live, and the reimbursement is capped
 * on-chain (INV-12), so a coincidental outflow still cannot overpay.
 */
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  decodeClaimSubmission,
  interpretEtiOrders,
  verifyClaimSignature,
  type EnhancedListingClaim,
  type EtiDeliveryState,
  type EtiOrder,
  type EtiOrderStatus,
  type EtiOrderType,
} from "@daofun/sdk";

const DEXSCREENER_API = "https://api.dexscreener.com";
const ORDER_TYPES = new Set<string>([
  "tokenProfile",
  "communityTakeover",
  "tokenAd",
  "trendingBarAd",
]);
const ORDER_STATUSES = new Set<string>([
  "processing",
  "cancelled",
  "on-hold",
  "approved",
  "rejected",
]);

export interface EtiOrdersSource {
  deliveryState(mint: PublicKey): Promise<EtiDeliveryState>;
}

export interface DexScreenerConfig {
  baseUrl?: string;
  chainId?: string;
  fetchImpl?: typeof fetch;
}

export class DexScreenerOrdersSource implements EtiOrdersSource {
  private readonly baseUrl: string;
  private readonly chainId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: DexScreenerConfig = {}) {
    this.baseUrl = cfg.baseUrl ?? DEXSCREENER_API;
    this.chainId = cfg.chainId ?? "solana";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async deliveryState(mint: PublicKey): Promise<EtiDeliveryState> {
    const url = `${this.baseUrl}/orders/v1/${this.chainId}/${mint.toBase58()}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`dexscreener orders: HTTP ${res.status}`);
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("dexscreener orders: expected an array of orders");
    }
    const orders: EtiOrder[] = [];
    for (const item of raw) {
      const rec = item as Record<string, unknown>;
      // Fail closed: a record we cannot fully parse never counts as live.
      if (typeof rec["type"] !== "string" || !ORDER_TYPES.has(rec["type"])) {
        continue;
      }
      if (
        typeof rec["status"] !== "string" ||
        !ORDER_STATUSES.has(rec["status"])
      ) {
        continue;
      }
      orders.push({
        type: rec["type"] as EtiOrderType,
        status: rec["status"] as EtiOrderStatus,
        ...(typeof rec["paymentTimestamp"] === "number"
          ? { paymentTimestamp: rec["paymentTimestamp"] }
          : {}),
      });
    }
    return interpretEtiOrders(orders);
  }
}

export interface PaymentVerifyConfig {
  /** Minimum SOL outflow from the payer to count (lamports). */
  minPaymentLamports?: bigint;
  /** If the listing is paid in USDC-SPL: the mint and the minimum (base units). */
  usdcMint?: PublicKey;
  minPaymentUsdc?: bigint;
  /** Max |tx.blockTime - claim.paymentTimestamp| in seconds (default 3600). */
  timeWindowSeconds?: number;
}

export interface PaymentVerification {
  /** All REQUIRED checks passed: ownership (signer) + amount + time window. */
  ok: boolean;
  signerMatches: boolean;
  amountSufficient: boolean;
  withinTimeWindow: boolean;
  observedOutflowLamports: bigint;
  observedUsdcOutflow: bigint;
  blockTime: number | null;
  /**
   * Where the SOL went (accounts other than the payer that gained lamports) —
   * NOT gated (the DEX Screener/Helio recipient is not a stable address, D-038),
   * surfaced so the DAO can eyeball "the rest" before voting.
   */
  recipients: { address: string; lamports: bigint }[];
  reasons: string[];
}

export class OnChainPaymentVerifier {
  private readonly timeWindow: number;

  constructor(
    private readonly connection: Connection,
    private readonly cfg: PaymentVerifyConfig = {},
  ) {
    this.timeWindow = cfg.timeWindowSeconds ?? 3600;
  }

  async verify(claim: EnhancedListingClaim): Promise<PaymentVerification> {
    const base = {
      signerMatches: false,
      amountSufficient: false,
      withinTimeWindow: false,
      observedOutflowLamports: 0n,
      observedUsdcOutflow: 0n,
      blockTime: null as number | null,
      recipients: [] as { address: string; lamports: bigint }[],
    };

    const tx = await this.connection.getParsedTransaction(claim.paymentTxSig, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return { ...base, ok: false, reasons: ["payment tx not found or not finalized"] };
    }
    if (tx.meta?.err) {
      return { ...base, ok: false, reasons: ["payment tx failed on-chain"] };
    }

    const reasons: string[] = [];
    const keys = tx.transaction.message.accountKeys;
    const payerB58 = claim.payer.toBase58();
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === payerB58);
    if (idx < 0) {
      return {
        ...base,
        ok: false,
        blockTime: tx.blockTime ?? null,
        reasons: ["payer is not an account in the payment tx"],
      };
    }

    const signerMatches = keys[idx]!.signer === true;
    if (!signerMatches) {
      reasons.push("payer is present but not a signer of the payment tx");
    }

    // SOL outflow from the payer (pre - post). Any tx fee the payer bore only
    // makes this stricter, which is fine for a floor check.
    const pre = tx.meta?.preBalances?.[idx];
    const post = tx.meta?.postBalances?.[idx];
    const observedOutflowLamports =
      pre !== undefined && post !== undefined ? BigInt(pre) - BigInt(post) : 0n;

    const observedUsdcOutflow = this.cfg.usdcMint
      ? this.tokenOutflow(tx, payerB58, this.cfg.usdcMint.toBase58())
      : 0n;

    const amountSufficient = this.amountOk(
      observedOutflowLamports,
      observedUsdcOutflow,
    );
    if (!amountSufficient) {
      reasons.push("payment amount below the configured minimum");
    }

    const blockTime = tx.blockTime ?? null;
    const withinTimeWindow =
      blockTime !== null &&
      Math.abs(blockTime - claim.paymentTimestamp) <= this.timeWindow;
    if (!withinTimeWindow) {
      reasons.push("payment time outside the allowed window of paymentTimestamp");
    }

    // Informational only: accounts (other than the payer) that gained lamports.
    // The community checks whether one is the DEX Screener/Helio processor.
    const recipients = this.recipientsOf(tx, idx);

    const ok = signerMatches && amountSufficient && withinTimeWindow;

    return {
      ok,
      signerMatches,
      amountSufficient,
      withinTimeWindow,
      observedOutflowLamports,
      observedUsdcOutflow,
      blockTime,
      recipients,
      reasons,
    };
  }

  private amountOk(sol: bigint, usdc: bigint): boolean {
    const solOk =
      this.cfg.minPaymentLamports !== undefined &&
      sol >= this.cfg.minPaymentLamports;
    const usdcOk =
      this.cfg.usdcMint !== undefined &&
      this.cfg.minPaymentUsdc !== undefined &&
      usdc >= this.cfg.minPaymentUsdc;
    // Fail closed: with no floor configured we cannot assert the amount.
    if (
      this.cfg.minPaymentLamports === undefined &&
      this.cfg.minPaymentUsdc === undefined
    ) {
      return false;
    }
    return solOk || usdcOk;
  }

  private tokenOutflow(
    tx: ParsedTransactionWithMeta,
    owner: string,
    mint: string,
  ): bigint {
    const sum = (
      arr:
        | {
            owner?: string;
            mint: string;
            uiTokenAmount: { amount: string };
          }[]
        | null
        | undefined,
    ): bigint => {
      let total = 0n;
      for (const b of arr ?? []) {
        if (b.owner === owner && b.mint === mint) {
          total += BigInt(b.uiTokenAmount.amount);
        }
      }
      return total;
    };
    return sum(tx.meta?.preTokenBalances) - sum(tx.meta?.postTokenBalances);
  }

  /**
   * Accounts other than the payer that gained lamports in the tx, largest
   * first — the payment's counterparties, for the community to inspect. Purely
   * informational (never gates the verdict).
   */
  private recipientsOf(
    tx: ParsedTransactionWithMeta,
    payerIdx: number,
  ): { address: string; lamports: bigint }[] {
    const keys = tx.transaction.message.accountKeys;
    const pre = tx.meta?.preBalances ?? [];
    const post = tx.meta?.postBalances ?? [];
    const out: { address: string; lamports: bigint }[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (i === payerIdx) continue;
      const before = pre[i];
      const after = post[i];
      if (before === undefined || after === undefined) continue;
      const delta = BigInt(after) - BigInt(before);
      if (delta > 0n) {
        out.push({ address: keys[i]!.pubkey.toBase58(), lamports: delta });
      }
    }
    return out.sort((a, b) => (b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : 0));
  }
}

// --- Payer-submitted claim verification (D-037) ----------------------------

/**
 * The full verdict on a payer-submitted claim: the three independent legs the
 * payer themselves supply the inputs for. `ok` requires ALL three.
 */
export interface ListingClaimVerification {
  ok: boolean;
  /** The wallet signature proves the claimant controls the bound payer wallet. */
  signatureValid: boolean;
  /** On-chain re-verification of the submitted payment tx hash; null on decode failure. */
  payment: PaymentVerification | null;
  /** DEX Screener delivery state for the mint; null on decode failure. */
  delivery: EtiDeliveryState | null;
  reasons: string[];
}

export interface ListingClaimVerifying {
  verifyClaim(raw: unknown): Promise<ListingClaimVerification>;
}

/**
 * Verifies a claim the PAYER submitted themselves — they hand over BOTH the
 * wallet signature (over the bound challenge) AND the payment tx hash, and this
 * composes the three checks that, together, resolve competing claims:
 *
 *   1. signature  — verifyClaimSignature: the submitter controls the payer wallet;
 *   2. payment    — OnChainPaymentVerifier: that wallet really sent ~the amount
 *                   near the time, in the submitted tx (the tx hash is public, so
 *                   it is only trusted PAIRED with the signature in leg 1);
 *   3. delivery   — the enhanced listing is actually live for the mint.
 *
 * Decode is fail-closed (any malformed field => ok:false with the reason), so a
 * caller cannot smuggle an unsigned/altered field past the bound signature.
 */
export class ListingClaimVerifier implements ListingClaimVerifying {
  constructor(
    private readonly orders: EtiOrdersSource,
    private readonly payment: OnChainPaymentVerifier,
  ) {}

  async verifyClaim(raw: unknown): Promise<ListingClaimVerification> {
    let claim: EnhancedListingClaim;
    let signature: Uint8Array;
    try {
      ({ claim, signature } = decodeClaimSubmission(raw));
    } catch (e) {
      return {
        ok: false,
        signatureValid: false,
        payment: null,
        delivery: null,
        reasons: [(e as Error).message],
      };
    }

    const reasons: string[] = [];

    const signatureValid = verifyClaimSignature(claim, signature);
    if (!signatureValid) {
      reasons.push("wallet signature does not match the payer over the claim");
    }

    const payment = await this.payment.verify(claim);
    if (!payment.ok) reasons.push(...payment.reasons);

    const delivery = await this.orders.deliveryState(claim.mint);
    if (!delivery.live) {
      reasons.push(
        delivery.pending
          ? "enhanced listing is paid but not yet live (pending)"
          : "no live enhanced listing for this mint",
      );
    }

    return {
      ok: signatureValid && payment.ok && delivery.live,
      signatureValid,
      payment,
      delivery,
      reasons,
    };
  }
}

/** JSON-safe form of a verification (PaymentVerification carries bigints). */
export interface PaymentVerificationWire
  extends Omit<
    PaymentVerification,
    "observedOutflowLamports" | "observedUsdcOutflow" | "recipients"
  > {
  observedOutflowLamports: string;
  observedUsdcOutflow: string;
  recipients: { address: string; lamports: string }[];
}

export interface ListingClaimVerificationWire
  extends Omit<ListingClaimVerification, "payment"> {
  payment: PaymentVerificationWire | null;
}

export function toListingClaimVerificationWire(
  v: ListingClaimVerification,
): ListingClaimVerificationWire {
  return {
    ...v,
    payment: v.payment
      ? {
          ...v.payment,
          observedOutflowLamports: v.payment.observedOutflowLamports.toString(),
          observedUsdcOutflow: v.payment.observedUsdcOutflow.toString(),
          recipients: v.payment.recipients.map((r) => ({
            address: r.address,
            lamports: r.lamports.toString(),
          })),
        }
      : null,
  };
}
