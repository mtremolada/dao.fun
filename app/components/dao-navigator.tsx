"use client";

/**
 * Self-service entry hub (D-033). The server-less site has no backend index,
 * so the public opens any DAO or proposal by address from here. Pubkeys are
 * validated client-side; the RPC chooser lives alongside so a visitor can
 * point at their own endpoint before reading the chain.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { daoHref, isPubkey, proposalHref } from "../lib/nav";
import { RpcSettings } from "./rpc-settings";

export function DaoNavigator() {
  const router = useRouter();
  const [realm, setRealm] = useState("");
  const [vault, setVault] = useState("");
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [daoError, setDaoError] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);

  function openDao() {
    if (!isPubkey(realm)) return setDaoError("realm must be a valid pubkey");
    if (!isPubkey(vault)) return setDaoError("vault must be a valid pubkey");
    if (mint.trim() && !isPubkey(mint))
      return setDaoError("mint must be a valid pubkey");
    if (wallet.trim() && !isPubkey(wallet))
      return setDaoError("wallet must be a valid pubkey");
    setDaoError(null);
    router.push(daoHref({ realm, vault, mint, wallet }));
  }

  function openProposal() {
    if (!isPubkey(proposalId))
      return setProposalError("proposal id must be a valid pubkey");
    setProposalError(null);
    router.push(proposalHref(proposalId));
  }

  return (
    <section className="card" data-testid="navigator">
      <h2>Open an existing DAO or proposal</h2>
      <p className="muted">
        No accounts, no backend — paste on-chain addresses to read, verify,
        vote, or deposit. (A DAO&apos;s launch link already carries these.)
      </p>

      <RpcSettings />

      <h3>DAO dashboard</h3>
      <input
        data-testid="nav-realm"
        placeholder="realm address"
        value={realm}
        onChange={(e) => setRealm(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />
      <input
        data-testid="nav-vault"
        placeholder="Squads vault address"
        value={vault}
        onChange={(e) => setVault(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />
      <input
        data-testid="nav-mint"
        placeholder="community mint (optional — needed to deposit)"
        value={mint}
        onChange={(e) => setMint(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />
      <input
        data-testid="nav-wallet"
        placeholder="wallet (optional — show its vote power)"
        value={wallet}
        onChange={(e) => setWallet(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />
      <p>
        <button
          className="button"
          type="button"
          data-testid="nav-open-dao"
          onClick={openDao}
        >
          Open DAO dashboard
        </button>
      </p>
      {daoError && (
        <p className="errors" data-testid="nav-dao-error">
          {daoError}
        </p>
      )}

      <h3>Proposal</h3>
      <input
        data-testid="nav-proposal"
        placeholder="proposal address"
        value={proposalId}
        onChange={(e) => setProposalId(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />
      <p>
        <button
          className="button"
          type="button"
          data-testid="nav-open-proposal"
          onClick={openProposal}
        >
          Open proposal
        </button>
      </p>
      {proposalError && (
        <p className="errors" data-testid="nav-proposal-error">
          {proposalError}
        </p>
      )}
    </section>
  );
}
