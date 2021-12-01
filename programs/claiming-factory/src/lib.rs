use std::ops::DerefMut;

use anchor_lang::{
    prelude::*,
    solana_program::{keccak, log::sol_log_64},
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[error]
pub enum ErrorCode {
    MaxAdmins,
    AdminNotFound,
    InvalidAmountTransferred,
}

/// This event is triggered whenever a call to claim succeeds.
#[event]
pub struct Claimed {
    merkle_index: u128,
    index: u128,
    account: Pubkey,
    amount: u64,
}

/// This event is triggered whenever the merkle root gets updated.
#[event]
pub struct MerkleRootUpdated {
    merkle_index: u128,
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

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        let distributor = ctx.accounts.distributor.deref_mut();

        *distributor = MerkleDistributor {
            merkle_index: 0,
            merkle_root: args.merkle_root,
            paused: false,
            owner: ctx.accounts.owner.key(),
            admins: [None; 5],
            vault_bump: args.vault_bump,
        };

        Ok(())
    }

    pub fn update_root(ctx: Context<UpdateRoot>, args: UpdateRootArgs) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        distributor.merkle_root = args.merkle_root;
        distributor.merkle_index += 1;

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

        distributor.paused = paused;

        Ok(())
    }

    pub fn add_admin(ctx: Context<AddAdmin>, admin: Pubkey) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        for admin_slot in distributor.admins.iter_mut() {
            if let None = admin_slot {
                *admin_slot = Some(admin);
                return Ok(());
            }
        }
        // fails if available admin slot is not found
        Err(ErrorCode::MaxAdmins.into())
    }

    pub fn remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
        let distributor = &mut ctx.accounts.distributor;

        for admin_slot in distributor.admins.iter_mut() {
            if let Some(admin_key) = admin_slot {
                if *admin_key == admin {
                    *admin_slot = None;
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

        // TODO: check if already claimed

        let leaf = [
            &args.index.to_be_bytes()[..],
            &ctx.accounts.target_wallet.key().to_bytes(),
            &args.amount.to_be_bytes(),
        ]
        .concat();
        let leaf = keccak::hash(&leaf);
        // TODO: verify merkle proof

        let distributor_key = distributor.key();
        let seeds = &[distributor_key.as_ref(), &[distributor.vault_bump]];
        let signers = &[&seeds[..]];

        TokenTransfer {
            amount: args.amount,
            from: vault,
            to: &ctx.accounts.target_wallet,
            authority: &ctx.accounts.vault_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signers),
        }
        .make()?;

        // TODO: set claimed

        emit!(Claimed {
            merkle_index: distributor.merkle_index,
            index: args.index,
            account: ctx.accounts.target_wallet.key(),
            amount: args.amount
        });

        Ok(())
    }
}

#[account]
pub struct MerkleDistributor {
    merkle_index: u128,
    merkle_root: [u8; 32],
    paused: bool,
    owner: Pubkey,
    admins: [Option<Pubkey>; 5],
    vault_bump: u8,
}

impl MerkleDistributor {
    pub const LEN: usize = std::mem::size_of::<Self>();
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct InitializeArgs {
    vault_bump: u8,
    merkle_root: [u8; 32],
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = MerkleDistributor::LEN,
    )]
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(signer)]
    owner: AccountInfo<'info>,

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
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        signer,
        constraint = admin_or_owner.key() == distributor.owner ||
            distributor.admins.contains(&Some(admin_or_owner.key()))
    )]
    admin_or_owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut)]
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        signer,
        constraint = admin_or_owner.key() == distributor.owner ||
            distributor.admins.contains(&Some(admin_or_owner.key()))
    )]
    admin_or_owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AddAdmin<'info> {
    #[account(mut)]
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        signer,
        constraint = owner.key() == distributor.owner
    )]
    owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RemoveAdmin<'info> {
    #[account(mut)]
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        signer,
        constraint = owner.key() == distributor.owner
    )]
    owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        signer,
        constraint = owner.key() == distributor.owner
    )]
    owner: AccountInfo<'info>,

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
    index: u128,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(signer)]
    claimer: AccountInfo<'info>,

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
