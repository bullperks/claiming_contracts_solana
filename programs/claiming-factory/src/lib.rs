use std::ops::DerefMut;

use anchor_lang::{
    prelude::*,
    solana_program::{
        keccak,
        log::{sol_log, sol_log_64},
    },
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use rust_decimal::{
    prelude::{FromPrimitive, ToPrimitive},
    Decimal,
};

#[cfg(not(feature = "local"))]
declare_id!("C352X1QLENaVNiEbpRQp4fFNRdpWMVW6XZTh9sr4fT75");

#[cfg(feature = "local")]
declare_id!("6cJU4mUJe1fKXzvvbZjz72M3d5aQXMmRV2jeQerkFw5b");

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
    VestingAlreadyStarted,
    NothingToClaim,
    InvalidIntervalDuration,
    WrongClaimer,
    NotAllowedToChangeWallet,
    ScheduleStopped,
    RefundDeadlinePassed,
}

/// This event is triggered whenever a call to claim succeeds.
#[event]
pub struct Claimed {
    merkle_index: u64,
    account: Pubkey,
    token_account: Pubkey,
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
    use anchor_lang::AccountsClose;

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

    pub fn initialize2(ctx: Context<Initialize2>, args: Initialize2Args) -> Result<()> {
        let distributor = ctx.accounts.distributor.deref_mut();

        *distributor = MerkleDistributor {
            merkle_index: 0,
            merkle_root: args.merkle_root,
            paused: false,
            vault_bump: args.vault_bump,
            vault: ctx.accounts.vault.key(),
            // schedule unchecked here (will be checked at claim)
            vesting: Vesting::new_unchecked(vec![]),
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

    pub fn update_schedule(ctx: Context<UpdateSchedule>, args: UpdateScheduleArgs) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        require!(
            !distributor.vesting.has_started(&ctx.accounts.clock),
            VestingAlreadyStarted
        );

        for change in args.changes {
            distributor.vesting.apply_change(change);
        }

        distributor.vesting.validate()?;

        Ok(())
    }

    pub fn update_schedule2(ctx: Context<UpdateSchedule>, args: UpdateScheduleArgs) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        for change in args.changes {
            distributor.vesting.apply_change(change);
        }

        Ok(())
    }

    pub fn update_root(ctx: Context<UpdateRoot>, args: UpdateRootArgs) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        distributor.merkle_root = args.merkle_root;
        distributor.merkle_index = distributor
            .merkle_index
            .checked_add(1)
            .ok_or(ErrorCode::IntegerOverflow)?;

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

    pub fn stop_vesting(ctx: Context<StopVesting>) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;
        let now = ctx.accounts.clock.unix_timestamp as u64;

