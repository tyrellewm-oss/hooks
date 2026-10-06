//! trenches-hook: DEVNET-ONLY, UNAUDITED experiment.
//!
//! A Token-2022 transfer hook with exactly ONE rule: a rising per-token-account cap
//! while the token is on the Meteora DBC bonding curve.
//! - Checks only the DESTINATION token account's post-transfer balance.
//! - Never checks the source. Exempt destinations (DBC pool vaults via the DBC
//!   pool authority, DAMM v2 pool authority; no manual exemptions) always pass,
//!   so selling back into the curve is never blocked by this program.
//! - Per-mint config is written once and is immutable. The only mutable rule
//!   state is the lift-only switch (global allow-all, per-mint lift, per-mint raise).
//! - No fees, no custody, no withdraw, no pause, no CPI into Token-2022.
//! - v2 mints (initialize_extra_account_meta_list_v2) add buy rules fixed at launch: a max single buy and a max
//!   bought per slot in an opening window, and an Nth-buy pot counter that records winners (no funds held here).
//!   Rules only ever apply to buys out of a DBC pool vault; sells and graduation are never touched.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_lang::system_program;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        transfer_hook::{TransferHook as TransferHookExt, TransferHookAccount},
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account as TokenAccountState, Mint as MintState},
};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod constants;
pub mod errors;
pub mod state;

use constants::*;
use errors::HookError;
use state::*;

declare_id!("FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz");

#[program]
pub mod trenches_hook {
    use super::*;

    /// One-time: set the lift-switch authority. Only the program's upgrade
    /// authority can call it, and only once (re-init -> ConfigFrozen).
    pub fn initialize_global(ctx: Context<InitializeGlobal>, authority: Pubkey) -> Result<()> {
        require_keys_neq!(authority, Pubkey::default(), HookError::Unauthorized);
        let bump = ctx.bumps.global;
        create_pda_once(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.global.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &[GLOBAL_SEED, &[bump]],
            8 + Global::INIT_SPACE,
        )?;
        let g = Global { authority, lifted: false, bump };
        write_account(&ctx.accounts.global.to_account_info(), &g)?;
        msg!("trenches-hook: global initialized, lift authority={}", authority);
        Ok(())
    }

