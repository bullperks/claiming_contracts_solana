use std::ops::DerefMut;

use anchor_lang::{
    prelude::*,
    solana_program::{keccak, log::sol_log_64},
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs");

#[error_code]
pub enum ErrorCode {
    MaxAdmins,
    AdminNotFound,
    InvalidAmountTransferred,
    InvalidProof,
    AlreadyClaimed,
    NotOwner,
    NotAdminOrOwner,
    ChangingPauseValueToTheSame,
    Paused,
    EmptySchedule,
    InvalidScheduleOrder,
    PercentageDoesntCoverAllTokens,
    EmptyPeriod,
    IntegerOverflow,
}

/// This event is triggered whenever a call to claim succeeds.
#[event]
pub struct Claimed {
    merkle_index: u64,
    index: u64,
    account: Pubkey,
    amount: u64,
}

/// This event is triggered whenever the merkle root gets updated.
#[event]
pub struct MerkleRootUpdated {
    merkle_index: u64,
    merkle_root: [u8; 32],
}

/// This event is triggered whenever a call to withdraw by owner succeeds.
#[event]
pub struct TokensWithdrawn {
    token: Pubkey,
    amount: u64,
}

#[program]
pub mod claiming_factory {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, bump: u8) -> Result<()> {
        let config = ctx.accounts.config.deref_mut();

        *config = Config {
            owner: ctx.accounts.owner.key(),
            admins: [None; 10],
            bump,
        };

        Ok(())
    }

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        let distributor = ctx.accounts.distributor.deref_mut();

        *distributor = MerkleDistributor {
            merkle_index: 0,
            merkle_root: args.merkle_root,
            paused: false,
            vault_bump: args.vault_bump,
            vault: ctx.accounts.vault.key(),
            // schedule should pass validation first
            vesting: Vesting::new(args.schedule)?,
        };

        Ok(())
    }

    pub fn init_user_details(ctx: Context<InitUserDetails>, bump: u8) -> Result<()> {
        let user_details = ctx.accounts.user_details.deref_mut();

        *user_details = UserDetails {
            last_claimed_at_ts: 0,
            claimed_amount: 0,
            bump,
        };

        Ok(())
    }

    // TODO: add/remove/update schedule entry
    // schedule should stay consistent after changes
    // changes should be no later than first schedule entry

    pub fn update_root(ctx: Context<UpdateRoot>, args: UpdateRootArgs) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        distributor.merkle_root = args.merkle_root;
        distributor.merkle_index += 1;

        // TODO: allow to update root only before vesting starts

        emit!(MerkleRootUpdated {
            merkle_index: distributor.merkle_index,
            merkle_root: distributor.merkle_root
        });

        if args.unpause {
            distributor.paused = false;
        }

        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        require!(distributor.paused != paused, ChangingPauseValueToTheSame);

        distributor.paused = paused;

        Ok(())
    }

    pub fn add_admin(ctx: Context<AddAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let admin = &ctx.accounts.admin;

        for admin_slot in config.admins.iter_mut() {
            match admin_slot {
                // this admin have been already added
                Some(admin_key) if *admin_key == admin.key() => {
                    return Ok(());
                }
                _ => {}
            }
        }

        for admin_slot in config.admins.iter_mut() {
            if let None = admin_slot {
                *admin_slot = Some(admin.key());
                return Ok(());
            }
        }
        // fails if available admin slot is not found
        Err(ErrorCode::MaxAdmins.into())
    }

    pub fn remove_admin(ctx: Context<RemoveAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let admin = &ctx.accounts.admin;

        for admin_slot in config.admins.iter_mut() {
            if let Some(admin_key) = admin_slot {
                if *admin_key == admin.key() {
                    *admin_slot = None;
                    return Ok(());
                }
            }
        }

        // fails if admin is not found
        Err(ErrorCode::AdminNotFound.into())
    }

    pub fn withdraw_tokens(ctx: Context<WithdrawTokens>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let distributor = &ctx.accounts.distributor;

        let distributor_key = distributor.key();
        let seeds = &[distributor_key.as_ref(), &[distributor.vault_bump]];
        let signers = &[&seeds[..]];

        TokenTransfer {
            amount,
            from: vault,
            to: &ctx.accounts.target_wallet,
            authority: &ctx.accounts.vault_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signers),
        }
        .make()?;

        emit!(TokensWithdrawn {
            token: vault.mint,
            amount
        });

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let distributor = &ctx.accounts.distributor;
        let user_details = &mut ctx.accounts.user_details;

        require!(!distributor.paused, Paused);
        require!(user_details.claimed_amount < args.amount, AlreadyClaimed);

        let leaf = [
            &args.index.to_be_bytes()[..],
            &ctx.accounts.user.key().to_bytes(),
            &args.amount.to_be_bytes(),
        ];
        let leaf = keccak::hashv(&leaf).0;

        let mut computed_hash = leaf;
        for proof_element in args.merkle_proof {
            if computed_hash <= proof_element {
                computed_hash = keccak::hashv(&[computed_hash.as_ref(), proof_element.as_ref()]).0;
            } else {
                computed_hash = keccak::hashv(&[proof_element.as_ref(), computed_hash.as_ref()]).0;
            }
        }

        require!(computed_hash == distributor.merkle_root, InvalidProof);

        // TODO: calculate total amount to claim
        // let bps_to_claim = distributor.vesting.advance_schedule(&ctx.accounts.clock);
        let amount = args.amount;

        let distributor_key = distributor.key();
        let seeds = &[distributor_key.as_ref(), &[distributor.vault_bump]];
        let signers = &[&seeds[..]];

        TokenTransfer {
            amount,
            from: vault,
            to: &ctx.accounts.target_wallet,
            authority: &ctx.accounts.vault_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signers),
        }
        .make()?;

        user_details.claimed_amount = amount;
        user_details.last_claimed_at_ts = ctx.accounts.clock.unix_timestamp as u64;

        emit!(Claimed {
            merkle_index: distributor.merkle_index,
            index: args.index,
            account: ctx.accounts.user.key(),
            amount,
        });

        Ok(())
    }
}

