use anchor_lang::prelude::*;

pub const GLOBAL_SEED: &[u8] = b"global";
pub const CONFIG_SEED: &[u8] = b"config";
pub const LIFT_SEED: &[u8] = b"lift";
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";
/// Per-mint buy rules (v2 mints only): max single buy, max bought per slot, Nth-buy pot counter.
pub const RULES_SEED: &[u8] = b"rules";
/// Pot winners kept on chain (ring buffer); every win is also logged and emitted as an event.
pub const POT_WINNERS: usize = 16;
/// Nth-buy pot: allowed range for "every N qualifying buys".
pub const POT_EVERY_MIN: u32 = 10;
pub const POT_EVERY_MAX: u32 = 100_000;
/// Opening window for the buy limits (slots); 0 means the whole bonding curve.
pub const RULES_WINDOW_MAX: u64 = 1_000_000;
pub const MAX_EXEMPT: usize = 4;

pub const SCOPE_GLOBAL: u8 = 0;
pub const SCOPE_MINT_LIFT: u8 = 1;
pub const SCOPE_MINT_RAISE: u8 = 2;

/// Meteora Dynamic Bonding Curve program (same id on devnet and mainnet).
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC pool authority = PDA(["pool_authority"], DBC). Owner of every DBC pool vault.
/// Derivation checked in tests (not trusted as typed).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora DAMM v2 (cp-amm) program.
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DAMM v2 pool authority = PDA(["pool_authority"], DAMM v2). Owner of DAMM v2 vaults (migration target).
pub const DAMM_V2_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exempt_pdas_derive_from_meteora_programs() {
        let (dbc, _) = Pubkey::find_program_address(&[b"pool_authority"], &DBC_PROGRAM_ID);
        assert_eq!(dbc, DBC_POOL_AUTHORITY);
        let (damm, _) = Pubkey::find_program_address(&[b"pool_authority"], &DAMM_V2_PROGRAM_ID);
        assert_eq!(damm, DAMM_V2_POOL_AUTHORITY);
    }
}
