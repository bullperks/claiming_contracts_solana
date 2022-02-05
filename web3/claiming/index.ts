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

const DEVNET_PROGRAM_ADDRESS = "8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C";
// TODO: change address to actual testnet program address
const TESTNET_PROGRAM_ADDRESS = "8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C";
// TODO: change address to actual mainnet program address
const MAINNET_PROGRAM_ADDRESS = "8kYykaz22b9r48BWzrLhNcCvCwrtKF5Ggr1Mv6ik4w8C";

export type CreateDistributorArgs = {
  mint: anchor.web3.PublicKey,
  merkleRoot: number[],
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
        return new anchor.Program(idl, idl.metadata.address, this.provider);
      case DEVNET:
        return new anchor.Program(idl, DEVNET_PROGRAM_ADDRESS, this.provider);
      case TESTNET:
        return new anchor.Program(idl, TESTNET_PROGRAM_ADDRESS, this.provider);
      case MAINNET:
        return new anchor.Program(idl, MAINNET_PROGRAM_ADDRESS, this.provider);
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

  async createDistributor(mint: anchor.web3.PublicKey, merkleRoot: number[]): Promise<anchor.web3.PublicKey> {
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

  async findBitmapAddress(distributor: anchor.web3.PublicKey): Promise<[anchor.web3.PublicKey, number]> {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [bitmap, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        distributorAccount.merkleIndex.toArray('be', 8)
      ],
      this.program.programId
    );

    return [bitmap, bump];
  }

  async initBitmap(distributor: anchor.web3.PublicKey): Promise<anchor.web3.PublicKey> {
    const [bitmap, bump] = await this.findBitmapAddress(distributor);
    await this.program.rpc.initBitmap(
      bump,
      {
        accounts: {
          payer: this.provider.wallet.publicKey,
          bitmap,
          distributor,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      }
    );
    return bitmap;
  }

  async isClaimed(distributor: anchor.web3.PublicKey, index: anchor.BN): Promise<boolean> {
    const [bitmap, _bump] = await this.findBitmapAddress(distributor);

    try {
      const bitmapAccount = await this.program.account.bitMap.fetch(bitmap);
      const wordIndex = index.divn(64).toNumber();
      const bitIndex = index.modrn(64);
      const word = bitmapAccount.data[wordIndex].toNumber();
      const mask = 1 << bitIndex;
      return (word & mask) == mask;
    } catch (err) {
      const errMessage = `${FAILED_TO_FIND_ACCOUNT} ${bitmap.toString()}`;
      if (err.message === errMessage) {
        return false;
      } else {
        throw err;
      }
    }
  }

  async claim(
    distributor: anchor.web3.PublicKey,
    targetWallet: anchor.web3.PublicKey,
    index: anchor.BN,
    amount: anchor.BN,
    merkleProof: number[][]
  ) {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [vaultAuthority, _vaultBump] = await this.findVaultAuthority(distributor);
    const [bitmap, _bitmapBump] = await this.findBitmapAddress(distributor);
    await this.program.rpc.claim(
      {
        index,
        amount,
        merkleProof
      },
      {
        accounts: {
          distributor,
          claimer: this.provider.wallet.publicKey,
          bitmap,
          vaultAuthority,
          vault: distributorAccount.vault,
          targetWallet,
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      }
    );
  }
}
