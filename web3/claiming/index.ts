import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';

import * as idl from './claiming_factory.json';
import * as ty from './claiming_factory';

const TOKEN_PROGRAM_ID = TokenInstructions.TOKEN_PROGRAM_ID;

type Opts = {
  preflightCommitment: anchor.web3.Commitment,
}
const opts: Opts = {
  preflightCommitment: 'processed'
}

type NetworkName = anchor.web3.Cluster | string;

export const LOCALNET = 'http://127.0.0.1:8899';
export const DEVNET = 'devnet';
export const TESTNET = 'testnet';
export const MAINNET = 'mainnet-beta';

const LOCALNET_PROGRAM_ID = "3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs";
const DEVNET_PROGRAM_ID = "3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs";
// TODO: change address to actual testnet program address
const TESTNET_PROGRAM_ID = "3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs";
// TODO: change address to actual mainnet program address
const MAINNET_PROGRAM_ID = "3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs";

export type CreateDistributorArgs = {
  mint: anchor.web3.PublicKey,
  merkleRoot: number[],
};

export type Period = {
  tokenPercentage: anchor.BN,
  startTs: anchor.BN,
  intervalSec: anchor.BN,
  times: anchor.BN,
};

export type UserDetails = {
  lastClaimedAtTs: anchor.BN,
  claimedAmount: anchor.BN,
  bump: number,
};

const FAILED_TO_FIND_ACCOUNT = "Account does not exist";

export class Client {
  provider: anchor.Provider;
  networkName: NetworkName;
  program: anchor.Program<ty.ClaimingFactory>;

  constructor(wallet: anchor.Wallet, networkName: NetworkName) {
    this.networkName = networkName;
    this.provider = this.getProvider(wallet);
    this.program = this.initProgram();
  }

  /* create the provider and return it to the caller */
  getProvider(wallet: anchor.Wallet): anchor.Provider {
    let network: string;
    switch (this.networkName) {
      case DEVNET:
      case TESTNET:
      case MAINNET:
        network = anchor.web3.clusterApiUrl(this.networkName);
      case LOCALNET:
        network = this.networkName;
    }

    const connection = new anchor.web3.Connection(network, opts.preflightCommitment);
    const provider = new anchor.Provider(connection, wallet, opts);
    return provider;
  }

  initProgram(): anchor.Program<ty.ClaimingFactory> {
    switch (this.networkName) {
      case LOCALNET:
        return new anchor.Program(idl, LOCALNET_PROGRAM_ID, this.provider);
      case DEVNET:
        return new anchor.Program(idl, DEVNET_PROGRAM_ID, this.provider);
      case TESTNET:
        return new anchor.Program(idl, TESTNET_PROGRAM_ID, this.provider);
      case MAINNET:
        return new anchor.Program(idl, MAINNET_PROGRAM_ID, this.provider);
    }
  }

