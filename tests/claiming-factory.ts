import * as anchor from '@project-serum/anchor';
import * as serumCmn from "@project-serum/common";
import { TokenInstructions } from '@project-serum/serum';
import * as spl from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as assert from 'assert';

import * as merkle from './merkle-tree.js';

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

  let
    mint: spl.Token,
    config: anchor.web3.PublicKey,
    merkleData;

  async function generateMerkle() {
    const data = [];
    for (var i = 0; i < 42; i++) {
      const address = await serumCmn.createTokenAccount(provider, mint.publicKey, provider.wallet.publicKey);
      data.push({ address, amount: i });
    }
    return merkle.getMerkleProof(data);
  }

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
        merkleRoot: merkleData.root,
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

  async function findBitmapAddress(distributor: anchor.web3.PublicKey): Promise<[anchor.web3.PublicKey, number]> {
    const distributorAccount = await program.account.merkleDistributor.fetch(distributor);
    const [bitmap, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        distributor.toBytes(),
        distributorAccount.merkleIndex.toArray('be', 8)
      ],
      program.programId
    );

    return [bitmap, bump];
  }

  const FAILED_TO_FIND_ACCOUNT = "Account does not exist";

  async function isClaimed(distributor: anchor.web3.PublicKey, index: anchor.BN) {
    const [bitmap, bump] = await findBitmapAddress(distributor);

    try {
      const bitmapAccount = await program.account.bitMap.fetch(bitmap);
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

  before(async () => {
    mint = await createMint(provider);
    config = await createConfig();
    let tx = await provider.connection.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);
    tx = await provider.connection.requestAirdrop(admin.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(tx);

    merkleData = await generateMerkle();
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
      mint.mintTo(this.vault, provider.wallet.publicKey, [], 1000);

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
      assert.ok(Buffer.from(this.distributorAccount.merkleRoot).equals(merkleData.root));
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
            merkleRoot: merkleData.root,
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
            merkleRoot: merkleData.root,
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

    context("check if claimed", async function () {
      it("should return false if reward has not been claimed", async function () {
        assert.equal(await isClaimed(this.distributor, new anchor.BN(0)), false);
      });

      it("should return true if reward has been claimed", async function () {
        const [bitmap, bump] = await findBitmapAddress(this.distributor);
        await program.rpc.initBitmap(
          bump,
          {
            accounts: {
              payer: provider.wallet.publicKey,
              bitmap,
              distributor: this.distributor,
              systemProgram: anchor.web3.SystemProgram.programId,
            }
          }
        );

        const merkleElement = merkleData.proofs[30];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        assert.ok(await isClaimed(this.distributor, merkleElement.index));
      });
    });

    context("claim", async function () {
      beforeEach(async function () {
        const [bitmap, bump] = await findBitmapAddress(this.distributor);
        await program.rpc.initBitmap(
          bump,
          {
            accounts: {
              payer: provider.wallet.publicKey,
              bitmap,
              distributor: this.distributor,
              systemProgram: anchor.web3.SystemProgram.programId,
            }
          }
        );
        this.bitmap = bitmap;
      })

      it("should claim correctly", async function () {
        const merkleElement = merkleData.proofs[29];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap: this.bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        const targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount));
      });

      it("shouldn't allow to claim token if claiming has been paused", async function () {
        await pause(this.distributor);

        const merkleElement = merkleData.proofs[30];

        await assert.rejects(
          async () => {
            await program.rpc.claim(
              {
                index: merkleElement.index,
                amount: merkleElement.amount,
                merkleProof: merkleElement.proofs
              },
              {
                accounts: {
                  distributor: this.distributor,
                  claimer: provider.wallet.publicKey,
                  bitmap: this.bitmap,
                  vaultAuthority: this.vaultAuthority,
                  vault: this.distributorAccount.vault,
                  targetWallet: merkleElement.address,
                  tokenProgram: TOKEN_PROGRAM_ID,
                }
              }
            );
          },
          (err) => {
            assert.equal(err.code, 308);
            return true;
          }
        )
      });

      it("should fail if merkle proof is not correct", async function () {
        const merkleElement = merkleData.proofs[30];

        await assert.rejects(
          async () => {
            await program.rpc.claim(
              {
                index: merkleElement.index,
                amount: merkleElement.amount,
                // sending proofs from another element
                merkleProof: merkleData.proofs[29].proofs
              },
              {
                accounts: {
                  distributor: this.distributor,
                  claimer: provider.wallet.publicKey,
                  bitmap: this.bitmap,
                  vaultAuthority: this.vaultAuthority,
                  vault: this.distributorAccount.vault,
                  targetWallet: merkleElement.address,
                  tokenProgram: TOKEN_PROGRAM_ID,
                }
              }
            );
          },
          (err) => {
            assert.equal(err.code, 303);
            return true;
          }
        )
      });

      it("shouldn't claim if reward has been claimed", async function () {
        const merkleElement = merkleData.proofs[30];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap: this.bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        await assert.rejects(
          async () => {
            await program.rpc.claim(
              {
                index: merkleElement.index,
                amount: merkleElement.amount,
                merkleProof: merkleElement.proofs
              },
              {
                accounts: {
                  distributor: this.distributor,
                  claimer: provider.wallet.publicKey,
                  bitmap: this.bitmap,
                  vaultAuthority: this.vaultAuthority,
                  vault: this.distributorAccount.vault,
                  targetWallet: merkleElement.address,
                  tokenProgram: TOKEN_PROGRAM_ID,
                }
              }
            );
          },
          (err) => {
            assert.equal(err.code, 304);
            return true;
          }
        );
      });

      it("should claim correctly twice, if root has been changed", async function () {
        let merkleElement = merkleData.proofs[25];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap: this.bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        const firstAmount = merkleElement.amount;
        let targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(firstAmount));

        let data = [];
        for (const elem of merkleData.proofs) {
          data.push({ address: elem.address, amount: elem.amount.toNumber() * 2 });
        }
        let updatedMerkleData = merkle.getMerkleProof(data);

        await program.rpc.updateRoot(
          {
            merkleRoot: updatedMerkleData.root,
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

        const [bitmap, bump] = await findBitmapAddress(this.distributor);
        await program.rpc.initBitmap(
          bump,
          {
            accounts: {
              payer: provider.wallet.publicKey,
              bitmap,
              distributor: this.distributor,
              systemProgram: anchor.web3.SystemProgram.programId,
            }
          }
        );

        merkleElement = updatedMerkleData.proofs[25];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount.add(firstAmount)));
      });

      it("should claim correctly twice, if root has been changed to the same", async function () {
        let merkleElement = merkleData.proofs[24];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap: this.bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        const firstAmount = merkleElement.amount;
        let targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(firstAmount));

        let data = [];
        for (const elem of merkleData.proofs) {
          data.push({ address: elem.address, amount: elem.amount.toNumber() * 2 });
        }
        let updatedMerkleData = merkle.getMerkleProof(data);

        await program.rpc.updateRoot(
          {
            merkleRoot: updatedMerkleData.root,
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

        const [firstBitmap, firstBump] = await findBitmapAddress(this.distributor);
        await program.rpc.initBitmap(
          firstBump,
          {
            accounts: {
              payer: provider.wallet.publicKey,
              bitmap: firstBitmap,
              distributor: this.distributor,
              systemProgram: anchor.web3.SystemProgram.programId,
            }
          }
        );

        merkleElement = updatedMerkleData.proofs[24];

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap: firstBitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        const secondAmount = merkleElement.amount.add(firstAmount);
        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(secondAmount));

        await program.rpc.updateRoot(
          {
            merkleRoot: updatedMerkleData.root,
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

        const [bitmap, bump] = await findBitmapAddress(this.distributor);
        await program.rpc.initBitmap(
          bump,
          {
            accounts: {
              payer: provider.wallet.publicKey,
              bitmap,
              distributor: this.distributor,
              systemProgram: anchor.web3.SystemProgram.programId,
            }
          }
        );

        await program.rpc.claim(
          {
            index: merkleElement.index,
            amount: merkleElement.amount,
            merkleProof: merkleElement.proofs
          },
          {
            accounts: {
              distributor: this.distributor,
              claimer: provider.wallet.publicKey,
              bitmap,
              vaultAuthority: this.vaultAuthority,
              vault: this.distributorAccount.vault,
              targetWallet: merkleElement.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            }
          }
        );

        targetWalletAccount = await serumCmn.getTokenAccount(provider, merkleElement.address);
        assert.ok(targetWalletAccount.amount.eq(merkleElement.amount.add(secondAmount)));
      });
    });
  });
});