    /// 8.3, admin-only, once: append `launch_authority` (bytes 42..74) to the 42-byte Global. Bytes 0..42 are
    /// never written. `payer` (any key) pays the rent increase. A second run refuses (ConfigFrozen).
    pub fn migrate_global_v2(ctx: Context<MigrateGlobalV2>, launch_authority: Pubkey) -> Result<()> {
        let g = ctx.accounts.global.to_account_info();
        let (canonical, _) = Pubkey::find_program_address(&[GLOBAL_SEED], &crate::ID);
        require_keys_eq!(g.key(), canonical, HookError::ConfigFrozen);
        require_keys_eq!(*g.owner, crate::ID, HookError::ConfigFrozen);
        let admin = {
            let d = g.try_borrow_data()?;
            require!(d.len() == GLOBAL_V1_LEN || d.len() == GLOBAL_V2_LEN, HookError::ConfigFrozen);
            require!(&d[..8] == Global::DISCRIMINATOR, HookError::ConfigFrozen);
            Pubkey::try_from(&d[8..40]).map_err(|_| error!(HookError::ConfigFrozen))?
        };
        require_keys_eq!(ctx.accounts.authority.key(), admin, HookError::Unauthorized);
        require!(g.data_len() == GLOBAL_V1_LEN, HookError::ConfigFrozen);
        require_keys_neq!(launch_authority, Pubkey::default(), HookError::Unauthorized);
        require_keys_neq!(launch_authority, admin, HookError::Unauthorized);
        let need = Rent::get()?.minimum_balance(GLOBAL_V2_LEN);
        let have = g.lamports();
        if have < need {
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: g.clone() }),
                need - have,
            )?;
        }
        g.resize(GLOBAL_V2_LEN)?;
        g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(launch_authority.as_ref());
        msg!("trenches-hook: global migrated to v2, launch authority={}", launch_authority);
        Ok(())
    }

    /// 8.3, admin-only: rotate the launch key (bytes 42..74). Refuses the admin key, the zero key and the current
    /// launch key (a rotation that changes nothing). After rotation the old key refuses on the launch path.
    pub fn set_launch_authority(ctx: Context<SetLaunchAuthority>, new_launch_authority: Pubkey) -> Result<()> {
        let admin = ctx.accounts.global.authority;
        let g = ctx.accounts.global.to_account_info();
        require!(g.data_len() == GLOBAL_V2_LEN, HookError::ConfigFrozen);
        require_keys_neq!(new_launch_authority, Pubkey::default(), HookError::Unauthorized);
        require_keys_neq!(new_launch_authority, admin, HookError::Unauthorized);
        let current = launch_authority_of(&g.try_borrow_data()?);
        require!(current != Some(new_launch_authority), HookError::ConfigFrozen);
        g.try_borrow_mut_data()?[GLOBAL_V1_LEN..GLOBAL_V2_LEN].copy_from_slice(new_launch_authority.as_ref());
        msg!("trenches-hook: launch authority rotated from={:?} to={}", current, new_launch_authority);
        Ok(())
    }

    /// 8.3b, admin-only: rotate the Global admin key at bytes 8..40. Those 32 bytes are the only write.
    /// Legal only after 8.3's migration, with a set launch key. Refuses the zero key, the current admin, and the
    /// launch key. Does not change the program upgrade authority.
    pub fn rotate_admin(ctx: Context<RotateAdmin>, new_authority: Pubkey) -> Result<()> {
        let g = ctx.accounts.global.to_account_info();
        let (canonical, _) = Pubkey::find_program_address(&[GLOBAL_SEED], &crate::ID);
        require_keys_eq!(g.key(), canonical, HookError::Unauthorized);
        require_keys_eq!(*g.owner, crate::ID, HookError::Unauthorized);
        let (admin, launch) = {
            let d = g.try_borrow_data()?;
            require!(d.len() >= 8 && &d[..8] == Global::DISCRIMINATOR, HookError::Unauthorized);
            require!(d.len() == GLOBAL_V2_LEN, HookError::ConfigFrozen);
            let admin = Pubkey::try_from(&d[8..40]).map_err(|_| error!(HookError::Unauthorized))?;
            let launch = launch_authority_of(&d).ok_or(error!(HookError::ConfigFrozen))?;
            (admin, launch)
        };
        require!(ctx.accounts.authority.key() == admin, HookError::Unauthorized);
        require_keys_neq!(new_authority, Pubkey::default(), HookError::ConfigFrozen);
        require_keys_neq!(new_authority, admin, HookError::ConfigFrozen);
        require_keys_neq!(new_authority, launch, HookError::ConfigFrozen);
        // 32 bytes at offset 8 only. Not write_account: a full serialize would be the clobber mutant.
        g.try_borrow_mut_data()?[8..40].copy_from_slice(new_authority.as_ref());
        msg!("trenches-hook: admin rotated to={}", new_authority);
        Ok(())
    }

    /// Per-mint setup (the transfer-hook InitializeExtraAccountMetaList step):
    /// writes the immutable cap config, the lift state and the extra-account-meta
    /// list. Signed by the launch key (Global bytes 42..74, 8.3), never the admin. Runs once per mint.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        args: InitConfigArgs,
    ) -> Result<()> {
        let a = &ctx.accounts;
        init_mint(
            &a.payer.to_account_info(), &a.authority, &a.global, &a.mint.to_account_info(),
            &a.extra_account_meta_list, &a.config, &a.lift, &a.system_program.to_account_info(),
            (ctx.bumps.extra_account_meta_list, ctx.bumps.config, ctx.bumps.lift), &args, &extra_metas()?,
        )?;
        Ok(())
    }

    /// v2 per-mint setup: everything v1 does, plus the buy rules (max single buy, max bought per slot, Nth-buy pot)
    /// in a fourth PDA that the transfer hook reads and updates (a 4th, writable extra account). Same signer rules.
    pub fn initialize_extra_account_meta_list_v2(
        ctx: Context<InitializeExtraAccountMetaListV2>,
        args: InitConfigArgs,
        rules: RulesArgs,
    ) -> Result<()> {
        let a = &ctx.accounts;
        let cfg = init_mint(
            &a.payer.to_account_info(), &a.authority, &a.global, &a.mint.to_account_info(),
            &a.extra_account_meta_list, &a.config, &a.lift, &a.system_program.to_account_info(),
            (ctx.bumps.extra_account_meta_list, ctx.bumps.config, ctx.bumps.lift), &args, &extra_metas_v2()?,
        )?;
        validate_rules(&rules, cfg.supply_ref)?;
        let mint_key = a.mint.key();
        create_pda_once(&a.payer.to_account_info(), &a.rules, &a.system_program.to_account_info(),
            &[RULES_SEED, mint_key.as_ref(), &[ctx.bumps.rules]], 8 + RulesState::INIT_SPACE)?;
        let st = RulesState {
            mint: mint_key, bump: ctx.bumps.rules, launch_slot: cfg.launch_slot,
            max_buy_tokens: rules.max_buy_tokens, max_per_slot_tokens: rules.max_per_slot_tokens, window_slots: rules.window_slots,
            pot_every: rules.pot_every, pot_min_tokens: rules.pot_min_tokens,
            cur_slot: 0, bought_in_slot: 0, buy_count: 0, last_counted_slot: 0, wins: 0,
            winners: [PotWin::default(); POT_WINNERS],
        };
        write_account(&a.rules, &st)?;
        msg!("rules: mint={} max_buy={} max_per_slot={} window_slots={} pot_every={} pot_min={}",
            mint_key, st.max_buy_tokens, st.max_per_slot_tokens, st.window_slots, st.pot_every, st.pot_min_tokens);
        Ok(())
    }

    /// Transfer-hook Execute. The ONE rule: destination post-transfer balance <= cap.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let mint_key = ctx.accounts.mint.key();
        // Mint: Token-2022, hook points at us.
        {
            let info = ctx.accounts.mint.to_account_info();
            require_keys_eq!(*info.owner, spl_token_2022::ID, HookError::InvalidMint);
            let data = info.try_borrow_data()?;
            let mint = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(HookError::InvalidMint))?;
            let ext = mint.get_extension::<TransferHookExt>().map_err(|_| error!(HookError::InvalidMint))?;
            let pid: Option<Pubkey> = ext.program_id.into();
            require!(pid == Some(crate::ID), HookError::InvalidMint);
        }
        // Source: Token-2022 account of this mint, currently transferring
        // (rejects direct invocation of the hook outside a real transfer).
        let source_owner = {
            let info = ctx.accounts.source_token.to_account_info();
            require_keys_eq!(*info.owner, spl_token_2022::ID, HookError::InvalidMint);
            let data = info.try_borrow_data()?;
            let src = StateWithExtensions::<TokenAccountState>::unpack(&data).map_err(|_| error!(HookError::NotTransferring))?;
            require_keys_eq!(src.base.mint, mint_key, HookError::InvalidMint);
            let ext = src.get_extension::<TransferHookAccount>().map_err(|_| error!(HookError::NotTransferring))?;
            require!(bool::from(ext.transferring), HookError::NotTransferring);
            src.base.owner
        };
        // Destination: Token-2022 account of this mint (post-transfer state).
        let (dest_owner, dest_balance) = {
            let info = ctx.accounts.destination_token.to_account_info();
            require_keys_eq!(*info.owner, spl_token_2022::ID, HookError::InvalidMint);
            let data = info.try_borrow_data()?;
            let dst = StateWithExtensions::<TokenAccountState>::unpack(&data).map_err(|_| error!(HookError::InvalidMint))?;
            require_keys_eq!(dst.base.mint, mint_key, HookError::InvalidMint);
            (dst.base.owner, dst.base.amount)
        };
        let cfg = &ctx.accounts.config;
        let exempt = is_exempt(cfg, &dest_owner);
        let slot = Clock::get()?.slot;
        let cap = cap_math::effective_cap(&cfg.cap_config(), &ctx.accounts.lift.to_lift(), ctx.accounts.global.lifted, slot);
        match cap_math::decide(exempt, cap, dest_balance) {
            cap_math::Decision::Allow => {
                // v2 mints carry a 4th extra account (the rules PDA); Token-2022 always passes it for them.
                let v2 = ctx.accounts.extra_account_meta_list.data_len() == ExtraAccountMetaList::size_of(4)?;
                match (v2, ctx.remaining_accounts.first()) {
                    (false, _) => Ok(()),
                    (true, None) => err!(HookError::InvalidRules),
                    (true, Some(rules)) => apply_rules(rules, &mint_key, &source_owner, &dest_owner,
                        &ctx.accounts.destination_token.key(), amount, slot),
                }
            }
            cap_math::Decision::Reject { cap } => {
                let next = cap_math::next_change(&cfg.cap_config(), slot);
                msg!(
                    "WalletCapExceeded: token_account={} owner={} balance={} cap={} slot={} next_change={:?}",
                    ctx.accounts.destination_token.key(), dest_owner, dest_balance, cap, slot, next
                );
                err!(HookError::WalletCapExceeded)
            }
        }
    }

    /// Lift-only switch (global): every transfer of every mint is allowed from now on. One-way.
    pub fn lift_global(ctx: Context<LiftGlobal>) -> Result<()> {
        let g = &mut ctx.accounts.global;
        require!(!g.lifted, HookError::ConfigFrozen);
        g.lifted = true;
        let slot = Clock::get()?.slot;
        msg!("RestrictionsLifted: scope=global slot={} signer={}", slot, ctx.accounts.authority.key());
        emit!(RestrictionsLifted {
            scope: SCOPE_GLOBAL, mint: Pubkey::default(), old_floor_bps: 0, new_floor_bps: cap_math::BPS_DENOM,
            lifted: true, slot, signer: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Lift-only switch (per mint): remove this mint's cap. One-way.
    pub fn lift_mint_cap(ctx: Context<LiftMint>) -> Result<()> {
        let lift = &mut ctx.accounts.lift;
        let old = lift.to_lift();
        let new = cap_math::apply_lift(&old).map_err(|_| error!(HookError::ConfigFrozen))?;
        lift.lifted = new.lifted;
        let slot = Clock::get()?.slot;
        msg!("RestrictionsLifted: scope=mint mint={} lifted=true slot={} signer={}", lift.mint, slot, ctx.accounts.authority.key());
        emit!(RestrictionsLifted {
            scope: SCOPE_MINT_LIFT, mint: lift.mint, old_floor_bps: old.raised_floor_bps, new_floor_bps: cap_math::BPS_DENOM,
            lifted: true, slot, signer: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Lift-only switch (per mint): raise the minimum cap to `new_floor_bps`.
    /// Must be strictly higher than any earlier raise; can never lower.
    pub fn raise_mint_cap(ctx: Context<LiftMint>, new_floor_bps: u16) -> Result<()> {
        let lift = &mut ctx.accounts.lift;
        let old = lift.to_lift();
        let new = cap_math::apply_raise(&old, new_floor_bps).map_err(|_| error!(HookError::ConfigFrozen))?;
        lift.lifted = new.lifted;
        lift.raised_floor_bps = new.raised_floor_bps;
        let slot = Clock::get()?.slot;
        msg!("RestrictionsLifted: scope=mint-raise mint={} old_floor_bps={} new_floor_bps={} slot={} signer={}",
            lift.mint, old.raised_floor_bps, new_floor_bps, slot, ctx.accounts.authority.key());
        emit!(RestrictionsLifted {
            scope: SCOPE_MINT_RAISE, mint: lift.mint, old_floor_bps: old.raised_floor_bps, new_floor_bps,
            lifted: new.lifted, slot, signer: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    /// Read-only view (simulate it): logs and returns the active schedule, the
    /// build profile (test_slots_build) and the current effective cap.
    pub fn view_schedule(ctx: Context<ViewSchedule>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let slot = Clock::get()?.slot;
        let cap = cap_math::effective_cap(&cfg.cap_config(), &ctx.accounts.lift.to_lift(), ctx.accounts.global.lifted, slot);
        log_schedule(cfg);
        msg!("view: slot={} effective_cap={:?} mint_lifted={} raised_floor_bps={} global_lifted={}",
            slot, cap, ctx.accounts.lift.lifted, ctx.accounts.lift.raised_floor_bps, ctx.accounts.global.lifted);
        let view = ScheduleView {
            mint: cfg.mint, launch_slot: cfg.launch_slot, supply_ref: cfg.supply_ref,
            steps: cfg.steps[..cfg.step_count as usize].to_vec(), uncapped_after: cfg.uncapped_after,
            test_slots_build: cfg.test_slots_build, program_built_with_test_slots: cfg!(feature = "test-slots"),
            slot, effective_cap: cap, mint_lifted: ctx.accounts.lift.lifted,
            raised_floor_bps: ctx.accounts.lift.raised_floor_bps, global_lifted: ctx.accounts.global.lifted,
        };
        set_return_data(&view.try_to_vec()?);
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn init_mint<'info>(
    payer: &AccountInfo<'info>,
    authority: &Signer<'info>,
    global: &Account<'info, Global>,
    mint: &AccountInfo<'info>,
    extra_account_meta_list: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    lift: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
    bumps: (u8, u8, u8),
    args: &InitConfigArgs,
    metas: &[ExtraAccountMeta],
) -> Result<MintConfig> {
    // 8.3: (a) Global migrated (74 bytes), (b) launch key set, (c) signer == launch key, (d) signer != admin.
    {
        let g = global.to_account_info();
        require!(g.data_len() == GLOBAL_V2_LEN, HookError::Unauthorized);
        let launch = launch_authority_of(&g.try_borrow_data()?).ok_or(error!(HookError::Unauthorized))?;
        require_keys_eq!(authority.key(), launch, HookError::Unauthorized);
        require_keys_neq!(authority.key(), global.authority, HookError::Unauthorized);
    }
    let mint_key = mint.key();
    // Mint must be a Token-2022 mint whose TransferHook points at this program.
    let supply = {
        let info = mint.clone();
        require_keys_eq!(*info.owner, spl_token_2022::ID, HookError::InvalidMint);
        let data = info.try_borrow_data()?;
        let mint = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(HookError::InvalidMint))?;
        let ext = mint.get_extension::<TransferHookExt>().map_err(|_| error!(HookError::InvalidMint))?;
        let pid: Option<Pubkey> = ext.program_id.into();
        require!(pid == Some(crate::ID), HookError::InvalidMint);
        mint.base.supply
    };
    // Reference supply = the mint's actual supply at init (must be minted first).
    require!(supply > 0 && args.supply_ref == supply, HookError::InvalidCapSchedule);
    // QA H-1: no caller-supplied exemptions. The only exempt receivers are the
    // DBC and DAMM v2 pool authority PDAs (constants, derived from the Meteora
    // program ids). The field stays in the args/account layout but must be empty.
    if !args.exempt_owners.is_empty() {
        msg!("InvalidCapSchedule: exempt_owners must be empty (no manual exemptions)");
        return err!(HookError::InvalidCapSchedule);
    }

    let steps: Vec<cap_math::Step> = args
        .steps
        .iter()
        .map(|s| cap_math::Step { slot_offset: s.slot_offset, max_bps: s.max_bps })
        .collect();
    let launch_slot = Clock::get()?.slot;
    let cc = cap_math::CapConfig::new(launch_slot, supply, &steps, args.uncapped_after)
        .map_err(|_| error!(HookError::InvalidCapSchedule))?;
    cap_math::validate(&cc, build_limits()).map_err(|e| {
        msg!("InvalidCapSchedule: {:?}", e);
        error!(HookError::InvalidCapSchedule)
    })?;

    // --- create the three PDAs (fails with ConfigFrozen if any already exists)
    let meta_size = ExtraAccountMetaList::size_of(metas.len())?;
    create_pda_once(payer, extra_account_meta_list, sys,
        &[EXTRA_METAS_SEED, mint_key.as_ref(), &[bumps.0]], meta_size)?;
    create_pda_once(payer, config, sys,
        &[CONFIG_SEED, mint_key.as_ref(), &[bumps.1]], 8 + MintConfig::INIT_SPACE)?;
    create_pda_once(payer, lift, sys,
        &[LIFT_SEED, mint_key.as_ref(), &[bumps.2]], 8 + LiftState::INIT_SPACE)?;

    {
        let mut data = extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, metas)?;
    }
    let mut exempt = [Pubkey::default(); MAX_EXEMPT];
    exempt[..args.exempt_owners.len()].copy_from_slice(&args.exempt_owners);
    let mut st = [StepData::default(); cap_math::MAX_STEPS];
    for (i, s) in cc.active_steps().iter().enumerate() {
        st[i] = StepData { slot_offset: s.slot_offset, max_bps: s.max_bps };
    }
    let cfg = MintConfig {
        mint: mint_key,
        launch_slot,
        supply_ref: supply,
        steps: st,
        step_count: cc.step_count,
        uncapped_after: args.uncapped_after,
        exempt_owners: exempt,
        exempt_count: args.exempt_owners.len() as u8,
        test_slots_build: cfg!(feature = "test-slots"),
        launcher: authority.key(),
        bump: bumps.1,
    };
    write_account(config, &cfg)?;
    write_account(lift, &LiftState { mint: mint_key, lifted: false, raised_floor_bps: 0, bump: bumps.2 })?;
    msg!("trenches-hook: config frozen for mint={} launch_slot={} supply={} test_slots_build={}",
        mint_key, launch_slot, supply, cfg.test_slots_build);
    log_schedule(&cfg);
    Ok(cfg)
}

pub fn build_limits() -> cap_math::Limits {
    if cfg!(feature = "test-slots") { cap_math::TEST_SLOTS_LIMITS } else { cap_math::RELEASE_LIMITS }
}

pub fn is_exempt(cfg: &MintConfig, dest_owner: &Pubkey) -> bool {
    *dest_owner == DBC_POOL_AUTHORITY
        || *dest_owner == DAMM_V2_POOL_AUTHORITY
        || cfg.exempt_owners[..(cfg.exempt_count as usize).min(MAX_EXEMPT)].contains(dest_owner) // always empty since QA H-1 fix
}

pub fn extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    // Execute account order: 0 source, 1 mint, 2 destination, 3 owner, 4 extra-metas list,
    // then 5 config, 6 lift, 7 global (all PDAs of this program, read-only).
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: CONFIG_SEED.to_vec() }, Seed::AccountKey { index: 1 }], false, false)?,
        ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: LIFT_SEED.to_vec() }, Seed::AccountKey { index: 1 }], false, false)?,
        ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: GLOBAL_SEED.to_vec() }], false, false)?,
    ])
}

