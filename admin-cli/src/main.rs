use std::rc::Rc;

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig, pubkey::Pubkey, signature::read_keypair_file,
    },
    Client,
};
use anyhow::{anyhow, Result};

use solana_sdk::signer::Signer;
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

#[derive(Debug, StructOpt)]
enum Command {
    InitConfig {},
    ShowConfig {},
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
                    system_program: anchor_client::solana_sdk::system_program::id(),
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
    }

    Ok(())
}
