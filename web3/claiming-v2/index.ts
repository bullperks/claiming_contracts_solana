import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';
import { Decimal } from 'decimal.js';
import * as spl from '@solana/spl-token';

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

const LOCALNET_PROGRAM_ID = "6cJU4mUJe1fKXzvvbZjz72M3d5aQXMmRV2jeQerkFw5b";
const DEVNET_PROGRAM_ID = "6cJU4mUJe1fKXzvvbZjz72M3d5aQXMmRV2jeQerkFw5b";
// TODO: change address to actual testnet program address
const TESTNET_PROGRAM_ID = "3yELWiEQynmnXAavxAuQC9RDA4VoVkJeZSvX5a6P4Vvs";

const MAINNET_PROGRAM_ID = "H6FcsVrrgPPnTP9XicYMvLPVux9HsGSctTAwvaeYfykD";

export type CreateDistributorArgs = {
  mint: anchor.web3.PublicKey,
  merkleRoot: number[],
};

export type Period = {
  tokenPercentage: anchor.BN,
  startTs: anchor.BN,
  intervalSec: anchor.BN,
  times: anchor.BN,
  airdropped: boolean,
};

export type UserDetails = {
  lastClaimedAtTs: anchor.BN,
  claimedAmount: anchor.BN,
  bump: number,
};

const FAILED_TO_FIND_ACCOUNT = "Account does not exist";
const INVALID_ACCOUNT_OWNER = 'Invalid account owner';

export class Client {
  provider: anchor.Provider;
  networkName: NetworkName;
  program: anchor.Program<ty.ClaimingFactory>;

  constructor(wallet: anchor.Wallet, networkName: NetworkName) {
    this.networkName = networkName;
    this.provider = this.getProvider(wallet);
    this.program = this.initProgram();
  }

  /**
   * Creates the provider and returns it to the caller
   * @param {anchor.Wallet} wallet - the solana wallet
   * @returns {anchor.Provider} Returns the provider
   */
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

  /**
   * Initializes the program using program's idl for every network
   * @returns {anchor.Program} Returns the initialized program
   */
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

  async fetchTokenAccount(account: anchor.web3.PublicKey): Promise<spl.AccountInfo> {
    const info = await this.provider.connection.getAccountInfo(account);
    if (info === null) {
      throw new Error(FAILED_TO_FIND_ACCOUNT);
    }
    if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(INVALID_ACCOUNT_OWNER);
    }
    if (info.data.length != spl.AccountLayout.span) {
      throw new Error(`Invalid account size`);
    }

    const accountInfo = spl.AccountLayout.decode(info.data);
    accountInfo.mint = new anchor.web3.PublicKey(accountInfo.mint);

