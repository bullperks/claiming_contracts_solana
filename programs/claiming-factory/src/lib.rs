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
    InvalidProof,
    AlreadyClaimed,
    NotOwner,
    NotAdminOrOwner,
    ChangingPauseValueToTheSame,
    Paused,
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

    pub fn init_bitmap(ctx: Context<InitBitmap>, bump: u8) -> Result<()> {
        let bitmap = ctx.accounts.bitmap.deref_mut();

        *bitmap = BitMap {
            data: [0; 64],
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

        require!(distributor.paused != paused, ChangingPauseValueToTheSame);

        distributor.paused = paused;

        Ok(())
    }

    pub fn add_admin(ctx: Context<AddAdmin>, admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;

        for admin_slot in config.admins.iter_mut() {
            match admin_slot {
                // this admin have been already added
                Some(admin_key) if *admin_key == admin => {
                    return Ok(());
                }
                _ => {}
            }
        }

        for admin_slot in config.admins.iter_mut() {
            if let None = admin_slot {
                *admin_slot = Some(admin);
                return Ok(());
            }
        }
        // fails if available admin slot is not found
        Err(ErrorCode::MaxAdmins.into())
    }

    pub fn remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;

        for admin_slot in config.admins.iter_mut() {
            if let Some(admin_key) = admin_slot {
                if *admin_key == admin {
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
        let bitmap = &mut ctx.accounts.bitmap;

        require!(!bitmap.is_claimed(args.index), AlreadyClaimed);
        require!(!distributor.paused, Paused);

        let leaf = [
            &args.index.to_be_bytes()[..],
            &ctx.accounts.target_wallet.key().to_bytes(),
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

        bitmap.set_claimed(args.index);

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
pub struct Config {
    owner: Pubkey,
    admins: [Option<Pubkey>; 10],
    bump: u8,
}

impl Config {
    pub const LEN: usize = std::mem::size_of::<Self>() + 8;
}

#[account]
pub struct BitMap {
    // this fits to stack nicely
    data: [u64; 64],
    bump: u8,
}

impl Default for BitMap {
    fn default() -> Self {
        Self {
            data: [0; 64],
            bump: Default::default(),
        }
    }
}

impl BitMap {
    // 8 is for discriminator
    pub const LEN: usize = std::mem::size_of::<Self>() + 8;
    // this is not working due to anchor bug
    // it fails to parse constant
    // const ARRAY_SIZE: usize = 64;

    fn is_claimed(&self, index: u64) -> bool {
        let word_index = (index / 64) as usize;
        let bit_index = index % 64;
        let word = self.data[word_index];
        let mask = 1 << bit_index;

        word & mask == mask
    }

    fn set_claimed(&mut self, index: u64) {
        let word_index = (index / 64) as usize;
        let bit_index = index % 64;
        self.data[word_index] = self.data[word_index] | (1 << bit_index);
    }
}

#[account]
pub struct MerkleDistributor {
    merkle_index: u64,
    merkle_root: [u8; 32],
    paused: bool,
    vault_bump: u8,
    vault: Pubkey,
}

impl MerkleDistributor {
    pub const LEN: usize = std::mem::size_of::<Self>() + 8;
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitBitmap<'info> {
    #[account(signer)]
    payer: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
        ],
        bump = bump,
    )]
    bitmap: ProgramAccount<'info, BitMap>,
    distributor: ProgramAccount<'info, MerkleDistributor>,

    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitializeConfig<'info> {
    #[account(signer)]
    owner: AccountInfo<'info>,

    #[account(
        init,
        payer = owner,
        space = Config::LEN,
        seeds = [
            "config".as_ref()
        ],
        bump = bump
    )]
    config: ProgramAccount<'info, Config>,

    system_program: Program<'info, System>,
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
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: AccountInfo<'info>,

    #[account(
        init,
        payer = admin_or_owner,
        space = MerkleDistributor::LEN,
    )]
    distributor: ProgramAccount<'info, MerkleDistributor>,

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
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut)]
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = admin_or_owner.key() == config.owner ||
            config.admins.contains(&Some(admin_or_owner.key()))
            @ ErrorCode::NotAdminOrOwner
    )]
    admin_or_owner: AccountInfo<'info>,
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
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
    )]
    owner: AccountInfo<'info>,
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
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
    )]
    owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(
        seeds = [
            "config".as_ref()
        ],
        bump = config.bump
    )]
    config: ProgramAccount<'info, Config>,
    #[account(
        signer,
        constraint = owner.key() == config.owner
            @ ErrorCode::NotOwner
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
    index: u64,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    distributor: ProgramAccount<'info, MerkleDistributor>,
    #[account(signer)]
    claimer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [
            distributor.key().as_ref(),
            distributor.merkle_index.to_be_bytes().as_ref(),
        ],
        bump = bitmap.bump
    )]
    bitmap: ProgramAccount<'info, BitMap>,

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