#[account]
#[derive(Debug)]
pub struct Config {
    owner: Pubkey,
    admins: [Option<Pubkey>; 10],
    bump: u8,
}

impl Config {
    pub const LEN: usize = std::mem::size_of::<Self>() + 8;
}

#[account]
pub struct UserDetails {
    last_claimed_at_ts: u64,
    claimed_amount: u64,
    bump: u8,
}

impl UserDetails {
    pub const LEN: usize = 8 + std::mem::size_of::<Self>();
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct Period {
    /// Percentage in Basis Points (BPS). 1% = 100 BPS.
    /// NOTE: Percentage is specified per interval. So if you have
    /// 1000 BPS over 10 intervals then `token_percentage` should be 100 BPS.
    token_percentage: u64,
    start_ts: u64,
    interval_sec: u64,
    times: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct Vesting {
    schedule: Vec<Period>,
}

impl Vesting {
    fn new(schedule: Vec<Period>) -> Result<Self> {
        let s = Self { schedule };

        s.validate()?;

        Ok(s)
    }

    fn validate(&self) -> Result<()> {
        require!(self.schedule.len() > 0, EmptySchedule);

        let mut last_start_ts = 0;
        let mut total_percentage = 0;

        for entry in &self.schedule {
            require!(entry.times > 0, EmptyPeriod);
            require!(last_start_ts < entry.start_ts, InvalidScheduleOrder);

            // start_ts + (times * interval_sec)
            last_start_ts = entry
                .times
                .checked_mul(entry.interval_sec)
                .ok_or(ErrorCode::IntegerOverflow)?
                .checked_add(entry.start_ts)
                .ok_or(ErrorCode::IntegerOverflow)?;

            total_percentage += entry.token_percentage * entry.times;
        }

        // 100% == 10000 basis points
        require!(total_percentage == 10000, PercentageDoesntCoverAllTokens);

        Ok(())
    }

    // fn advance_schedule(&mut self, clock: &Sysvar<Clock>) -> u64 {
    //     let now = clock.unix_timestamp as u64;
    //     let mut total_percentage_to_claim = 0;

    //     for period in self.schedule.iter().skip(self.current_period as usize) {
    //         if now < period.start_ts {
    //             break;
    //         }

    //         let seconds_since_start = now - period.start_ts;
    //         let intervals_passed =
    //             seconds_since_start / period.interval_sec - self.current_repetition;
    //         let intervals_passed = std::cmp::min(intervals_passed, period.times);

    //         total_percentage_to_claim += intervals_passed * period.token_percentage;

    //         // it can be non-zero only during first period calculation
    //         self.current_repetition = 0;
    //         self.current_period += 1;
    //     }

    //     total_percentage_to_claim
    // }
}

#[account]
#[derive(Debug)]
pub struct MerkleDistributor {
    merkle_index: u64,
    merkle_root: [u8; 32],
    paused: bool,
    vault_bump: u8,
    vault: Pubkey,
    vesting: Vesting,
}

impl MerkleDistributor {
    pub fn space_required(periods: &[Period]) -> usize {
        8 + std::mem::size_of::<Self>() + periods.len() * std::mem::size_of::<Period>()
    }
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitUserDetails<'info> {
    #[account(mut)]
    payer: Signer<'info>,
    /// CHECK:
    user: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = UserDetails::LEN,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump,
    )]
    user_details: Account<'info, UserDetails>,
    distributor: Account<'info, MerkleDistributor>,

    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = Config::LEN,
        seeds = [
            "config".as_ref()
        ],
        bump,
    )]
    config: Account<'info, Config>,

    system_program: Program<'info, System>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct InitializeArgs {
    pub vault_bump: u8,
    pub merkle_root: [u8; 32],
    pub schedule: Vec<Period>,
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump
    )]
    config: Account<'info, Config>,
    #[account(
        mut,
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: Signer<'info>,

    #[account(
        init,
        payer = admin_or_owner,
        space = MerkleDistributor::space_required(&args.schedule),
    )]
    distributor: Account<'info, MerkleDistributor>,

    /// CHECK:
    #[account(
        seeds = [
            distributor.key().as_ref()
        ],
        bump = args.vault_bump
    )]
    vault_authority: AccountInfo<'info>,
    #[account(constraint = vault.owner == vault_authority.key())]
    vault: Account<'info, TokenAccount>,

    system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateRootArgs {
    merkle_root: [u8; 32],
    unpause: bool,
}