        for period in distributor.vesting.schedule.iter_mut() {
            // skip all previous or current periods
            if period.start_ts <= now {
                continue;
            }

            // mark every future period as airdropped
            period.airdropped = true;
        }

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
            if admin_slot.is_none() {
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

    pub fn init_actual_wallet(ctx: Context<InitActualWallet>, bump: u8) -> Result<()> {
        let actual_wallet = ctx.accounts.actual_wallet.deref_mut();

        *actual_wallet = ActualWallet {
            original: ctx.accounts.user.key(),
            actual: ctx.accounts.user.key(),
            bump,
        };

        Ok(())
    }

    pub fn change_wallet(ctx: Context<ChangeWallet>, bump: u8) -> Result<()> {
        let new_user_details = ctx.accounts.new_user_details.deref_mut();

        *new_user_details = UserDetails {
            last_claimed_at_ts: ctx.accounts.user_details.last_claimed_at_ts,
            claimed_amount: ctx.accounts.user_details.claimed_amount,
            bump,
        };

        let actual_wallet = &mut ctx.accounts.actual_wallet;
        actual_wallet.actual = ctx.accounts.new_wallet.key();

        ctx.accounts
            .user_details
            .close(ctx.accounts.user.to_account_info())?;

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let distributor = &ctx.accounts.distributor;
        let clock = &ctx.accounts.clock;

        let user_details = &mut ctx.accounts.user_details;
        let now = ctx.accounts.clock.unix_timestamp as u64;
        require!(
                clock.unix_timestamp as i64 <= distributor.refund_deadline,
                RefundDeadlinePassed
            );
        require!(!distributor.paused, Paused);
        distributor.vesting.validate()?;
        require!(user_details.claimed_amount < args.amount, AlreadyClaimed);

        check_proof(
            &args.original_wallet,
            args.amount,
            &distributor.merkle_root,
            &args.merkle_proof,
        )?;

        let (bps_to_claim, bps_to_add) = distributor
            .vesting
            .bps_available_to_claim(now, user_details)?;
        let amount = (Decimal::from_u64(args.amount).unwrap() * bps_to_claim)
            .ceil()
            .to_u64()
            .unwrap();
        // this amount is from airdropped periods
        let amount_to_add = (Decimal::from_u64(args.amount).unwrap() * bps_to_add)
            .ceil()
            .to_u64()
            .unwrap();

        if amount == 0 && distributor.vesting.has_stopped(now)? {
            return Err(ErrorCode::ScheduleStopped.into());
        } else if amount == 0 {
            return Err(ErrorCode::NothingToClaim.into());
        }

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

        user_details.claimed_amount = user_details
            .claimed_amount
            .checked_add(amount)
            .ok_or(ErrorCode::IntegerOverflow)?;
        user_details.claimed_amount = user_details
            .claimed_amount
            .checked_add(amount_to_add)
            .ok_or(ErrorCode::IntegerOverflow)?;

        user_details.last_claimed_at_ts = ctx.accounts.clock.unix_timestamp as u64;

        emit!(Claimed {
            merkle_index: distributor.merkle_index,
            account: ctx.accounts.user.key(),
            token_account: ctx.accounts.target_wallet.key(),
            amount,
        });

        Ok(())
    }

    pub fn request_refund(ctx: Context<RequestRefund>, bump: u8) -> Result<()> {
        let refund_request = &mut ctx.accounts.refund_request;
        refund_request.user = ctx.accounts.user.key();
        refund_request.refund_requested_at = ctx.accounts.clock.unix_timestamp as i64;

        Ok(())
    }

    pub fn get_refund_requests(ctx: Context<GetRefundInfo>) -> Vec<Pubkey> {
        let refund_requests = ctx.accounts.refund_requests.to_account_info().data.borrow();
        let refund_requests: Vec<RefundInfo> = bincode::deserialize(refund_requests).unwrap();

        refund_requests.into_iter().map(|rr| rr.user).collect()
    }

    pub fn remove_refund_requests(ctx: Context<RemoveRefundInfo>, refund_requests: Vec<Pubkey>) -> Result<()> {
        let refund_requests_account = &mut ctx.accounts.refund_requests;
        refund_requests_account.remove_refund_requests(refund_requests)?;

        Ok(())
    }

    // pub fn remove_refund_requests(&mut self, refund_requests: Vec<Pubkey>) -> Result<()> {
    //     let mut refund_requests_iter = self.refund_requests.iter_mut();
    //     let mut refund_requests_to_remove: Vec<usize> = Vec::new();

    //     for (i, refund_request) in refund_requests_iter.enumerate() {
    //         if refund_requests.contains(&refund_request.user) {
    //             refund_requests_to_remove.push(i);
    //         }
    //     }

    //     for index in refund_requests_to_remove.into_iter().rev() {
    //         refund_requests.remove(index);
    //     }

    //     Ok(())
    // }

    pub fn withdraw_refunds(ctx: Context<WithdrawRefunds>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let distributor = &ctx.accounts.distributor;

        let distributor_key = distributor.key();
        let seeds = &[distributor_key.as_ref(), &[distributor.vault_bump]];
        let signers = &[&seeds[..]];

        TokenTransfer {
            amount,
            from: vault,
            to: &ctx.accounts.project_wallet,
            authority: &ctx.accounts.vault_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signers),
        }
        .make()?;

        Ok(())
    }

    pub fn calculate_unclaimable_amount(ctx: Context<CalculateUnclaimableAmount>, refund_requests: Vec<Pubkey>) -> u64 {
        let distributor = &ctx.accounts.distributor;
        let clock = &ctx.accounts.clock;

        let mut unclaimable_amount = 0;

        for refund_request in refund_requests {
            let user_details = &mut ctx.accounts.user_details;
            let user_details_refund_requested_at = user_details.refund_requested_at;

            if user_details_refund_requested_at > 0 && user_details_refund_requested_at < clock.unix_timestamp as i64 {
                let (bps_to_claim, _) = distributor
                    .vesting
                    .bps_available_to_claim(clock.unix_timestamp as u64, user_details)?;
                unclaimable_amount += (Decimal::from_u64(user_details.claimed_amount).unwrap() * Decimal::from_u64(bps_to_claim).unwrap()).to_u64().unwrap();
            }

            user_details.refund_requested_at = 0;
            user_details.claimed_amount = 0;
        }

        unclaimable_amount
    }