/// v2 extra metas: v1's three, then the rules PDA (writable: the hook updates its counters).
pub fn extra_metas_v2() -> Result<Vec<ExtraAccountMeta>> {
    let mut m = extra_metas()?;
    m.push(ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: RULES_SEED.to_vec() }, Seed::AccountKey { index: 1 }], false, true)?);
    Ok(m)
}

pub fn validate_rules(r: &RulesArgs, supply: u64) -> Result<()> {
    let pot_ok = r.pot_every == 0 || (POT_EVERY_MIN..=POT_EVERY_MAX).contains(&r.pot_every);
    let any = r.max_buy_tokens > 0 || r.max_per_slot_tokens > 0 || r.pot_every > 0;
    let ok = any && pot_ok
        && r.max_buy_tokens <= supply && r.max_per_slot_tokens <= supply && r.pot_min_tokens <= supply
        && r.window_slots <= RULES_WINDOW_MAX;
    if !ok {
        msg!("InvalidRules: max_buy={} max_per_slot={} window={} pot_every={} pot_min={} supply={}",
            r.max_buy_tokens, r.max_per_slot_tokens, r.window_slots, r.pot_every, r.pot_min_tokens, supply);
        return err!(HookError::InvalidRules);
    }
    Ok(())
}

/// A buy is a transfer out of a DBC pool vault (owner = DBC pool authority) to anyone but a pool authority
/// (the graduation path vault -> DAMM v2 is not a buy). Sells and wallet-to-wallet transfers are never touched.
pub fn is_curve_buy(source_owner: &Pubkey, dest_owner: &Pubkey) -> bool {
    *source_owner == DBC_POOL_AUTHORITY && *dest_owner != DBC_POOL_AUTHORITY && *dest_owner != DAMM_V2_POOL_AUTHORITY
}

