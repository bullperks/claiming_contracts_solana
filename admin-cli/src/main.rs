use std::rc::Rc;

use anchor_client::{
    solana_client::rpc_client::RpcClient,
    solana_sdk::{
        commitment_config::CommitmentConfig, pubkey::Pubkey, signature::read_keypair_file,
    },
    Client,
};
use anyhow::{anyhow, Result};

use serde::{Deserialize, Serialize};
use solana_sdk::{
    program_pack::Pack, signature::Keypair, signer::Signer, transaction::Transaction,
};
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
    RemoveAdmin {
        #[structopt(long)]
        admin: Pubkey,
    },
    CreateClaiming {
        #[structopt(long)]
        merkle: String,
        #[structopt(long)]
        mint: Pubkey,
        #[structopt(long)]
        schedule: String,
        #[structopt(long)]
        refund_deadline_ts: Option<u64>,
    },
    ShowClaiming {
        #[structopt(long)]
        claiming: Pubkey,
    },
    ShowUserDetails {
        #[structopt(long)]
        claiming: Pubkey,
        #[structopt(long)]
        user: Pubkey,
    },
    SetRefundDeadline {
        #[structopt(long)]
        distributor: Pubkey,
        #[structopt(long)]
        deadline: u64,
    },
    ViewRefundRequests {
        #[structopt(long)]
        distributor: Pubkey,
    }
}

fn main() -> Result<()> {
    let opts = Opts::from_args();

    let payer = read_keypair_file(opts.payer.as_ref())
        .map_err(|err| anyhow!("failed to read keypair: {}", err))?;
    let payer = Rc::new(payer);

    let client = Client::new_with_options(
        opts.cluster.clone(),
        payer.clone(),
        CommitmentConfig::processed(),
    );
    let client = client.program(opts.program_id);

    match opts.cmd {
        Command::InitConfig {} => {
            let (config, bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());
            println!("Config address: {}", config);

            let req = client
                .request()
                .accounts(claiming_factory::accounts::InitializeConfig {
                    system_program: solana_sdk::system_program::id(),
                    owner: payer.pubkey(),
                    config,
                })
                .args(claiming_factory::instruction::InitializeConfig { bump })
                .signer(payer.as_ref());

            let rpc_client = RpcClient::new(opts.cluster.url());

            let instructions = req.instructions()?;
            let tx = {
                let latest_hash = rpc_client.get_latest_blockhash()?;
                Transaction::new_signed_with_payer(
                    &instructions,
                    Some(&payer.pubkey()),
                    &[payer.as_ref()],
                    latest_hash,
                )
            };

            let r = rpc_client.send_and_confirm_transaction(&tx).unwrap();
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
        Command::RemoveAdmin { admin } => {
            let (config, _bump) = Pubkey::find_program_address(&["config".as_ref()], &client.id());
            println!("Config address: {}", config);

            let r = client
                .request()
                .accounts(claiming_factory::accounts::RemoveAdmin {
                    owner: payer.pubkey(),
                    config,
                    admin,
                })
                .args(claiming_factory::instruction::RemoveAdmin {})
                .signer(payer.as_ref())
                .send()?;

            println!("Result:\n{}", r);
        }
        Command::CreateClaiming {
            merkle,
            mint,
            schedule,
            refund_deadline_ts,
        } => {
            let merkle: MerkleData = serde_json::from_str(&merkle)?;
            println!("{:?}", merkle);

            let file = std::fs::read(schedule)?;
            let mut rdr = csv::ReaderBuilder::new()
                .has_headers(false)
                .from_reader(&*file);
            let mut schedule = Vec::new();
            for result in rdr.records() {
                let record = result?;

                let start_ts = record
                    .get(0)
                    .ok_or(anyhow!(
                        "missing period start value (should be unix timestamp in seconds)"
                    ))?
                    .parse::<u64>()?;

                let token_percentage = record
                    .get(1)
                    .ok_or(anyhow!(
                        "missing token percentage value for period (in basis points)"
                    ))?
                    .parse::<u64>()?;

                let interval_sec = record
                    .get(2)
                    .ok_or(anyhow!("missing interval seconds for period"))?
                    .parse::<u64>()?;

                let times = record
                    .get(3)
                    .ok_or(anyhow!("missing interval times for periods"))?
                    .parse::<u64>()?;

                let airdropped = record
                    .get(4)
                    .ok_or(anyhow!("missing airdropped flag"))?
                    .parse::<bool>()?;

                schedule.push(claiming_factory::Period {
                    start_ts,
                    token_percentage,
                    interval_sec,
                    times,
                    airdropped,
                });
            }

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
                        schedule,
                        refund_deadline_ts,
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
        Command::ShowUserDetails { claiming, user } => {
            let claiming_account: claiming_factory::MerkleDistributor = client.account(claiming)?;
            let (user_details, _bump) = Pubkey::find_program_address(
                &[
                    claiming.as_ref(),
                    claiming_account.merkle_index.to_be_bytes().as_ref(),
                    user.as_ref(),
                ],
                &client.id(),
            );
            let user_details_account: claiming_factory::UserDetails =
                client.account(user_details)?;
            println!("{:#?}", user_details_account);
        }

        Command::SetRefundDeadline { distributor, deadline } => {
            let r = client
                .request()
                .accounts(claiming_factory::accounts::SetRefundDeadline {
                    distributor,
                    owner: payer.pubkey(),
                })
                .args(claiming_factory::instruction::SetRefundDeadline { deadline })
                .signer(payer.as_ref())
                .send()?;

            println!("Refund deadline set successfully. Result:\n{}", r);
        },
        Command::ViewRefundRequests { distributor } => {
            let client = RpcClient::new_with_commitment(opts.cluster.url(), CommitmentConfig::confirmed());
    
            let discriminator = RefundRequest::discriminator(); 
            let distributor_bytes = distributor.to_bytes();
            let mut data_slice = discriminator.to_vec();
            data_slice.extend_from_slice(&distributor_bytes);

            let filters = vec![
                RpcFilterType::Memcmp(Memcmp {
                    offset: 0,
                    bytes: MemcmpEncodedBytes::Base58(bs58::encode(data_slice).into_string()),
                    encoding: None,
                }),
            ];

            let accounts = client.get_program_accounts_with_config(
                &opts.program_id,
                RpcProgramAccountsConfig {
                    filters: Some(filters),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )?;

            for (pubkey, account) in accounts {
                let refund_request: RefundRequest = try_from_slice_unchecked(&account.data)?;
                if refund_request.active {
                    println!("Active Refund Request: User {}, Pubkey: {}", refund_request.user, pubkey);
                }
            }
    },
    }

    Ok(())
}