  async findConfigAddress(): Promise<[anchor.web3.PublicKey, number]> {
    const [config, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        new TextEncoder().encode("config")
      ],
      this.program.programId,
    );
    return [config, bump];
  }

  async createConfig() {
    const [config, bump] = await this.findConfigAddress();

    await this.program.rpc.initializeConfig(
      bump,
      {
        accounts: {
          config,
          owner: this.provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      }
    );

    return config;
  }

  async findVaultAuthority(distributor: anchor.web3.PublicKey): Promise<[anchor.web3.PublicKey, number]> {
    const [vaultAuthority, vaultBump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes()
      ],
      this.program.programId,
    );
    return [vaultAuthority, vaultBump];
  }

  async createDistributor(mint: anchor.web3.PublicKey, merkleRoot: number[], schedule: Period[]): Promise<anchor.web3.PublicKey> {
    const distributor = anchor.web3.Keypair.generate();
    const [vaultAuthority, vaultBump] = await this.findVaultAuthority(distributor.publicKey);
    const [config, _bump] = await this.findConfigAddress();

    const vault = anchor.web3.Keypair.generate();
    const createTokenAccountInstrs = await serumCmn.createTokenAccountInstrs(
      this.program.provider,
      vault.publicKey,
      mint,
      vaultAuthority
    );

    await this.program.rpc.initialize(
      {
        vaultBump,
        merkleRoot,
        schedule,
      },
      {
        accounts: {
          distributor: distributor.publicKey,
          adminOrOwner: this.provider.wallet.publicKey,
          vaultAuthority,
          vault: vault.publicKey,
          config,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        instructions: createTokenAccountInstrs,
        signers: [vault, distributor]
      }
    );

    return distributor.publicKey;
  }

  async addAdmin(admin: anchor.web3.PublicKey) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.addAdmin(
      {
        accounts: {
          config,
          owner: this.provider.wallet.publicKey,
          admin,
        }
      }
    );
  }

  async removeAdmin(admin: anchor.web3.PublicKey) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.removeAdmin(
      {
        accounts: {
          config,
          owner: this.provider.wallet.publicKey,
          admin,
        },
      },
    );
  }

  async pause(distributor: anchor.web3.PublicKey) {
    await this.setPaused(distributor, true);
  }

  async unpause(distributor: anchor.web3.PublicKey) {
    await this.setPaused(distributor, false);
  }

  async setPaused(distributor: anchor.web3.PublicKey, paused: boolean) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.setPaused(
      paused,
      {
        accounts: {
          distributor,
          config,
          adminOrOwner: this.provider.wallet.publicKey
        }
      }
    );
  }

  async withdrawTokens(amount: anchor.BN, distributor: anchor.web3.PublicKey, targetWallet: anchor.web3.PublicKey) {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [config, _bump] = await this.findConfigAddress();
    const [vaultAuthority, _vaultBump] = await this.findVaultAuthority(distributor);
    await this.program.rpc.withdrawTokens(
      amount,
      {
        accounts: {
          distributor,
          config,
          owner: this.provider.wallet.publicKey,
          vaultAuthority,
          vault: distributorAccount.vault,
          targetWallet,
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      }
    );
  }

  async updateRoot(distributor: anchor.web3.PublicKey, merkleRoot: number[], unpause?: boolean) {
    const [config, _bump] = await this.findConfigAddress();
    unpause = (unpause === undefined) ? false : unpause;
    await this.program.rpc.updateRoot(
      {
        merkleRoot,
        unpause,
      },
      {
        accounts: {
          distributor,
          config,
          adminOrOwner: this.provider.wallet.publicKey,
        }
      }
    );
  }

  async findUserDetailsAddress(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<[anchor.web3.PublicKey, number]> {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [userDetails, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        distributorAccount.merkleIndex.toArray('be', 8),
        user.toBytes(),
      ],
      this.program.programId
    );

    return [userDetails, bump];
  }

  async initUserDetails(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> {
    const [userDetails, bump] = await this.findUserDetailsAddress(distributor, user);
    const userDetailsAccount = await this.getUserDetails(distributor, user);

    if (userDetailsAccount === null) {
      await this.program.rpc.initUserDetails(
        bump,
        {
          accounts: {
            payer: this.provider.wallet.publicKey,
            user,
            userDetails,
            distributor,
            systemProgram: anchor.web3.SystemProgram.programId,
          }
        }
      );
    }

    return userDetails;
  }

  async getUserDetails(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<UserDetails | null> {
    const [userDetails, _bump] = await this.findUserDetailsAddress(distributor, user);

    try {
      const userDetailsAccount = await this.program.account.userDetails.fetch(userDetails);
      return userDetailsAccount;
    } catch (err) {
      const errMessage = `${FAILED_TO_FIND_ACCOUNT} ${userDetails.toString()}`;
      if (err.message === errMessage) {
        return null;
      } else {
        throw err;
      }
    }
  }

  async claim(
    distributor: anchor.web3.PublicKey,
    targetWallet: anchor.web3.PublicKey,
    amount: anchor.BN,
    merkleProof: number[][]
  ) {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [vaultAuthority, _vaultBump] = await this.findVaultAuthority(distributor);
    const [userDetails, _userDetailsBump] = await this.findUserDetailsAddress(
      distributor,
      this.provider.wallet.publicKey
    );
    await this.program.rpc.claim(
      {
        amount,
        merkleProof
      },
      {
        accounts: {
          distributor,
          user: this.provider.wallet.publicKey,
          userDetails,
          vaultAuthority,
          vault: distributorAccount.vault,
          targetWallet,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }
}