fn apply_rules(rules: &AccountInfo, mint: &Pubkey, source_owner: &Pubkey, dest_owner: &Pubkey, dest_token: &Pubkey, amount: u64, slot: u64) -> Result<()> {
    require_keys_eq!(*rules.owner, crate::ID, HookError::InvalidRules);
    require!(rules.is_writable, HookError::InvalidRules);
    let mut r = {
        let data = rules.try_borrow_data()?;
        RulesState::try_deserialize(&mut &data[..]).map_err(|_| error!(HookError::InvalidRules))?
    };
    require_keys_eq!(r.mint, *mint, HookError::InvalidRules);
    let expected = Pubkey::create_program_address(&[RULES_SEED, mint.as_ref(), &[r.bump]], &crate::ID)
        .map_err(|_| error!(HookError::InvalidRules))?;
    require_keys_eq!(rules.key(), expected, HookError::InvalidRules);
    if !is_curve_buy(source_owner, dest_owner) {
        return Ok(());
    }
    let in_window = r.window_slots == 0 || slot <= r.launch_slot.saturating_add(r.window_slots);
    if in_window && r.max_buy_tokens > 0 && amount > r.max_buy_tokens {
        msg!("MaxBuyExceeded: token_account={} owner={} amount={} max={} slot={}", dest_token, dest_owner, amount, r.max_buy_tokens, slot);
        return err!(HookError::MaxBuyExceeded);
    }
    if in_window && r.max_per_slot_tokens > 0 {
        if r.cur_slot != slot {
            r.cur_slot = slot;
            r.bought_in_slot = 0;
        }
        let total = r.bought_in_slot.saturating_add(amount);
        if total > r.max_per_slot_tokens {
            msg!("SlotBuyLimitExceeded: slot={} bought={} amount={} max={}", slot, r.bought_in_slot, amount, r.max_per_slot_tokens);
            return err!(HookError::SlotBuyLimitExceeded);
        }
        r.bought_in_slot = total;
    }
    // Nth-buy pot: one count per slot at most (the first qualifying buy in a slot), never random.
    if r.pot_every > 0 && amount >= r.pot_min_tokens && slot != r.last_counted_slot {
        r.buy_count = r.buy_count.saturating_add(1);
        r.last_counted_slot = slot;
        if r.buy_count % (r.pot_every as u64) == 0 {
            let i = (r.wins % POT_WINNERS as u64) as usize;
            r.winners[i] = PotWin { owner: *dest_owner, token_account: *dest_token, buy_index: r.buy_count, slot };
            r.wins = r.wins.saturating_add(1);
            msg!("PotWin: mint={} owner={} token_account={} buy_index={} slot={}", mint, dest_owner, dest_token, r.buy_count, slot);
            emit!(PotWon { mint: *mint, owner: *dest_owner, token_account: *dest_token, buy_index: r.buy_count, slot });
        }
    }
    let mut data = rules.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    r.try_serialize(&mut cursor)?;
    Ok(())
}

