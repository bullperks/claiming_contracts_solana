use std::rc::Rc;

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig, pubkey::Pubkey, signature::read_keypair_file,
    },
    Client,
};
use anyhow::{anyhow, Result};

use serde::{Deserialize, Serialize};
use solana_sdk::{program_pack::Pack, signature::Keypair, signer::Signer};
use structopt::StructOpt;

#[derive(Debug)]
struct CliKeypair<A> {
    path: String,
    ty: std::marker::PhantomData<A>,
}

impl<A> std::fmt::Display for CliKeypair<A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(f, "{}", self.path)
    }
}

impl<A> std::str::FromStr for CliKeypair<A> {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self {
            path: s.to_string(),
            ty: std::marker::PhantomData {},
        })
    }
}

impl<A> AsRef<String> for CliKeypair<A> {
    fn as_ref(&self) -> &String {
        &self.path
    }
}

impl<A> Default for CliKeypair<A>
where
    A: DefaultPath,
{
    fn default() -> Self {
        Self {
            path: A::default_path(),
            ty: std::marker::PhantomData {},
        }
    }
}

trait DefaultPath {
    fn default_path() -> String;
}

#[derive(Debug)]
struct Payer;

impl DefaultPath for Payer {
    fn default_path() -> String {
        shellexpand::tilde("~/.config/solana/id.json").to_string()
    }
}

#[derive(Debug, StructOpt)]
struct Opts {
    #[structopt(long)]
    program_id: Pubkey,
    #[structopt(long)]
    cluster: anchor_client::Cluster,
    #[structopt(long, default_value)]
    payer: CliKeypair<Payer>,
    #[structopt(subcommand)]
    cmd: Command,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleData {
    data: [u8; 32],
}

#[derive(Debug, StructOpt)]
enum Command {
    InitConfig {},
    ShowConfig {},
    AddAdmin {
        #[structopt(long)]
        admin: Pubkey,
    },
    CreateClaiming {
        #[structopt(long)]
        merkle: String,
        #[structopt(long)]
        mint: Pubkey,
    },
    ShowClaiming {
        #[structopt(long)]
        claiming: Pubkey,
    },
}

fn main() -> Result<()> {
    let opts = Opts::from_args();

    let payer = read_keypair_file(opts.payer.as_ref())
        .map_err(|err| anyhow!("failed to read keypair: {}", err))?;
    let payer = Rc::new(payer);

    let client =
        Client::new_with_options(opts.cluster, payer.clone(), CommitmentConfig::processed());
    let client = client.program(opts.program_id);

    match opts.cmd {
        Command::InitConfig {} => {
            let (config, bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());
            println!("Config address: {}", config);

            let r = client
                .request()
                .accounts(claiming_factory::accounts::InitializeConfig {
                    system_program: solana_sdk::system_program::id(),
                    owner: payer.pubkey(),
                    config,
                })
                .args(claiming_factory::instruction::InitializeConfig { bump })
                .signer(payer.as_ref())
                .send()?;

            println!("Result:\n{}", r);
        }
        Command::ShowConfig {} => {
            let (config, _bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());

            let config: claiming_factory::Config = client.account(config)?;
            println!("{:#?}", config);
        }
        Command::AddAdmin { admin } => {
            let (config, _bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());
            println!("Config address: {}", config);

            let r = client
                .request()
                .accounts(claiming_factory::accounts::AddAdmin {
                    owner: payer.pubkey(),
                    config,
                    admin,
                })
                .args(claiming_factory::instruction::AddAdmin {})
                .signer(payer.as_ref())
                .send()?;

            println!("Result:\n{}", r);
        }
        Command::CreateClaiming { merkle, mint } => {
            let merkle: MerkleData = serde_json::from_str(&merkle)?;
            println!("{:?}", merkle);

            let (config, _bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());
            println!("Config address: {}", config);

            let distributor = Keypair::new();
            println!("Distributor address: {}", distributor.pubkey());

            let vault = Keypair::new();

            let (vault_authority, vault_bump) =
                Pubkey::find_program_address(&[distributor.pubkey().as_ref()], &client.id());

            let rent = client
                .rpc()
                .get_minimum_balance_for_rent_exemption(spl_token::state::Account::LEN)?;

            let create_token_account_ix = solana_sdk::system_instruction::create_account(
                &payer.pubkey(),
                &vault.pubkey(),
                rent,
                spl_token::state::Account::LEN as u64,
                &spl_token::ID,
            );

            let init_token_account_ix = spl_token::instruction::initialize_account(
                &spl_token::ID,
                &vault.pubkey(),
                &mint,
                &vault_authority,
            )?;

            let r = client
                .request()
                .instruction(create_token_account_ix)
                .instruction(init_token_account_ix)
                .accounts(claiming_factory::accounts::Initialize {
                    config,
                    admin_or_owner: payer.pubkey(),
                    distributor: distributor.pubkey(),
                    vault_authority,
                    vault: vault.pubkey(),
                    system_program: solana_sdk::system_program::id(),
                })
                .args(claiming_factory::instruction::Initialize {
                    args: claiming_factory::InitializeArgs {
                        vault_bump,
                        merkle_root: merkle.data,
                        // TODO: init schedule
                        schedule: Vec::new(),
                    },
                })
                .signer(payer.as_ref())
                .signer(&distributor)
                .signer(&vault)
                .send()?;

            println!("Result:\n{}", r);
        }
        Command::ShowClaiming { claiming } => {
            let claiming: claiming_factory::MerkleDistributor = client.account(claiming)?;
            println!("{:#?}", claiming);
        }
    }

    Ok(())
}