    pub fn update_refund_requested_at(ctx: Context<UpdateRefundInfoedAt>, refund_requested_at: i64) -> Result<()> {
        let user_details = &mut ctx.accounts.user_details;
        user_details.refund_requested_at = refund_requested_at;

        Ok(())
    }

    pub fn update_refund_deadline(ctx: Context<UpdateRefundDeadline>, refund_deadline: i64) -> Result<()> {
        let clock = Clock::get()?; 
        let distributor = &mut ctx.accounts.distributor;
        require!(
            refund_deadline >= clock.unix_timestamp,
            ErrorCode::IntegerOverflow
        );
        distributor.refund_deadline = refund_deadline;

        Ok(())
    }
}

fn check_proof(
    original_wallet: &Pubkey,
    amount: u64,
    root: &[u8],
    proof: &[[u8; 32]],
) -> Result<()> {
    let leaf = [&original_wallet.to_bytes()[..], &amount.to_be_bytes()];
    let leaf = keccak::hashv(&leaf).0;

    let mut computed_hash = leaf;
    for proof_element in proof {
        if computed_hash <= *proof_element {
            computed_hash = keccak::hashv(&[computed_hash.as_ref(), proof_element.as_ref()]).0;
        } else {
            computed_hash = keccak::hashv(&[proof_element.as_ref(), computed_hash.as_ref()]).0;
        }
    }

    println!("{:?}", computed_hash);

    require!(computed_hash == root, InvalidProof);

    Ok(())
}

#[account]
pub struct RefundInfo {
    user: Pubkey,
    refund_requested_at: i64,
}

#[derive(Accounts)]
pub struct RequestRefund<'info> {
    #[account(mut)]
    user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = RefundInfo::LEN,
        seeds = [
            b"refund-request",
            user.key().as_ref(),
        ],
        bump,
    )]
    refund_request: Account<'info, RefundInfo>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetRefundInfo<'info> {
    #[account(
        seeds = [
            b"refund-requests",
        ],
        bump,
    )]
    refund_requests: Account<'info, RefundInfo>,
}

#[derive(Accounts)]
pub struct RemoveRefundInfo<'info> {
    #[account(
        mut,
        seeds = [
            b"refund-requests",
        ],
        bump,
    )]
    refund_requests: Account<'info, RefundInfo>,
}

// impl Vec<Pubkey> {
    
// }

#[derive(Accounts)]
pub struct WithdrawRefunds<'info> {
    #[account(
        mut,
        constraint = vault.mint == token_program.mint
    )]
    vault: Account<'info, TokenAccount>,
    distributor: Account<'info, MerkleDistributor>,
    #[account(
        mut,
        constraint = project_wallet.owner == admin.key()
    )]
    project_wallet: Account<'info, TokenAccount>,
    vault_authority: AccountInfo<'info>,
    token_program: Program<'info, Token>,
    admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateRefundInfoedAt<'info> {
    #[account(
        mut,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump = user_details.bump,
    )]
    user_details: Account<'info, UserDetails>,
    user: Signer<'info>,
    distributor: Account<'info, MerkleDistributor>,
}
#[derive(Accounts)]
pub struct CalculateUnclaimableAmount<'info> {
    distributor: Account<'info, MerkleDistributor>,
    clock: Sysvar<'info, Clock>,
    #[account(
        mut,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump = user_details.bump,
    )]
    user_details: Account<'info, UserDetails>,
    user: Signer<'info>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct UpdateRefundDeadline<'info> {
    refund_deadline: i64,
    clock: Sysvar<'info, Clock>,
}

// #[derive(Accounts)]
// pub struct UpdateRefundDeadline<'info> {
//     #[account(
//         mut,
//         constraint = admin.key() == distributor.owner
//     )]
//     distributor: Account<'info, MerkleDistributor>,
//     admin: Signer<'info>,
//     clock: Sysvar<'info, Clock>,
// }



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
#[derive(Debug)]
pub struct UserDetails {
    last_claimed_at_ts: u64,
    claimed_amount: u64,
    bump: u8,
}

impl UserDetails {
    pub const LEN: usize = 8 + std::mem::size_of::<Self>();
}