    return accountInfo;
  }

  async associatedAddress({
    mint,
    owner,
  }: {
    mint: anchor.web3.PublicKey;
    owner: anchor.web3.PublicKey;
  }): Promise<anchor.web3.PublicKey> {
    return (
      await anchor.web3.PublicKey.findProgramAddress(
        [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      )
    )[0];
  }

  async createAssociated(mint: anchor.web3.PublicKey):
    Promise<[anchor.web3.PublicKey, anchor.web3.TransactionInstruction[]]> {
    const associatedWallet = await this.associatedAddress({
      mint,
      owner: this.provider.wallet.publicKey
    });

    const instructions = [];

    try {
      const targetWalletInfo = await this.fetchTokenAccount(associatedWallet);
      console.log("found associated wallet", targetWalletInfo);
    } catch (err) {
      // INVALID_ACCOUNT_OWNER can be possible if the associatedAddress has
      // already been received some lamports (= became system accounts).
      // Assuming program derived addressing is safe, this is the only case
      // for the INVALID_ACCOUNT_OWNER in this code-path
      if (
        err.message === FAILED_TO_FIND_ACCOUNT ||
        err.message === INVALID_ACCOUNT_OWNER
      ) {
        instructions.push(
          spl.Token.createAssociatedTokenAccountInstruction(
            spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            associatedWallet,
            this.provider.wallet.publicKey,
            this.provider.wallet.publicKey,
          )
        );
      } else {
        throw err;
      }
    }

    return [associatedWallet, instructions];
  }

  /**
   * Find a valid program address of config account
   * @returns {Promise<[anchor.web3.PublicKey, number]>} Returns the public key of config and the bump number
   */
  async findConfigAddress(): Promise<[anchor.web3.PublicKey, number]> {
    const [config, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        new TextEncoder().encode("config")
      ],
      this.program.programId,
    );
    return [config, bump];
  }

  /**
   * Initializes config
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of config
   */
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

  /**
   * Find a program address of vault authority
   * @param {anchor.web3.PublicKey} distributor - public key of distributor
   * @returns {Promise<[anchor.web3.PublicKey, number]>} Returns the public key of vault authority and the bump number
   */
  async findVaultAuthority(distributor: anchor.web3.PublicKey): Promise<[anchor.web3.PublicKey, number]> {
    const [vaultAuthority, vaultBump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes()
      ],
      this.program.programId,
    );
    return [vaultAuthority, vaultBump];
  }

  /**
   * Initializes distributor
   * @param {anchor.web3.PublicKey} mint - public key of mint to distibute
   * @param {number[]} merkleRoot
   * @param {Period[]} schedule - token distribution data (amount, time)
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of newly created distributor
   */
  async createDistributor(
    mint: anchor.web3.PublicKey,
    merkleRoot: number[],
    schedule: Period[],
    refundDeadlineTs?: anchor.BN
  ): Promise<anchor.web3.PublicKey> {
    // no more than 18 periods in initialize ix
    if (schedule.length >= 18) {
      const distributor = await this.createDistributorLarge(mint, merkleRoot, schedule.length);
      const changes = schedule.map(p => ({ push: { period: p } }));
      let start = 0;
      while (start < schedule.length) {
        // no more than 27 periods in update_schedule2 ix
        const changesSlice = changes.slice(start, start + 27);
        await this.updateScheduleUnchecked(distributor, changesSlice);
        start += 27;
      }
      return distributor;
    }

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
        refundDeadlineTs: !refundDeadlineTs ? null : refundDeadlineTs,
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

  /**
   * Initializes distributor with schedule larger than 18 periods
   * @param {anchor.web3.PublicKey} mint - public key of mint to distibute
   * @param {number[]} merkleRoot
   * @param {number} periodsCount
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of newly created distributor
   */
  async createDistributorLarge(
    mint: anchor.web3.PublicKey,
    merkleRoot: number[],
    periodsCount: number,
    refundDeadlineTs?: anchor.BN
  ): Promise<anchor.web3.PublicKey> {
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

    await this.program.rpc.initialize2(
      {
        vaultBump,
        merkleRoot,
        periodsCount: new anchor.BN(periodsCount),
        refundDeadlineTs: !refundDeadlineTs ? null : refundDeadlineTs,
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

  /**
   * Adds admin
   * @param {anchor.web3.PublicKey} admin - public key of new admin
   */
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

  /**
   * Removes admin
   * @param {anchor.web3.PublicKey} admin - public key of removing admin
   */
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

  /**
   * Pause distributor
   * @param {anchor.web3.PublicKey} distributor - public key of pausing distributor
   */
  async pause(distributor: anchor.web3.PublicKey) {
    await this.setPaused(distributor, true);
  }

  /**
   * Unpause distributor
   * @param {anchor.web3.PublicKey} distributor - public key of unpausing distributor
   */
  async unpause(distributor: anchor.web3.PublicKey) {
    await this.setPaused(distributor, false);
  }

  /**
   * Pause or unpause distributor (only for admin role)
   * @param {anchor.web3.PublicKey} distributor - public key of pausing/unpausing distributor
   * @param {boolean} paused - new status for pausing
   */
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

  /**
   * Stop distributor (only for admins)
   * @param {anchor.web3.PublicKey} distributor -- public key of distributor you want to stop
   */
  async stopVesting(distributor: anchor.web3.PublicKey) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.stopVesting(
      {
        accounts: {
          config,
          distributor,
          adminOrOwner: this.provider.wallet.publicKey,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  /**
   * Stop distributor and abort current period (only for admins)
   * @param {anchor.web3.PublicKey} distributor -- public key of distributor you want to stop
   */
  async stopVesting2(distributor: anchor.web3.PublicKey) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.stopVesting2(
      {
        accounts: {
          config,
          distributor,
          adminOrOwner: this.provider.wallet.publicKey,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  /**
   * Withdraws tokens after claim period on target wallet
   * @param {anchor.BN} amount - amount to withdraw
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {anchor.web3.PublicKey} targetWallet - public key of wallet, on which tokens withdraw
   */
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

  /**
   * Updates merkle root
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {number[]} merkleRoot - new merkle root to set
   * @param {boolean} unpause (optional) - pause/unpause status
   */
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
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  /**
   * Updates shedule
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {any[]} changes - new shedule data
   */
  async updateSchedule(distributor: anchor.web3.PublicKey, changes: any[]) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.updateSchedule(
      {
        changes
      },
      {
        accounts: {
          distributor,
          config,
          adminOrOwner: this.provider.wallet.publicKey,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  /**
   * Updates shedule (should be used for schedules larger than 18 periods)
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {any[]} changes - new shedule data
   */
  async updateScheduleUnchecked(distributor: anchor.web3.PublicKey, changes: any[]) {
    const [config, _bump] = await this.findConfigAddress();
    await this.program.rpc.updateSchedule2(
      {
        changes
      },
      {
        accounts: {
          distributor,
          config,
          adminOrOwner: this.provider.wallet.publicKey,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  /**
   * Finds public key of data about user
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<[anchor.web3.PublicKey, number]>} Returns the public key of user details account and the bump
   */
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

  /**
   * Finds public key of refund request
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<[anchor.web3.PublicKey, number]>} Returns the public key of user details account and the bump
   */
  async findRefundRequestAddress(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<[anchor.web3.PublicKey, number]> {
    const [refundRequest, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        user.toBytes(),
        new TextEncoder().encode("refund-request"),
      ],
      this.program.programId
    );

    return [refundRequest, bump];
  }

  async initUserDetailsInstruction(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<anchor.web3.TransactionInstruction> {
    const [userDetails, bump] = await this.findUserDetailsAddress(distributor, user);

    const ix = this.program.instruction.initUserDetails(
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

    return ix;
  }

  /**
   * Initializes user details
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of user details account
   */
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

  /**
   * Initializes refund request
   * @param {anchor.web3.PublicKey} distributor - public key of distributor
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of refund request account
   */
  async initRefundRequest(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> {
    const [refundRequest, _1] = await this.findRefundRequestAddress(distributor, user);
    const [userDetails, _2] = await this.findUserDetailsAddress(distributor, user);

    await this.program.rpc.initRefundRequest(
      {
        accounts: {
          distributor,
          user,
          userDetails,
          refundRequest,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      }
    );

    return refundRequest;
  }

  /**
   * Cancels refund request
   * @param {anchor.web3.PublicKey} distributor - public key of distributor
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<anchor.web3.PublicKey>} Returns the public key of refund request account
   */
  async cancelRefundRequest(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> {
    const [refundRequest, _1] = await this.findRefundRequestAddress(distributor, user);

    await this.program.rpc.cancelRefundRequest(
      {
        accounts: {
          distributor,
          user,
          refundRequest,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      }
    );

    return refundRequest;
  }

  /**
   * Gets user details data
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes were claimed
   * @param {anchor.web3.PublicKey} user - public key of user, which data is finding
   * @returns {Promise<UserDetails | null>} Returns data about user claims (amount, time) or null if err
   */
  async getUserDetails(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey
  ): Promise<UserDetails | null> {
    const [userDetails, _bump] = await this.findUserDetailsAddress(distributor, user);
    return await this.program.account.userDetails.fetchNullable(userDetails);
  }

  async getAmountAvailableToClaim(
    distributor: anchor.web3.PublicKey,
    user: anchor.web3.PublicKey,
    totalAmount: number
  ) {
    let lastClaimedAtTs;

    try {
      lastClaimedAtTs = (await this.getUserDetails(distributor, user)).lastClaimedAtTs.toNumber();
    } catch {
      lastClaimedAtTs = 0;
    };

    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);

    const now = Math.trunc(Date.now() / 1000);
    let totalPercentageToClaim = new Decimal(0);

    for (const period of distributorAccount.vesting.schedule) {
      let periodStartTs = period.startTs.toNumber();
      let periodTimes = period.times.toNumber();

      if (now < periodStartTs) {
        break;
      }

      if (period.airdropped) {
        continue;
      }

      let periodEndTs = periodStartTs + periodTimes * period.intervalSec.toNumber();
      if (periodEndTs <= lastClaimedAtTs) {
        continue;
      }

      let lastClaimedAtTsAlignedByInterval = lastClaimedAtTs - (lastClaimedAtTs % period.intervalSec.toNumber());
      let secondsPassed =
        now - (periodStartTs >= lastClaimedAtTsAlignedByInterval ?
          periodStartTs : lastClaimedAtTsAlignedByInterval
        );
      let intervalsPassed = secondsPassed / period.intervalSec;
      intervalsPassed = intervalsPassed < periodTimes ? intervalsPassed : periodTimes;

      let percentageForIntervals = new Decimal(period.tokenPercentage.divn(100).toString())
        .dividedBy(periodTimes)
        .mul(intervalsPassed);

      totalPercentageToClaim = totalPercentageToClaim.add(percentageForIntervals);
    }

    return totalPercentageToClaim.mul(totalAmount).div(100).toNumber();
  }

  async getAmountAvailableToWithdraw(
    distributor: anchor.web3.PublicKey,
    totalAmount: number
  ) {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const now = Math.trunc(Date.now() / 1000);

    let totalPercentageToWithdraw = new Decimal(0);

    for (const period of distributorAccount.vesting.schedule) {
      let periodStartTs = period.startTs.toNumber();

      if (now >= periodStartTs) {
        continue;
      }

      totalPercentageToWithdraw = totalPercentageToWithdraw.add(new Decimal(period.tokenPercentage.divn(100).toString()));
    }

    return totalPercentageToWithdraw.mul(totalAmount).div(100).toNumber();
  }

  async hasStopped(distributor: anchor.web3.PublicKey) {
    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const now = Math.trunc(Date.now() / 1000);

    for (const period of distributorAccount.vesting.schedule) {
      let periodStartTs = period.startTs.toNumber();

      if (now >= periodStartTs) {
        continue;
      }

      if (!period.airdropped) {
        return false;
      }
    }

    return true;
  }

  /**
   * Claims amount of tokens
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes would be claimed
   * @param {anchor.web3.PublicKey} newWallet -- new wallet which will be used for claiming (but we need to know original anyway)
   * @param {anchor.web3.PublicKey} originalWallet -- original wallet (by default equals to current wallet)
   */
  async changeWallet(
    distributor: anchor.web3.PublicKey,
    newWallet: anchor.web3.PublicKey,
    originalWallet: anchor.web3.PublicKey = this.provider.wallet.publicKey
  ) {
    const [actualWallet, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        originalWallet.toBytes(),
        new TextEncoder().encode("actual-wallet"),
      ],
      this.program.programId
    );

    const actualWalletAccount = await this.program.account.actualWallet.fetchNullable(actualWallet);
    const instructions = [];

    if (actualWalletAccount === null) {
      const ix = this.program.instruction.initActualWallet(
        bump,
        {
          accounts: {
            distributor,
            user: this.provider.wallet.publicKey,
            actualWallet,
            systemProgram: anchor.web3.SystemProgram.programId,
          }
        }
      );
      instructions.push(ix);
    }

    const [userDetails, _] = await this.findUserDetailsAddress(distributor, this.provider.wallet.publicKey);
    const [newUserDetails, userDetailsBump] = await this.findUserDetailsAddress(distributor, newWallet);

    await this.program.rpc.changeWallet(
      userDetailsBump,
      {
        accounts: {
          distributor,
          user: this.provider.wallet.publicKey,
          userDetails,
          newWallet,
          newUserDetails,
          actualWallet,
          originalWallet,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        instructions,
      }
    );
  }

  /**
   * Claims amount of tokens
   * @param {anchor.web3.PublicKey} distributor - public key of distributor, on which tokes would be claimed
   * @param {anchor.web3.PublicKey} targetWallet - wallet of user, which will withdraw tokens
   * @param {anchor.BN} amount - amount of tokens to claim
   * @param {anchor.web3.PublicKey} originalWallet -- original wallet used for claiming (known on backend even you've changed the wallet)
   * @param {number[][]} merkleProof - merkle proof
   */
  async claim(
    distributor: anchor.web3.PublicKey,
    amount: anchor.BN,
    originalWallet: anchor.web3.PublicKey,
    merkleProof: number[][],
    targetWallet: anchor.web3.PublicKey = undefined,
  ) {
    const instructions = [];

    const [userDetails, _bump] = await this.findUserDetailsAddress(distributor, this.provider.wallet.publicKey);
    const userDetailsAccount = await this.getUserDetails(distributor, this.provider.wallet.publicKey);
    if (userDetailsAccount === null) {
      instructions.push(
        await this.initUserDetailsInstruction(
          distributor,
          this.provider.wallet.publicKey
        ));
    }

    const distributorAccount = await this.program.account.merkleDistributor.fetch(distributor);
    const [vaultAuthority, _vaultBump] = await this.findVaultAuthority(distributor);

    if (targetWallet === undefined) {
      const vaultAccount = await this.fetchTokenAccount(distributorAccount.vault);
      const [associatedWallet, ixs] = await this.createAssociated(vaultAccount.mint);
      targetWallet = associatedWallet;
      if (ixs.length > 0) {
        instructions.push(...ixs);
      }
    }

    const [actualWallet, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        originalWallet.toBytes(),
        new TextEncoder().encode("actual-wallet"),
      ],
      this.program.programId
    );

    const actualWalletAccount = await this.program.account.actualWallet.fetchNullable(actualWallet);

    if (actualWalletAccount === null) {
      const ix = this.program.instruction.initActualWallet(
        bump,
        {
          accounts: {
            distributor,
            user: this.provider.wallet.publicKey,
            actualWallet,
            systemProgram: anchor.web3.SystemProgram.programId,
          }
        }
      );
      instructions.push(ix);
    }

    const [refundRequest, _] = await this.findRefundRequestAddress(distributor, originalWallet);

    await this.program.rpc.claim(
      {
        amount,
        merkleProof,
        originalWallet,
      },
      {
        accounts: {
          distributor,
          user: this.provider.wallet.publicKey,
          userDetails,
          actualWallet,
          refundRequest,
          vaultAuthority,
          vault: distributorAccount.vault,
          targetWallet,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        },
        instructions,
      },
    );
  }
}
