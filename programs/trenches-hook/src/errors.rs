use anchor_lang::prelude::*;

/// Error names are fixed: the launch page (research/page_content.json) is keyed on them.
#[error_code]
pub enum HookError {
    #[msg("Destination token account would be over the current cap")]
    WalletCapExceeded,
    #[msg("Rule config is frozen: already initialized, or the change would tighten / re-enable it")]
    ConfigFrozen,
    #[msg("Signer is not the configured authority")]
    Unauthorized,
    #[msg("Invalid cap schedule or init arguments")]
    InvalidCapSchedule,
    #[msg("Hook invoked outside a Token-2022 transfer (transferring flag not set)")]
    NotTransferring,
    #[msg("Mint or token account is not a Token-2022 account of a mint hooked to this program")]
    InvalidMint,
}