fn log_schedule(cfg: &MintConfig) {
    msg!("schedule: mint={} launch_slot={} supply_ref={} uncapped_after={} test_slots_build={}",
        cfg.mint, cfg.launch_slot, cfg.supply_ref, cfg.uncapped_after, cfg.test_slots_build);
    for s in &cfg.steps[..cfg.step_count as usize] {
        msg!("schedule step: offset={} max_bps={}", s.slot_offset, s.max_bps);
    }
    let l = build_limits();
    msg!("build: profile={} min_step_slots={} min_ramp_slots={}",
        if cfg!(feature = "test-slots") { "TEST-SLOTS(local only)" } else { "release" }, l.min_step_slots, l.min_ramp_slots);
}

/// Create a PDA owned by this program exactly once. If it is already owned by
/// this program -> ConfigFrozen. Handles pre-funded (griefed) system accounts.
fn create_pda_once<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
) -> Result<()> {
    if *target.owner == crate::ID || !target.data_is_empty() {
        return err!(HookError::ConfigFrozen);
    }
    require_keys_eq!(*target.owner, system_program::ID, HookError::ConfigFrozen);
    let rent = Rent::get()?.minimum_balance(space);
    let signer: &[&[&[u8]]] = &[seeds];
    let have = target.lamports();
    if have < rent {
        system_program::transfer(
            CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: target.clone() }),
            rent - have,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(system.clone(), system_program::Allocate { account_to_allocate: target.clone() }, signer),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(system.clone(), system_program::Assign { account_to_assign: target.clone() }, signer),
        &crate::ID,
    )?;
    Ok(())
}

