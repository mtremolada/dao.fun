/**
 * Browser governance actions (D-028) — the client half of the
 * browser-signing seam. The backend builds UNSIGNED transactions and
 * submits SIGNED bytes; this module only moves base64 between the API
 * and the wallet, so the client bundle carries no chain deps at all.
 *
 * Pure state machine, injected fetch + signer — unit-tested offline.
 */

export interface SignerLike {
  /** base58 wallet address. */
  address: string;
  /** Signs a base64 unsigned tx, returns the base64 signed tx. */
  signTransaction(txBase64: string): Promise<string>;
}

export type FlowPhase = "building" | "signing" | "submitting" | "done" | "error";

export interface FlowState {
  phase: FlowPhase;
  signature?: string;
  error?: string;
}

interface FlowOpts {
  signer: SignerLike;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  onState?: (s: FlowState) => void;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(payload["error"] ?? `HTTP ${res.status}`));
  }
  return payload;
}

/** build (unsigned tx from the API) -> sign (wallet) -> submit (API). */
async function runFlow(
  buildUrl: string,
  buildBody: Record<string, unknown>,
  opts: FlowOpts,
): Promise<FlowState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const api = opts.apiBase ?? "/api";
  const step = (s: FlowState) => {
    opts.onState?.(s);
    return s;
  };
  try {
    step({ phase: "building" });
    const built = await postJson(fetchImpl, `${api}${buildUrl}`, buildBody);
    const txBase64 = String(built["txBase64"] ?? "");
    if (!txBase64) throw new Error("API returned no transaction");

    step({ phase: "signing" });
    const signed = await opts.signer.signTransaction(txBase64);

    step({ phase: "submitting" });
    const submitted = await postJson(fetchImpl, `${api}/chain/txs/submit`, {
      signedTxBase64: signed,
    });
    return step({ phase: "done", signature: String(submitted["signature"]) });
  } catch (e) {
    return step({ phase: "error", error: (e as Error).message });
  }
}

export function castVoteFlow(
  p: { proposal: string; approve: boolean },
  opts: FlowOpts,
): Promise<FlowState> {
  return runFlow(
    "/chain/txs/cast-vote",
    { proposal: p.proposal, wallet: opts.signer.address, approve: p.approve },
    opts,
  );
}

export function depositFlow(
  p: { realm: string; governingTokenMint: string; amount: string },
  opts: FlowOpts,
): Promise<FlowState> {
  return runFlow(
    "/chain/txs/deposit",
    {
      realm: p.realm,
      governingTokenMint: p.governingTokenMint,
      wallet: opts.signer.address,
      amount: p.amount,
    },
    opts,
  );
}
