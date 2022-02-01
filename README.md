# claiming_contracts_solana
Solana Claiming smart contracts

## Deploy

### Rust Installation

https://www.rust-lang.org/tools/install

### Solana Installation

https://docs.solana.com/cli/install-solana-cli-tools

### Anchor Installation

https://project-serum.github.io/anchor/getting-started/installation.html#install-yarn

### Run tests

```bash
anchor build
anchor test
```

### Deploy program

```bash
anchor deploy
anchor deploy --provider.cluster devnet # if you want to deploy on devnet
```

### Initialize config

```bash
# 8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C is the address of program already deployed on devnet
# set some other `program-id` if you've deployed another program
cargo run -p admin-cli -- --cluster devnet --program-id 8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C init-config
# this command allows you to show the default config
cargo run -p admin-cli -- --cluster devnet --program-id 8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C show-config
```

> Now you have working development environment and deployed and initialized program on devnet.