fn write_account<T: AccountSerialize>(info: &AccountInfo, v: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    v.try_serialize(&mut cursor)?;
    Ok(())
}

// ---------------- accounts

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: created here once (PDA ["global"]).
    #[account(mut, seeds = [GLOBAL_SEED], bump)]
    pub global: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HookError::Unauthorized)]
    pub program: Program<'info, crate::program::TrenchesHook>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ HookError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Launcher: must be the launch key in Global bytes 42..74 (checked in the handler, 8.3), never the admin.
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
    /// CHECK: validated in the handler (Token-2022 mint with TransferHook -> this program).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: created here once (PDA ["extra-account-metas", mint]).
    #[account(mut, seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    /// CHECK: created here once (PDA ["config", mint]).
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: AccountInfo<'info>,
    /// CHECK: created here once (PDA ["lift", mint]).
    #[account(mut, seeds = [LIFT_SEED, mint.key().as_ref()], bump)]
    pub lift: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaListV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Launcher: must be the launch key in Global bytes 42..74 (checked in init_mint, 8.3), never the admin.
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
    /// CHECK: validated in init_mint (Token-2022 mint with TransferHook -> this program).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: created here once (PDA ["extra-account-metas", mint]).
    #[account(mut, seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    /// CHECK: created here once (PDA ["config", mint]).
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: AccountInfo<'info>,
    /// CHECK: created here once (PDA ["lift", mint]).
    #[account(mut, seeds = [LIFT_SEED, mint.key().as_ref()], bump)]
    pub lift: AccountInfo<'info>,
    /// CHECK: created here once (PDA ["rules", mint]).
    #[account(mut, seeds = [RULES_SEED, mint.key().as_ref()], bump)]
    pub rules: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateAdmin<'info> {
    /// Must equal Global bytes 8..40 (checked in the handler).
    pub authority: Signer<'info>,
    /// CHECK: checked by hand (canonical PDA, owner, discriminator). Not Account<Global>: that account
    /// reserializes on exit, and this instruction must write bytes 8..40 only.
    #[account(mut)]
    pub global: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MigrateGlobalV2<'info> {
    /// Pays the rent increase (any key: the admin need not hold SOL).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must equal Global bytes 8..40 (checked in the handler).
    pub authority: Signer<'info>,
    /// CHECK: checked by hand (canonical PDA, owner, discriminator, length 42): Anchor's realloc constraint would
    /// deserialize into a 74-byte type first, which fails on the 42-byte account.
    #[account(mut)]
    pub global: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLaunchAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = authority @ HookError::Unauthorized)]
    pub global: Account<'info, Global>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: validated in handler (Token-2022 account, mint, transferring flag).
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: validated in handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: validated in handler.
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: source owner/delegate; not used by the rule (source side is never checked).
    pub owner: UncheckedAccount<'info>,
    /// CHECK: PDA check only.
    #[account(seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint @ HookError::InvalidMint)]
    pub config: Account<'info, MintConfig>,
    #[account(seeds = [LIFT_SEED, mint.key().as_ref()], bump = lift.bump, has_one = mint @ HookError::InvalidMint)]
    pub lift: Account<'info, LiftState>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
}