const DECIMALS: u32 = 9;

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct Period {
    /// Percentage in kinda Basis Points (BPS). 1% = 1_000_000_000 BPS.
    /// NOTE: Percentage is for the whole period.
    pub token_percentage: u64,
    pub start_ts: u64,
    pub interval_sec: u64,
    pub times: u64,
    /// We should skip this in claim amount calculation
    /// because it has been claimed outside of this vesting scope.
    pub airdropped: bool,
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

    fn new_unchecked(schedule: Vec<Period>) -> Self {
        Self { schedule }
    }

    fn validate(&self) -> Result<()> {
        require!(!self.schedule.is_empty(), EmptySchedule);

        let mut last_start_ts = 0;
        let mut total_percentage: u64 = 0;

        for entry in &self.schedule {
            require!(entry.times > 0, EmptyPeriod);
            require!(entry.interval_sec > 0, InvalidIntervalDuration);
            require!(last_start_ts < entry.start_ts, InvalidScheduleOrder);

            // start_ts + (times * interval_sec)
            last_start_ts = entry
                .times
                .checked_mul(entry.interval_sec)
                .ok_or(ErrorCode::IntegerOverflow)?
                .checked_add(entry.start_ts)
                .ok_or(ErrorCode::IntegerOverflow)?;

            total_percentage = total_percentage
                .checked_add(entry.token_percentage)
                .ok_or(ErrorCode::IntegerOverflow)?;
        }

        // 99% == 99_000_000_000 basis points
        // 100% == 100_000_000_000 basis points
        require!(
            total_percentage >= 99 * 10u64.pow(DECIMALS)
                && total_percentage <= 100 * 10u64.pow(DECIMALS),
            PercentageDoesntCoverAllTokens
        );

        Ok(())
    }

    fn has_started(&self, clock: &Sysvar<Clock>) -> bool {
        match self.schedule.first() {
            Some(first_period) => {
                let now = clock.unix_timestamp as u64;
                first_period.start_ts <= now
            }
            None => false,
        }
    }

    fn apply_change(&mut self, change: Change) {
        match change {
            Change::Update { index, period } => {
                self.schedule[index as usize] = period;
            }
            Change::Remove { index } => {
                self.schedule.remove(index as usize);
            }
            Change::Push { period } => {
                self.schedule.push(period);
            }
        }
    }

    fn has_stopped(&self, now: u64) -> Result<bool> {
        let mut stopped = true;

        for period in self.schedule.iter() {
            let period_end_ts = period
                .times
                .checked_mul(period.interval_sec)
                .ok_or(ErrorCode::IntegerOverflow)?
                .checked_add(period.start_ts)
                .ok_or(ErrorCode::IntegerOverflow)?;

            if period_end_ts < now {
                continue;
            }

            if !period.airdropped {
                stopped = false;
                break;
            }
        }

        Ok(stopped)
    }

    fn bps_available_to_claim(
        &self,
        now: u64,
        user_details: &UserDetails,
    ) -> Result<(Decimal, Decimal)> {
        let mut total_percentage_to_claim = Decimal::ZERO;
        let mut total_percentage_to_add = Decimal::ZERO;

        for period in self.schedule.iter() {
            sol_log_64(now, period.start_ts, user_details.last_claimed_at_ts, 0, 0);

            if now < period.start_ts {
                sol_log("too early to claim period");
                break;
            }

            let period_end_ts = period
                .times
                .checked_mul(period.interval_sec)
                .ok_or(ErrorCode::IntegerOverflow)?
                .checked_add(period.start_ts)
                .ok_or(ErrorCode::IntegerOverflow)?;
            if period_end_ts <= user_details.last_claimed_at_ts {
                sol_log("skip since we've already claimed");
                continue;
            }

            if period.airdropped {
                sol_log("this period was airdropped");
                total_percentage_to_add +=
                    Decimal::new(period.token_percentage as i64, DECIMALS + 2);
                continue;
            }

            let alignment = user_details
                .last_claimed_at_ts
                .checked_rem(period.interval_sec)
                .ok_or(ErrorCode::IntegerOverflow)?;
            let last_claimed_at_ts_aligned_by_interval = user_details
                .last_claimed_at_ts
                .checked_sub(alignment)
                .ok_or(ErrorCode::IntegerOverflow)?;
            let seconds_passed = now
                .checked_sub(std::cmp::max(
                    period.start_ts,
                    last_claimed_at_ts_aligned_by_interval,
                ))
                .ok_or(ErrorCode::IntegerOverflow)?;
            let intervals_passed = seconds_passed / period.interval_sec;
            let intervals_passed = std::cmp::min(intervals_passed, period.times);

            sol_log_64(
                user_details.last_claimed_at_ts,
                last_claimed_at_ts_aligned_by_interval,
                seconds_passed,
                now,
                intervals_passed,
            );

            let percentage_for_intervals =
                (Decimal::new(period.token_percentage as i64, DECIMALS + 2)
                    / Decimal::from_u64(period.times).unwrap())
                    * Decimal::from_u64(intervals_passed).unwrap();

            total_percentage_to_claim += percentage_for_intervals;
        }

        Ok((total_percentage_to_claim, total_percentage_to_add))
    }
}

