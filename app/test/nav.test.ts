/**
 * Navigation helpers (D-033): pubkey validation + the trailing-slash query
 * URLs the static export serves. Pure, so unit-tested offline.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { daoHref, isPubkey, proposalHref } from "../lib/nav";

const REALM = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

describe("isPubkey", () => {
  it("accepts a valid base58 pubkey", () => {
    expect(isPubkey(REALM)).toBe(true);
    expect(isPubkey(`  ${REALM}  `)).toBe(true);
  });
  it("rejects empty and malformed input", () => {
    expect(isPubkey("")).toBe(false);
    expect(isPubkey("not-a-key")).toBe(false);
    expect(isPubkey("11111")).toBe(false);
  });
});

describe("daoHref", () => {
  it("includes realm+vault and trailing-slash path", () => {
    expect(daoHref({ realm: REALM, vault: VAULT })).toBe(
      `/dao/?realm=${REALM}&vault=${VAULT}`,
    );
  });
  it("adds optional mint and wallet only when present", () => {
    const href = daoHref({ realm: REALM, vault: VAULT, mint: MINT, wallet: "" });
    expect(href).toContain(`mint=${MINT}`);
    expect(href).not.toContain("wallet=");
  });
});

describe("proposalHref", () => {
  it("targets the trailing-slash proposal route", () => {
    expect(proposalHref("Prop")).toBe("/proposal/?id=Prop");
  });
});