#[derive(Accounts)]
pub struct LiftGlobal<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = authority @ HookError::Unauthorized)]
    pub global: Account<'info, Global>,
}

#[derive(Accounts)]
pub struct LiftMint<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump, has_one = authority @ HookError::Unauthorized)]
    pub global: Account<'info, Global>,
    #[account(mut, seeds = [LIFT_SEED, lift.mint.as_ref()], bump = lift.bump)]
    pub lift: Account<'info, LiftState>,
}

#[derive(Accounts)]
pub struct ViewSchedule<'info> {
    pub config: Account<'info, MintConfig>,
    #[account(seeds = [LIFT_SEED, config.mint.as_ref()], bump = lift.bump)]
    pub lift: Account<'info, LiftState>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
}

#[event]
pub struct RestrictionsLifted {
    /// 0 = global allow-all, 1 = per-mint lift, 2 = per-mint raise.
    pub scope: u8,
    /// Mint (Pubkey::default() for global).
    pub mint: Pubkey,
    pub old_floor_bps: u16,
    pub new_floor_bps: u16,
    pub lifted: bool,
    pub slot: u64,
    pub signer: Pubkey,
}

/// Nth-buy pot win (v2 mints). The program holds no funds: the keeper pays winners and logs each payout.
#[event]
pub struct PotWon {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub buy_index: u64,
    pub slot: u64,
}