#[derive(Accounts)]
pub struct UpdateRoot<'info> {
    #[account(mut)]
    distributor: Account<'info, MerkleDistributor>,
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: Account<'info, Config>,
    #[account(
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut)]
    distributor: Account<'info, MerkleDistributor>,
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: Account<'info, Config>,
    #[account(
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AddAdmin<'info> {
    #[account(
        mut,
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: Account<'info, Config>,
    #[account(
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
    )]
    owner: Signer<'info>,
    /// CHECK:
    admin: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RemoveAdmin<'info> {
    #[account(
        mut,
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: Account<'info, Config>,
    #[account(
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
    )]
    owner: Signer<'info>,
    /// CHECK:
    admin: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    distributor: Account<'info, MerkleDistributor>,
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: Account<'info, Config>,
    #[account(
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
    )]
    owner: Signer<'info>,

    /// CHECK:
    #[account(
        seeds = [
            distributor.key().as_ref()
        ],
        bump = distributor.vault_bump
    )]
    vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = vault.owner == vault_authority.key()
    )]
    vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault.mint == target_wallet.mint
    )]
    target_wallet: Account<'info, TokenAccount>,

    token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ClaimArgs {
    // TODO: remove
    index: u64,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    distributor: Account<'info, MerkleDistributor>,
    user: Signer<'info>,
    #[account(
        mut,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump = user_details.bump
    )]
    user_details: Account<'info, UserDetails>,

    /// CHECK:
    #[account(
        seeds = [
            distributor.key().as_ref()
        ],
        bump = distributor.vault_bump
    )]
    vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = vault.owner == vault_authority.key()
    )]
    vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault.mint == target_wallet.mint
    )]
    target_wallet: Account<'info, TokenAccount>,

    token_program: Program<'info, Token>,
    clock: Sysvar<'info, Clock>,
}

struct TokenTransfer<'pay, 'info> {
    amount: u64,
    from: &'pay mut Account<'info, TokenAccount>,
    to: &'pay Account<'info, TokenAccount>,
    authority: &'pay AccountInfo<'info>,
    token_program: &'pay Program<'info, Token>,
    signers: Option<&'pay [&'pay [&'pay [u8]]]>,
}

impl TokenTransfer<'_, '_> {
    fn make(self) -> Result<()> {
        let amount_before = self.from.amount;

        self.from.key().log();
        self.to.key().log();
        self.authority.key().log();

        let cpi_ctx = CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.from.to_account_info(),
                to: self.to.to_account_info(),
                authority: self.authority.to_account_info(),
            },
        );
        let cpi_ctx = match self.signers {
            Some(signers) => cpi_ctx.with_signer(signers),
            None => cpi_ctx,
        };

        token::transfer(cpi_ctx, self.amount)?;

        self.from.reload()?;
        let amount_after = self.from.amount;

        sol_log_64(amount_before, amount_after, self.amount, 0, 0);

        require!(
            amount_before - amount_after == self.amount,
            InvalidAmountTransferred
        );

        Ok(())
    }
}