#[account]
pub struct ActualWallet {
    original: Pubkey,
    actual: Pubkey,
    bump: u8,
}

impl ActualWallet {
    pub fn space_required() -> usize {
        8 + std::mem::size_of::<Self>()
    }
}

#[account]
#[derive(Debug)]
pub struct MerkleDistributor {
    pub merkle_index: u64,
    pub merkle_root: [u8; 32],
    pub paused: bool,
    pub vault_bump: u8,
    pub vault: Pubkey,
    pub vesting: Vesting,
    pub refund_deadline: i64,
}

impl MerkleDistributor {
    pub fn space_required(periods: &[Period]) -> usize {
        8 + std::mem::size_of::<Self>() + periods.len() * std::mem::size_of::<Period>()
    }

    pub fn space_required_2(periods_count: u64) -> usize {
        8 + std::mem::size_of::<Self>() + periods_count as usize * std::mem::size_of::<Period>()
    }
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitUserDetails<'info> {
    #[account(mut)]
    payer: Signer<'info>,
    /// CHECK: ordinary Solana account (no requirements)
    /// we can init UserDetails for other user too
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

    /// CHECK: PDA which is set as vault authority
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

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct Initialize2Args {
    pub vault_bump: u8,
    pub merkle_root: [u8; 32],
    pub periods_count: u64,
}

#[derive(Accounts)]
#[instruction(args: Initialize2Args)]
pub struct Initialize2<'info> {
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
        space = MerkleDistributor::space_required_2(args.periods_count),
    )]
    distributor: Account<'info, MerkleDistributor>,

    /// CHECK: PDA which is set as vault authority
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

    clock: Sysvar<'info, Clock>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub enum Change {
    Update { index: u64, period: Period },
    Remove { index: u64 },
    Push { period: Period },
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct UpdateScheduleArgs {
    changes: Vec<Change>,
}

#[derive(Accounts)]
pub struct UpdateSchedule<'info> {
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

    clock: Sysvar<'info, Clock>,
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
pub struct StopVesting<'info> {
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

    clock: Sysvar<'info, Clock>,
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
    /// CHECK: ordinary Solana account (no requirements)
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
    /// CHECK: ordinary Solana account (no requirement)
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
        || config.admins.contains(&Some(owner.key()))
            @ ErrorCode::NotOwner
    )]
    owner: Signer<'info>,

    /// CHECK: PDA which is set as vault authority
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

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitActualWallet<'info> {
    distributor: Account<'info, MerkleDistributor>,
    #[account(mut)]
    user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = ActualWallet::space_required(),
        seeds = [
            distributor.key().as_ref(),
            user.key().as_ref(),
            "actual-wallet".as_ref(),
        ],
        bump,
    )]
    actual_wallet: Account<'info, ActualWallet>,

    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct ChangeWallet<'info> {
    distributor: Account<'info, MerkleDistributor>,
    #[account(mut)]
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

    /// CHECK: ordinary Solana account (no requirements)
    new_wallet: AccountInfo<'info>,
    #[account(
        init,
        payer = user,
        space = UserDetails::LEN,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
            new_wallet.key().as_ref(),
        ],
        bump,
    )]
    new_user_details: Account<'info, UserDetails>,

    /// CHECK: ordinary Solana account (no requirements)
    original_wallet: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [
            distributor.key().as_ref(),
            original_wallet.key().as_ref(),
            "actual-wallet".as_ref(),
        ],
        bump,
        constraint = actual_wallet.original == original_wallet.key()
            @ ErrorCode::NotAllowedToChangeWallet,
        constraint = actual_wallet.actual == user.key()
            @ ErrorCode::NotAllowedToChangeWallet
    )]
    actual_wallet: Account<'info, ActualWallet>,

    system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ClaimArgs {
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
    original_wallet: Pubkey,
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
        bump = user_details.bump,
    )]
    user_details: Account<'info, UserDetails>,

    #[account(
        seeds = [
            distributor.key().as_ref(),
            args.original_wallet.as_ref(),
            b"actual-wallet",
        ],
        bump = actual_wallet.bump,
        constraint = user.key() == actual_wallet.actual
            @ ErrorCode::WrongClaimer,
        constraint = args.original_wallet == actual_wallet.original
            @ ErrorCode::WrongClaimer,
    )]
    actual_wallet: Account<'info, ActualWallet>,

    /// CHECK: PDA which is set as vault authority
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
