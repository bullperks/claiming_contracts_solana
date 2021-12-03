import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';
import * as spl from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as assert from 'assert';

import * as ty from '../target/types/claiming_factory';
import * as idl from '../target/idl/claiming_factory.json';

const TOKEN_PROGRAM_ID = TokenInstructions.TOKEN_PROGRAM_ID;

async function createMint(provider: anchor.Provider, authority?: anchor.web3.PublicKey) {
  if (authority === undefined) {
    authority = provider.wallet.publicKey;
  }
  const mint = await spl.Token.createMint(
    provider.connection,
    provider.wallet.payer,
    authority,
    null,
    6,
    TOKEN_PROGRAM_ID,
  );
  return mint;
}

describe('claiming-factory', () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const user = new anchor.web3.Account();
  const userWallet = new serumCmn.NodeWallet(user);
  const userProvider = new anchor.Provider(
    provider.connection,
    userWallet,
    anchor.Provider.defaultOptions()
  );

  const admin = new anchor.web3.Account();
  const adminWallet = new serumCmn.NodeWallet(admin);
  const adminProvider = new anchor.Provider(
    provider.connection,
    adminWallet,
    anchor.Provider.defaultOptions()
  );

  const program = anchor.workspace.ClaimingFactory as anchor.Program<ty.ClaimingFactory>;
  const userProgram = new anchor.Program(idl, program.programId, userProvider);
  const adminProgram = new anchor.Program(idl, program.programId, adminProvider);

  const MERKLE_ROOT_TEST = Buffer.from("5b86ffd388e4e795ed1640ae6a0f710b1f26aba02be4cc54e8e23b4f030daaeb", 'hex');
  const MERKLE_PROOFS = [
    "0x26db859e72c5023fcaf9d5449801483163d7e406d27e7cc92413b95b2219e19a",
    "0x45c6e560172684cbc7df33b1ba0079afc39e4587e39240d08e0996c692d767af",
    "0xbac7804eeb44c280c0e3c5fb9cba2a75705c1b48f25ebefcfb90fa1c26b3c705",
    "0x0475c03faf773c403f1b6c6e672ec26c53a244a5b4c3d0fa2d67242266527e85",
    "0x158b73613a6895d5a8260fa597387cbfbef0e0738c4e24e85d1cf977d7e4442a",
    "0x250fe6c7b5a0d6a9d48ab387048758cbd2c00ceb4d765b1cc3edc80d9bb0e524"
  ];

  let
    mint: spl.Token,
    config: anchor.web3.PublicKey;

  async function createConfig() {
    const [config, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        new TextEncoder().encode("config")
      ],
      program.programId,
    );

    await program.rpc.initializeConfig(
      bump,
      {
        accounts: {
          config,
          owner: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      }
    );

    return config;
  }

  async function createDistributor(program) {
    const distributor = anchor.web3.Keypair.generate();

    const [vaultAuthority, vaultBump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.publicKey.toBytes()
      ],
      program.programId,
    );

    const vault = anchor.web3.Keypair.generate();
    const createTokenAccountInstrs = await serumCmn.createTokenAccountInstrs(
      program.provider,
      vault.publicKey,
      mint.publicKey,
      vaultAuthority
    );

    await program.rpc.initialize(
      {
        vaultBump,
        merkleRoot: MERKLE_ROOT_TEST,
      },
      {
        accounts: {
          distributor: distributor.publicKey,
          adminOrOwner: program.provider.wallet.publicKey,
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

  async function addAdmin() {
    await program.rpc.addAdmin(
      admin.publicKey,
      {
        accounts: {
          config,
          owner: provider.wallet.publicKey,
        }
      }
    );
  }

  async function pause(distributor) {
    await program.rpc.setPaused(
      true,
      {
        accounts: {
          distributor,
          config,
          adminOrOwner: provider.wallet.publicKey
        }
      }
    );
  }

  before(async () => {
    mint = await createMint(provider);
    config = await createConfig();
    let tx = await provider.connection.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);
    tx = await provider.connection.requestAirdrop(admin.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);
  });

  context("admin add/remove", async function () {
    beforeEach(async function () {
      anchor.setProvider(provider);
    });

    it('should not allow to add admin by user', async function () {
      await assert.rejects(
        async () => {
          await userProgram.rpc.addAdmin(
            admin.publicKey,
            {
              accounts: {
                config,
                owner: user.publicKey,
              }
            },
          );
        },
        (err) => {
          assert.equal(err.code, 305);
          return true;
        }
      );
    });

    it('should add admin by owner', async function () {
      await addAdmin();

      const configAccount = await program.account.config.fetch(config);
      const [newAdmin] = configAccount.admins.filter((a) => a && a.equals(admin.publicKey));
      assert.ok(newAdmin);
    });

    it('should not allow to remove admin by user', async function () {
      await assert.rejects(
        async () => {
          await userProgram.rpc.removeAdmin(
            admin.publicKey,
            {
              accounts: {
                config,
                owner: user.publicKey,
              },
            },
          )
        },
        (err) => {
          assert.equal(err.code, 305);
          return true;
        }
      );
    });

    it('should remove admin by owner', async function () {
      await program.rpc.removeAdmin(
        admin.publicKey,
        {
          accounts: {
            config,
            owner: provider.wallet.publicKey,
          },
        },
      );

      const configAccount = await program.account.config.fetch(config);
      const maybeNewAdmin = configAccount.admins.filter((a) => a && a.equals(admin.publicKey));
      assert.deepStrictEqual(maybeNewAdmin, []);
    });
  });

  context('create disributor', async function () {
    it("shouldn't allow deploy new distributor if not owner or admin", async function () {
      await assert.rejects(
        async () => {
          await createDistributor(userProgram);
        },
        (err) => {
          assert.equal(err.code, 306);
          return true;
        }
      );
    });

    it("should allow to initialize new distributor by admin", async function () {
      await addAdmin();

      const distributor = await createDistributor(adminProgram);
      await program.account.merkleDistributor.fetch(distributor);
    });

    it("should allow to initialize new distributor by owner", async function () {
      const distributor = await createDistributor(program);
      await program.account.merkleDistributor.fetch(distributor);
    });
  });

  context('distributor', async function () {
    beforeEach(async function () {
      this.distributor = await createDistributor(program);
      this.distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);

      this.vault = this.distributorAccount.vault;
      mint.mintTo(this.vault, provider.wallet.publicKey, [], 100);

      this.vaultAuthority = await anchor.web3.PublicKey.createProgramAddress(
        [
          this.distributor.toBytes(),
          [this.distributorAccount.vaultBump]
        ],
        program.programId
      );
    });

    it('should have correct initial values', async function () {
      assert.ok(this.distributorAccount.merkleIndex.eqn(0));
      assert.ok(Buffer.from(this.distributorAccount.merkleRoot).equals(MERKLE_ROOT_TEST));
    });

    context("withdraw tokens", async function () {
      it("shouldn't allow withdraw by user", async function () {
        const targetWallet = await serumCmn.createTokenAccount(userProvider, mint.publicKey, user.publicKey);

        await assert.rejects(
          async () => {
            await userProgram.rpc.withdrawTokens(
              new anchor.BN(100),
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  owner: provider.wallet.publicKey,
                  vaultAuthority: this.vaultAuthority,
                  vault: this.vault,
                  targetWallet,
                  tokenProgram: TOKEN_PROGRAM_ID,
                }
              }
            );
          },
          (err) => {
            assert.ok(/Signature verification failed/.test(err));
            return true;
          }
        );
      });

      it("shouldn't allow withdraw by admin", async function () {
        const targetWallet = await serumCmn.createTokenAccount(adminProvider, mint.publicKey, admin.publicKey);

        await assert.rejects(
          async () => {
            await adminProgram.rpc.withdrawTokens(
              new anchor.BN(100),
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  owner: admin.publicKey,
                  vaultAuthority: this.vaultAuthority,
                  vault: this.vault,
                  targetWallet,
                  tokenProgram: TOKEN_PROGRAM_ID,
                }
              }
            );
          },
          (err) => {
            assert.equal(err.code, 305);
            return true;
          }
        );
      });

      it("should withdraw token by owner", async function () {
        const targetWallet = await serumCmn.createTokenAccount(provider, mint.publicKey, user.publicKey);
        await program.rpc.withdrawTokens(
          new anchor.BN(100),
          {
            accounts: {
              distributor: this.distributor,
              config,
              owner: provider.wallet.publicKey,
              vaultAuthority: this.vaultAuthority,
              vault: this.vault,
              targetWallet,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        const targetWalletAccount = await serumCmn.getTokenAccount(provider, targetWallet);
        assert.ok(targetWalletAccount.amount.eqn(100));
      });
    });

    context("update root", async function () {
      // changed some byte in MERKLE_ROOT_TEST
      const UPDATED_ROOT = Buffer.from("5b86ffd388e4e795ed1640ae6a0f710b1f26aba02befcc54e8e23b4f030daaeb", 'hex');

      it("shouldn't allow update by user", async function () {
        await assert.rejects(
          async () => {
            await userProgram.rpc.updateRoot(
              {
                merkleRoot: UPDATED_ROOT,
                unpause: false,
              },
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  adminOrOwner: provider.wallet.publicKey,
                }
              }
            );
          },
          (err) => {
            assert.ok(/Signature verification failed/.test(err));
            return true;
          }
        );
      });

      it("should allow update by admin", async function () {
        await addAdmin();

        await adminProgram.rpc.updateRoot(
          {
            merkleRoot: UPDATED_ROOT,
            unpause: false
          },
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: admin.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.ok(Buffer.from(distributorAccount.merkleRoot).equals(UPDATED_ROOT));
      });

      it("should allow update by owner", async function () {
        await program.rpc.updateRoot(
          {
            merkleRoot: UPDATED_ROOT,
            unpause: false,
          },
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: provider.wallet.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.ok(Buffer.from(distributorAccount.merkleRoot).equals(UPDATED_ROOT));
      });
    });

    context("update root and unpause", async function () {
      it("should unpause if it's paused by admin", async function () {
        await pause(this.distributor);
        await addAdmin();

        await adminProgram.rpc.updateRoot(
          {
            merkleRoot: MERKLE_ROOT_TEST,
            unpause: true,
          },
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: admin.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should unpause if it paused by owner", async function () {
        await pause(this.distributor);

        await program.rpc.updateRoot(
          {
            merkleRoot: MERKLE_ROOT_TEST,
            unpause: true,
          },
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: provider.wallet.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });
    });

    context("pause", async function () {
      it("shouldn't allow to pause the program by user", async function () {
        await assert.rejects(
          async () => {
            await userProgram.rpc.setPaused(
              true,
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  adminOrOwner: user.publicKey,
                }
              }
            );
          },
          (err) => {
            assert.ok(err.code, 306);
            return true;
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("shouldn't allow to pause the program if it already paused", async function () {
        await pause(this.distributor);
        let balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);

        await assert.rejects(
          async () => {
            await program.rpc.setPaused(
              true,
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  adminOrOwner: provider.wallet.publicKey,
                }
              }
            )
          },
          (err) => {
            assert.equal(err.code, 307);
            return true;
          }
        );

        let balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
        assert.equal(balanceBefore, balanceAfter);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });

      it("should allow to pause the program by admin", async function () {
        await addAdmin();

        await adminProgram.rpc.setPaused(
          true,
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: admin.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });

      it("should allow to pause the program by owner", async function () {
        await program.rpc.setPaused(
          true,
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: provider.wallet.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, true);
      });
    });

    context("unpause", async function () {
      it("shouldn't allow to unpause the program by user", async function () {
        await assert.rejects(
          async () => {
            await userProgram.rpc.setPaused(
              false,
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  adminOrOwner: user.publicKey,
                }
              }
            );
          },
          (err) => {
            assert.ok(err.code, 306);
            return true;
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("shouldn't allow to unpause the program if it already unpaused", async function () {
        let balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);

        await assert.rejects(
          async () => {
            await program.rpc.setPaused(
              false,
              {
                accounts: {
                  distributor: this.distributor,
                  config,
                  adminOrOwner: provider.wallet.publicKey,
                }
              }
            )
          },
          (err) => {
            assert.equal(err.code, 307);
            return true;
          }
        );

        let balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
        assert.equal(balanceBefore, balanceAfter);

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should allow to unpause the program by admin", async function () {
        await pause(this.distributor);
        await addAdmin();

        await adminProgram.rpc.setPaused(
          false,
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: admin.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });

      it("should allow to unpause the program by owner", async function () {
        await pause(this.distributor);

        await program.rpc.setPaused(
          false,
          {
            accounts: {
              distributor: this.distributor,
              config,
              adminOrOwner: provider.wallet.publicKey,
            }
          }
        );

        const distributorAccount = await program.account.merkleDistributor.fetch(this.distributor);
        assert.equal(distributorAccount.paused, false);
      });
    });

  //   context("function isClaimed()", async function () {

  //     beforeEach(async function () {
  //       await this.token.connect(deployer).transfer(this.distributor.address, INITIAL_BALANCE);
  //     });

  //     it("should return false if reward has not been claimed", async function () {
  //       await expect(await this.distributor.connect(user)["isClaimed(uint256)"]("0")).to.be.equal(false);
  //     });

  //     it("should return true if reward has been claimed", async function () {
  //       await this.distributor.connect(user).claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs);
  //       await expect(await this.distributor.connect(user)["isClaimed(uint256)"]("0")).to.be.equal(true);
  //     });
  //   });

  //   context("function claim()", async function () {

  //     beforeEach(async function () {
  //       await this.token.connect(deployer).transfer(this.distributor.address, INITIAL_BALANCE);
  //     });

  //     it("shouldn't allow to claim token if claiming has been paused", async function () {
  //       await this.distributor.connect(deployer).pause();
  //       await expect(this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs)).to.be.revertedWith("Pausable: paused");
  //     });

  //     it("should revert if merkle proof is not correct", async function () {
  //       await expect(this.distributor.claim("0",
  //         "0x5c064bf2c4c3669068167e0def02d5318810bce0",
  //         "1442525199919868000000",
  //         [
  //           "0x26db859e72c5023fcaf9d5449801483163d7e406d27e7cc92413b95b2219e19a",
  //           "0x45c6e560172684cbc7df33b1ba0079afc39e4587e39240d08e0996c692d767af",
  //           "0xbac7804eeb44c280c0e3c5fb9cba2a75705c1b48f25ebefcfb90fa1c26b3c70d",
  //           "0x0475c03faf773c403f1b6c6e672ec26c53a244a5b4c3d0fa2d67242266527e8c",   // changed bytes
  //           "0x158b73613a6895d5a8260fa597387cbfbef0e0738c4e24e85d1cf977d7e4442b",   // changed bytes
  //           "0x250fe6c7b5a0d6a9d48ab387048758cbd2c00ceb4d765b1cc3edc80d9bb0e525"    // changed bytes
  //         ])).to.be.revertedWith("MerkleDistributor: Invalid proof.");
  //     });

  //     it("shouldn't claim if reward has been claimed", async function () {
  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs);
  //       await expect(this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs)).to.be.revertedWith("MerkleDistributor: Drop already claimed.");
  //     });

  //     it("should claim correctly", async function () {
  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs);
  //       let balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("1442525199919868000000");
  //     });

  //     it("should claim correctly twice, if root has been changed", async function () {
  //       let merkleProofs2 = [
  //         "0x342a73a190324c510c47794be425fc2aa37dfd04a179774bf8485ae2d8255bfa",
  //         "0xa621b01c138e8f7173f469636c0e1651734bb36f8f2e6158a83ff30b2f9c8c1e",
  //         "0xbe5104a9c313ed4221d02c5a9c9271fcc7f9da1fa3f70a0971e70a7f15b40066",
  //         "0x755ab09b9b0eeb5a55e9a812fbab976d813ceb35f2d6a1a1218a7388f20e12a8",
  //         "0x158b73613a6895d5a8260fa597387cbfbef0e0738c4e24e85d1cf977d7e4442a",
  //         "0x250fe6c7b5a0d6a9d48ab387048758cbd2c00ceb4d765b1cc3edc80d9bb0e524"
  //       ]

  //       let merkleRoot2 = "0x38c72b8b4188cf9af01b02936a35384610e500f5f00d72a12071d289824de7f2";

  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs);
  //       let balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("1442525199919868000000");

  //       await this.distributor.updateRoot(merkleRoot2);

  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "2442525199919868000000", merkleProofs2);
  //       balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("3885050399839736000000");
  //     });

  //     it("should claim correctly twice, if root has been changed to the same", async function () {
  //       let merkleProofs2 = [
  //         "0x342a73a190324c510c47794be425fc2aa37dfd04a179774bf8485ae2d8255bfa",
  //         "0xa621b01c138e8f7173f469636c0e1651734bb36f8f2e6158a83ff30b2f9c8c1e",
  //         "0xbe5104a9c313ed4221d02c5a9c9271fcc7f9da1fa3f70a0971e70a7f15b40066",
  //         "0x755ab09b9b0eeb5a55e9a812fbab976d813ceb35f2d6a1a1218a7388f20e12a8",
  //         "0x158b73613a6895d5a8260fa597387cbfbef0e0738c4e24e85d1cf977d7e4442a",
  //         "0x250fe6c7b5a0d6a9d48ab387048758cbd2c00ceb4d765b1cc3edc80d9bb0e524"
  //       ]

  //       let merkleRoot2 = "0x38c72b8b4188cf9af01b02936a35384610e500f5f00d72a12071d289824de7f2";

  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "1442525199919868000000", merkleProofs);
  //       let balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("1442525199919868000000");

  //       await this.distributor.updateRoot(merkleRoot2);

  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "2442525199919868000000", merkleProofs2);
  //       balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("3885050399839736000000");

  //       await this.distributor.updateRoot(merkleRoot2);

  //       await this.distributor.claim("0", "0x5c064bf2c4c3669068167e0def02d5318810bce0", "2442525199919868000000", merkleProofs2);
  //       balance = await this.token.connect(user).balanceOf("0x5c064bf2c4c3669068167e0def02d5318810bce0");
  //       await expect(balance).to.be.equal("6327575599759604000000");
  //     });
  //   });
  // });
});
});
