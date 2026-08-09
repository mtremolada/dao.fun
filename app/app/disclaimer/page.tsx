import { launchpadProgramId } from "../../lib/cluster";
import { PROPOSAL_GATE_PROGRAM_ID } from "@daofun/sdk";

export const metadata = { title: "Disclaimer — dao.fun" };

/**
 * The disclaimer, plus what LAUNCH.md calls L-13: a plain statement of what a
 * user is actually trusting.
 *
 * "The LP is burned" and "the code is on chain" are not the whole truth while
 * somebody can still upgrade the program or move the fee recipient. Those
 * powers are real, they are checkable, and a user who finds out about them
 * later — rather than here — is right to feel misled. So they are named, along
 * with the command that verifies each one, because a claim a reader cannot
 * check is a claim they have to take on faith.
 */
export default function DisclaimerPage() {
  const launchpad = launchpadProgramId().toBase58();
  const gate = PROPOSAL_GATE_PROGRAM_ID.toBase58();

  return (
    <div className="card" style={{ maxWidth: 720, margin: "2rem auto" }}>
      <h1>Disclaimer</h1>
      <p className="muted">
        dao.fun is experimental demo software running on Solana Devnet. Coins
        launched here are testnet tokens with <strong>no monetary value</strong>{" "}
        and cannot be bought or sold for real funds.
      </p>
      <p className="muted">
        Nothing on this site is an offer, solicitation, or investment advice.
        The software is provided as-is, without warranty. Devnet state may be
        reset at any time.
      </p>
      <p className="muted">
        You are responsible for the wallet you connect and the transactions you
        approve. Set your wallet to Solana Devnet before trading.
      </p>

      <h2 style={{ marginTop: "2rem" }}>What you are trusting</h2>
      <p className="muted">
        Most of what this site promises is enforced by programs on chain, which
        you can verify yourself. Some of it is not, and those parts are listed
        here rather than left for you to discover.
      </p>

      <h3>Enforced by the chain</h3>
      <ul className="muted">
        <li>
          <strong>The curve.</strong> Price, fees and the graduation threshold
          are program logic. Nobody can trade against a different curve than
          you do, and nobody can withdraw the raise mid-curve.
        </li>
        <li>
          <strong>The mint.</strong> Mint and freeze authorities are revoked at
          creation. No more supply can appear, and your tokens cannot be frozen.
        </li>
        <li>
          <strong>Graduation liquidity.</strong> On graduation the raise becomes
          Raydium pool liquidity and the LP tokens are burned (or, where a
          locker exists, locked irreversibly). Either way the deposited value
          cannot be withdrawn — check the LP mint&rsquo;s supply yourself.
        </li>
      </ul>

      <h3>Held by people</h3>
      <ul className="muted">
        <li>
          <strong>Upgrade authority</strong> over the launchpad program{" "}
          <code>{launchpad}</code> and the proposal gate <code>{gate}</code>. An
          upgrade can change any rule above. Verify who holds it with{" "}
          <code>solana program show {launchpad}</code> — an authority of{" "}
          <em>none</em> means the program can never change again.
        </li>
        <li>
          <strong>Config authority.</strong> The launchpad&rsquo;s config
          account names the fee recipient, the Raydium fee tier, the lock
          program and the post-graduation split, and its authority can change
          all four. It cannot touch an existing curve&rsquo;s fee split — the
          rate a coin launched under is stored on the coin — but it does apply
          to future launches.
        </li>
        <li>
          <strong>This website.</strong> It reads the chain and builds
          transactions for your wallet to sign. It never holds your keys, and
          every transaction shows you what it does before you approve it — but
          a website you reach over the internet is not the same trust anchor as
          a program on chain. Read what you sign.
        </li>
        <li>
          <strong>The RPC you read through.</strong> A dishonest RPC can show
          you wrong numbers. It cannot make you sign anything you did not
          approve, and it cannot forge a confirmation.
        </li>
      </ul>

      <h3>Not guaranteed at all</h3>
      <ul className="muted">
        <li>
          <strong>That a coin is worth anything.</strong> Anyone can launch
          anything, including a coin whose creator sells everything into your
          buy. The protections above are about the mechanism, not the merit.
        </li>
        <li>
          <strong>That graduation happens promptly.</strong> Migration is
          permissionless — anyone can trigger it — but it only happens when
          somebody does.
        </li>
      </ul>
    </div>
  );
}
