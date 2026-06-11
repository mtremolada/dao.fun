/**
 * Re-export of the shared launch-form contract (spec 6.7). The logic lives
 * in @daofun/sdk so the backend re-validates with the SAME functions —
 * client floors are convenience, server floors are the contract. The
 * subpath import keeps chain deps out of the client bundle.
 */
export {
  validateLaunchForm,
  hashBadge,
  executeButtonState,
  type LaunchFormInput,
  type LaunchFormResult,
  type HashBadge,
} from "@daofun/sdk/launch-form";
